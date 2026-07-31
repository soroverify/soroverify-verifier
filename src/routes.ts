/**
 * HTTP route registration (Fastify).
 *
 * POST /submissions accepts and queues verification requests. The read-only
 * endpoints expose job status and signed verification results, aggregating
 * this instance's results with those of peer verifiers (PEER_VERIFIERS) so a
 * consumer can require agreement across a chosen trusted set. Peer records
 * are only included after their signatures verify against their embedded
 * public keys — nothing here trusts a peer's database.
 *
 * A wasm hash with no result and no submission at all resolves to
 * `unverified`, distinct from a submission that failed to build
 * (`inconclusive`).
 */

import { StrKey } from '@stellar/stellar-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerDependencies } from './index.js';
import { validateAndNormalize, acceptSubmission, type SubmissionRequest } from './ingest.js';
import { normalizeWasmHashHex, RpcError } from './resolve.js';
import { verifyResultRecord, type SignedResultRecord } from './sign.js';
import type { VerificationStatus } from './compare.js';
import type { ResultStatus, VerificationResult } from './db.js';

/** Public shape of a signed result as served by the API. */
export interface PublicResult {
  wasm_hash: string;
  source_repo: string;
  source_rev: string;
  status: VerificationStatus;
  build_meta: Record<string, string> | null;
  verifier_id: string;
  public_key: string;
  timestamp: string;
  signature: string;
  tarball_sha256: string | null;
}

const VALID_STATUSES: readonly string[] = ['verified', 'mismatch', 'inconclusive'];

/**
 * CORS policy for the public read-only endpoints (CORS_ALLOWED_ORIGINS).
 * These routes are unauthenticated and never touch credentials, so a plain
 * wildcard is safe and is the default; Access-Control-Allow-Credentials is
 * deliberately never emitted. POST /submissions and the other non-read routes
 * are not CORS-enabled at all (same-origin only).
 */
const DEFAULT_CORS_ALLOWED_ORIGINS = '*';
const CORS_ALLOWED_METHODS = 'GET';
const CORS_MAX_AGE = '86400';

/**
 * Decide the Access-Control-Allow-Origin value for a request. '*' allows any
 * origin; otherwise CORS_ALLOWED_ORIGINS is a comma-separated list of exact
 * origins and the request's Origin header is echoed only when it matches.
 */
function allowedCorsOrigin(allowedOrigins: string, origin: string | undefined): string | null {
  if (allowedOrigins === '*') {
    return '*';
  }
  const origins = allowedOrigins
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return origin !== undefined && origins.includes(origin) ? origin : null;
}

/** Attach CORS headers to a read-endpoint response. Never sets credentials. */
function applyReadCors(reply: FastifyReply, allowedOrigins: string, origin: string | undefined): void {
  if (allowedOrigins !== '*') {
    // The CORS headers depend on the request Origin; keep caches honest.
    reply.header('vary', 'Origin');
  }
  const allowed = allowedCorsOrigin(allowedOrigins, origin);
  if (allowed !== null) {
    reply.header('access-control-allow-origin', allowed);
    reply.header('access-control-allow-methods', CORS_ALLOWED_METHODS);
  }
}

/** Answer an OPTIONS preflight for one of the public read endpoints. */
function answerCorsPreflight(
  reply: FastifyReply,
  allowedOrigins: string,
  request: FastifyRequest,
): FastifyReply {
  if (allowedOrigins !== '*') {
    // The CORS headers depend on the request Origin; keep caches honest.
    reply.header('vary', 'Origin');
  }
  const allowed = allowedCorsOrigin(allowedOrigins, request.headers.origin);
  if (allowed !== null) {
    reply.header('access-control-allow-origin', allowed);
    reply.header('access-control-allow-methods', CORS_ALLOWED_METHODS);
    reply.header('access-control-max-age', CORS_MAX_AGE);
    const requestedHeaders = request.headers['access-control-request-headers'];
    if (typeof requestedHeaders === 'string' && requestedHeaders.length > 0) {
      reply.header('access-control-allow-headers', requestedHeaders);
    }
  }
  return reply.code(204).send();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register every HTTP route on the provided Fastify instance.
 *
 * @param corsAllowedOrigins CORS_ALLOWED_ORIGINS value; '*' by default. Only
 *   the three public read endpoints are CORS-enabled; write routes stay
 *   same-origin only.
 */
export function registerRoutes(
  app: FastifyInstance,
  deps: ServerDependencies,
  corsAllowedOrigins = DEFAULT_CORS_ALLOWED_ORIGINS,
): void {
  app.post<{ Body: SubmissionRequest }>('/submissions', async (request, reply) => {
    const result = validateAndNormalize(request.body);
    if (!result.ok) {
      // The rejection reasons are not persisted anywhere, so log them.
      request.log.info({ issues: result.issues }, 'rejected submission');
      return reply
        .code(400)
        .send({ error: { code: 'validation_failed', issues: result.issues } });
    }
    try {
      const accepted = await acceptSubmission(deps.database, result.value);
      return reply.code(202).send({ submissionId: accepted.submissionId });
    } catch (err) {
      // Never leak database internals to callers; log them and answer generic.
      request.log.error({ err }, 'failed to accept submission');
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'could not accept submission' },
      });
    }
  });

  app.options('/status/:submissionId', async (request, reply) => {
    return answerCorsPreflight(reply, corsAllowedOrigins, request);
  });

  app.get<{ Params: { submissionId: string } }>('/status/:submissionId', async (request, reply) => {
    applyReadCors(reply, corsAllowedOrigins, request.headers.origin);
    const submission = await deps.database.getSubmission(request.params.submissionId);
    if (submission === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'submission not found' } });
    }
    const result =
      submission.resultId === null
        ? null
        : await deps.database.getResultById(submission.resultId);
    return reply.send({
      submissionId: submission.id,
      contractId: submission.contractId,
      wasmHash: submission.wasmHash,
      sourceRepo: submission.sourceRepo,
      sourceRev: submission.sourceRev,
      status: submission.status,
      attempts: submission.attempts,
      maxAttempts: submission.maxAttempts,
      createdAt: submission.createdAt.toISOString(),
      updatedAt: submission.updatedAt.toISOString(),
      buildLog: submission.buildLog,
      result: result === null ? null : toPublicResult(result),
    });
  });

  app.options('/verifications/by-contract/:contractId', async (request, reply) => {
    return answerCorsPreflight(reply, corsAllowedOrigins, request);
  });

  app.get<{ Params: { contractId: string } }>(
    '/verifications/by-contract/:contractId',
    async (request, reply) => {
      applyReadCors(reply, corsAllowedOrigins, request.headers.origin);
      return handleVerificationsByContract(app, deps, request.params.contractId, reply);
    },
  );

  app.options('/verifications/:wasmHash', async (request, reply) => {
    return answerCorsPreflight(reply, corsAllowedOrigins, request);
  });

  app.get<{ Params: { wasmHash: string } }>('/verifications/:wasmHash', async (request, reply) => {
    applyReadCors(reply, corsAllowedOrigins, request.headers.origin);
    return handleVerifications(app, deps, request.params.wasmHash, reply);
  });

  app.get<{ Params: { sha256: string } }>('/sources/:sha256', async (request, reply) => {
    const { sha256 } = request.params;
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      return reply
        .code(400)
        .send({ error: { code: 'validation_failed', message: 'invalid sha256' } });
    }
    try {
      const bytes = await deps.store.get(sha256);
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="source-${sha256}.tar.gz"`)
        .send(bytes);
    } catch {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'source archive not found' } });
    }
  });
}

/**
 * Serve the signed verification results for a wasm hash: local results plus
 * verified peer results, with the aggregate status and linked source archives.
 */
async function handleVerifications(
  app: FastifyInstance,
  deps: ServerDependencies,
  rawHash: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const wasmHash = normalizeWasmHashHex(rawHash);
  if (wasmHash === null) {
    return reply
      .code(400)
      .send({ error: { code: 'validation_failed', message: 'wasmHash must be a 32-byte hex or base64 value' } });
  }
  return reply.send(await buildVerificationsEnvelope(app, deps, wasmHash));
}

/** Shared envelope shape served by both verification read endpoints. */
interface VerificationEnvelope {
  wasmHash: string;
  status: VerificationStatus;
  results: PublicResult[];
  sources: { sha256: string; url: string }[];
}

/**
 * Serve the signed verification results for a contract ID. The deployed wasm
 * hash is resolved through the shared Resolver — the same code path the
 * submission queue uses — so there is no second RPC implementation.
 *
 * A well-formed ID with no deployed contract behind it is a 404 (never a 200
 * with an empty envelope, which would be indistinguishable from "resolved but
 * genuinely unverified"). A transient upstream RPC failure (timeout, SDK
 * error) is deliberately a 502: the contract may exist, so 404 would lie.
 */
async function handleVerificationsByContract(
  app: FastifyInstance,
  deps: ServerDependencies,
  contractId: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!StrKey.isValidContract(contractId)) {
    return reply
      .code(400)
      .send({ error: { code: 'validation_failed', message: 'contractId must be a valid C-address (StrKey contract id)' } });
  }

  let wasmHash: string;
  try {
    wasmHash = await deps.resolver.resolveWasmHash(contractId);
  } catch (err) {
    if (err instanceof RpcError && err.kind === 'not_found') {
      // Well-formed ID but no deployed contract behind it: a 404, never a
      // 200 with an empty envelope — that would be indistinguishable from
      // "resolved but genuinely unverified".
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `contract ${contractId} is not deployed on the network` } });
    }
    app.log.warn({ err, contractId }, 'by-contract resolution failed');
    return reply
      .code(502)
      .send({ error: { code: 'rpc_error', message: 'could not resolve contract via Soroban RPC' } });
  }
  return reply.send(await buildVerificationsEnvelope(app, deps, wasmHash));
}

/**
 * Build the envelope for a wasm hash, shared by GET /verifications/:wasmHash
 * and GET /verifications/by-contract/:contractId so consumers get an
 * identical response shape regardless of which endpoint they call.
 */
async function buildVerificationsEnvelope(
  app: FastifyInstance,
  deps: ServerDependencies,
  wasmHash: string,
): Promise<VerificationEnvelope> {
  const [localResults, peerResults, submission] = await Promise.all([
    deps.database.getResultsByWasmHash(wasmHash),
    fetchPeerResults(app, deps, wasmHash),
    deps.database.getSubmissionByWasmHash(wasmHash),
  ]);

  const results = dedupe([...localResults.map(toPublicResult), ...peerResults]);
  const status: VerificationStatus =
    results.length > 0
      ? inferStatus(results)
      : submission === null
        ? 'unverified'
        : 'inconclusive';

  const sources = [
    ...new Set(
      results
        .map((result) => result.tarball_sha256)
        .filter((sha256): sha256 is string => sha256 !== null),
    ),
  ].map((sha256) => ({ sha256, url: `/sources/${sha256}` }));

  return { wasmHash, status, results, sources };
}

/**
 * Fetch and verify peer verifiers' results for a hash. Each peer is queried at
 * <base>/verifications/<hash>; a record is kept only if its signature verifies
 * against its embedded public key (and that key's fingerprint matches
 * verifier_id). Peer failures are logged and skipped, never fatal.
 */
async function fetchPeerResults(
  app: FastifyInstance,
  deps: ServerDependencies,
  wasmHash: string,
): Promise<PublicResult[]> {
  const results: PublicResult[] = [];
  await Promise.all(
    deps.peerVerifiers.map(async (base) => {
      try {
        const url = `${base.replace(/\/+$/, '')}/verifications/${wasmHash}`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(5_000),
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.results)) {
          return;
        }
        for (const item of body.results) {
          const parsed = parseSignedResult(item);
          // A signature only proves the peer issued the record — never trust
          // it to answer for a hash it was not asked about. The peer's own
          // spelling is normalized so base64/uppercase records still count.
          if (
            parsed !== null &&
            normalizeWasmHashHex(parsed.wasm_hash) === wasmHash &&
            verifyResultRecord(parsed)
          ) {
            // tarball_sha256 is not part of the signed payload, so it is
            // never propagated from peers; only archives stored by this
            // instance are linked under /sources.
            results.push({ ...parsed, tarball_sha256: null });
          }
        }
      } catch (err) {
        app.log.warn({ peer: base }, `peer fetch failed: ${errMsg(err)}`);
      }
    }),
  );
  return results;
}

/** Structurally validate an untrusted peer result before signature checking. */
function parseSignedResult(value: unknown): SignedResultRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    wasm_hash,
    source_repo,
    source_rev,
    status,
    build_meta,
    verifier_id,
    public_key,
    timestamp,
    signature,
  } = value;
  if (
    typeof wasm_hash !== 'string' ||
    typeof source_repo !== 'string' ||
    typeof source_rev !== 'string' ||
    typeof status !== 'string' ||
    !VALID_STATUSES.includes(status) ||
    typeof verifier_id !== 'string' ||
    typeof public_key !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string'
  ) {
    return null;
  }
  if (build_meta !== null) {
    if (!isRecord(build_meta)) {
      return null;
    }
    for (const v of Object.values(build_meta)) {
      if (typeof v !== 'string') {
        return null;
      }
    }
  }
  return {
    wasm_hash,
    source_repo,
    source_rev,
    status: status as ResultStatus,
    build_meta: build_meta as Record<string, string> | null,
    verifier_id,
    public_key,
    timestamp,
    signature,
  };
}

function toPublicResult(result: VerificationResult): PublicResult {
  return {
    wasm_hash: result.wasmHash,
    source_repo: result.sourceRepo,
    source_rev: result.sourceRev,
    status: result.status,
    build_meta: result.buildMeta,
    verifier_id: result.verifierId,
    public_key: result.publicKey,
    timestamp: result.timestamp,
    signature: result.signature,
    tarball_sha256: result.tarballSha256,
  };
}

/** Aggregate status: verified if any result is verified, else mismatch if any
 * mismatch, else inconclusive. Consumers can still require agreement across
 * their own trusted set via the results array. */
function inferStatus(results: readonly PublicResult[]): VerificationStatus {
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.has('verified')) {
    return 'verified';
  }
  if (statuses.has('mismatch')) {
    return 'mismatch';
  }
  return 'inconclusive';
}

/** Drop duplicate records (same verifier, same signature). */
function dedupe(results: readonly PublicResult[]): PublicResult[] {
  const seen = new Set<string>();
  const out: PublicResult[] = [];
  for (const result of results) {
    const key = `${result.verifier_id}:${result.signature}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(result);
  }
  return out;
}
