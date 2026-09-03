/**
 * Submission ingestion: strict input validation and queue acceptance.
 *
 * The body of POST /submissions is untrusted input. Every field is validated
 * against a conservative grammar before a row is inserted; anything that does
 * not match is rejected with a 400 and a machine-readable reason. Validated
 * fields are the only values that ever flow toward git, docker, or any other
 * interpreter — always as argument-array entries, never interpolated into a
 * shell string.
 *
 * A validated submission is still turned away, honestly, when the service is
 * already at capacity: acceptSubmission checks a global (not per-submitter)
 * active-submission ceiling before the row is inserted, so a distributed
 * flood of submitters cannot collectively grow the backlog without bound even
 * if each individually stays under the per-IP rate limit on POST
 * /submissions (see src/index.ts). This is a separate concern from
 * JOB_CONCURRENCY (src/queue.ts), which bounds how many jobs run at once —
 * the ceiling here bounds how many can be queued-or-running at once.
 *
 * Failure modes:
 *  - validateAndNormalize never throws; malformed input is reported as
 *    { ok: false, issues }.
 *  - acceptSubmission throws when the database insert fails; the route maps
 *    that to a 500. It never throws for a full queue — that is reported as
 *    { ok: false, activeCount, limit } so the route can answer 503.
 */

import { StrKey } from '@stellar/stellar-sdk';
import type { Database } from './db.js';
import { normalizeWasmHashHex } from './resolve.js';

/** Untrusted request payload for POST /submissions. */
export interface SubmissionRequest {
  contractId?: string;
  wasmHash?: string;
  sourceRepo?: string;
  sourceRev?: string;
  buildImage?: string;
}

/** Normalized, validated submission ready for insertion. */
export interface NormalizedSubmission {
  contractId: string | null;
  wasmHash: string | null;
  sourceRepo: string;
  sourceRev: string;
  buildImage: string | null;
}

export interface ValidationIssue {
  field: string;
  reason: string;
}

export type ValidationResult =
  { ok: true; value: NormalizedSubmission } | { ok: false; issues: ValidationIssue[] };

/** A 32-byte value written as 64 hex characters. */
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
/** A 32-byte value written as base64: 43 unpadded chars, or 43 chars + one '='. */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}={0,1}$/;
/**
 * Plausible git remote URL: https://, git://, ssh://, or scp-style git@host:path.
 *
 * The URL body is validated against a conservative character whitelist rather
 * than \S+: only alphanumerics plus the punctuation a git remote actually needs
 * (._~:/@%?=#+,-) are accepted, so control characters (U+0000-U+001F) and
 * shell metacharacters (; | & < > $ " ' ` ( ) [ ] { }) are rejected at the
 * boundary and can never be enqueued.
 */
const GIT_URL =
  /^(https?|git|ssh):\/\/[0-9A-Za-z._~:/@%?=#+,-]+$|^git@[0-9A-Za-z._~@-]+:[0-9A-Za-z._~:/@%?=#+,-]+$/;
/** Git revision: a SHA, tag, branch, or ref path. No whitespace or control chars. */
const GIT_REVISION = /^[0-9A-Za-z._/-]{1,128}$/;
/** Container image reference: registry/name[:tag][@digest]. No whitespace. */
const IMAGE_REF = /^[0-9A-Za-z._/:@-]{1,256}$/;

const ALLOWED_FIELDS: readonly string[] = [
  'contractId',
  'wasmHash',
  'sourceRepo',
  'sourceRev',
  'buildImage',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Strictly validate an untrusted POST /submissions body.
 *
 * Returns { ok: true, value } with a normalized submission when every field
 * passes; otherwise { ok: false, issues } listing every failing field (never
 * throwing). Unknown fields are rejected so a typo cannot silently change
 * behavior. wasmHash hex is normalized to lowercase so the same byte value
 * always has one canonical spelling in the queue.
 */
export function validateAndNormalize(raw: unknown): ValidationResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      issues: [{ field: 'body', reason: 'request body must be a JSON object' }],
    };
  }

  const issues: ValidationIssue[] = [];

  const unknownField = Object.keys(raw).find((key) => !ALLOWED_FIELDS.includes(key));
  if (unknownField !== undefined) {
    issues.push({ field: unknownField, reason: 'unknown field' });
  }

  const contractId = raw.contractId;
  const wasmHashRaw = raw.wasmHash;
  const sourceRepo = raw.sourceRepo;
  const sourceRev = raw.sourceRev;
  const buildImage = raw.buildImage;

  const repoOk = isNonEmptyString(sourceRepo) && GIT_URL.test(sourceRepo);
  const revOk = isNonEmptyString(sourceRev) && GIT_REVISION.test(sourceRev);
  const contractOk =
    contractId === undefined ||
    (isNonEmptyString(contractId) && StrKey.isValidContract(contractId));
  // Hex and base64 must be tracked separately: hex is case-insensitive and is
  // normalized to lowercase, while base64 is case-sensitive and must be kept
  // byte-identical (lowercasing it would change the hash).
  const wasmIsHex = isNonEmptyString(wasmHashRaw) && HEX_32_BYTES.test(wasmHashRaw);
  const wasmIsBase64 = isNonEmptyString(wasmHashRaw) && BASE64_32_BYTES.test(wasmHashRaw);
  const wasmOk = wasmHashRaw === undefined || wasmIsHex || wasmIsBase64;
  const hasTarget = contractId !== undefined || wasmHashRaw !== undefined;
  const imageOk =
    buildImage === undefined || (isNonEmptyString(buildImage) && IMAGE_REF.test(buildImage));

  if (!repoOk) {
    issues.push({
      field: 'sourceRepo',
      reason: 'must be a plausible git URL (https://, git://, ssh://, or git@host:path)',
    });
  }
  if (!revOk) {
    issues.push({
      field: 'sourceRev',
      reason: 'must be a git revision (SHA, tag, or branch name), max 128 chars, no whitespace',
    });
  }
  if (!contractOk) {
    issues.push({ field: 'contractId', reason: 'must be a valid C-address (StrKey contract id)' });
  }
  if (!wasmOk) {
    issues.push({
      field: 'wasmHash',
      reason: 'must be a 32-byte value in hex (64 characters) or base64',
    });
  }
  if (!hasTarget) {
    issues.push({ field: 'body', reason: 'at least one of contractId or wasmHash is required' });
  }
  if (!imageOk) {
    issues.push({
      field: 'buildImage',
      reason: 'must be a container image reference (registry/name[:tag][@digest])',
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Every check above passed; the guarded values are known to be strings.
  // Canonicalize to lowercase hex so one byte value has one spelling in the
  // queue and in the results table.
  const normalizedWasmHash =
    wasmHashRaw === undefined ? null : normalizeWasmHashHex(wasmHashRaw as string);

  return {
    ok: true,
    value: {
      contractId: contractId === undefined ? null : (contractId as string),
      wasmHash: normalizedWasmHash,
      sourceRepo: sourceRepo as string,
      sourceRev: sourceRev as string,
      buildImage: buildImage === undefined ? null : (buildImage as string),
    },
  };
}

/** Outcome of acceptSubmission: either a queued submission id, or a clear,
 * honest refusal (never a silent drop) when the service is at capacity. */
export type AcceptOutcome =
  { ok: true; submissionId: string } | { ok: false; activeCount: number; limit: number };

/**
 * Accept a validated submission: insert a 'pending' row and return the
 * submission id, unless the global active-submission ceiling
 * (maxActiveSubmissions) is already met, in which case no row is inserted and
 * the current backlog size is reported instead. The rebuild happens
 * asynchronously via the queue; nothing here touches git or docker.
 */
export async function acceptSubmission(
  db: Database,
  submission: NormalizedSubmission,
  maxActiveSubmissions: number,
): Promise<AcceptOutcome> {
  const inserted = await db.insertSubmissionIfUnderCeiling(
    {
      contractId: submission.contractId,
      wasmHash: submission.wasmHash,
      sourceRepo: submission.sourceRepo,
      sourceRev: submission.sourceRev,
      buildImage: submission.buildImage,
    },
    maxActiveSubmissions,
  );
  if (inserted === null) {
    const activeCount = await db.countActiveSubmissions();
    return { ok: false, activeCount, limit: maxActiveSubmissions };
  }
  return { ok: true, submissionId: inserted.id };
}
