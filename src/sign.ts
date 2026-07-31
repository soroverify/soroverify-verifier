/**
 * Signed result records.
 *
 * Every published result is a JSON record signed with this verifier instance's
 * Ed25519 key, using node:crypto (no external crypto dependency). The signed
 * payload uses the exact field vocabulary from the spec:
 *
 *   { wasm_hash, source_repo, source_rev, status, build_meta, verifier_id, timestamp }
 *
 * and the signature is over the canonical JSON (sorted keys, no whitespace) of
 * exactly those fields. `public_key` and `signature` travel with the record as
 * unsigned envelope fields; a consumer verifies the signature with the
 * embedded public key AND checks that the public key's fingerprint matches
 * `verifier_id`, so nothing in this service's database needs to be trusted —
 * only the published public key.
 *
 * Failure modes:
 *  - verifyResultRecord returns false (never throws) for malformed records,
 *    wrong signatures, or a public key whose fingerprint does not match
 *    verifier_id.
 *  - signResultRecord throws only on invalid input (bad key material).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { ResultStatus } from './db.js';

/** The signed payload, per the spec's exact field vocabulary. */
export interface ResultRecord {
  wasm_hash: string;
  source_repo: string;
  source_rev: string;
  status: ResultStatus;
  build_meta: Record<string, string> | null;
  verifier_id: string;
  /** ISO-8601 UTC timestamp (new Date().toISOString()); part of the payload. */
  timestamp: string;
}

/** A signed record as published: payload + unsigned envelope fields. */
export interface SignedResultRecord extends ResultRecord {
  /** base64 Ed25519 signature over the canonical payload JSON. */
  signature: string;
  /** base64 SPKI DER public key; fingerprint must equal verifier_id. */
  public_key: string;
}

/** This verifier instance's signing identity. */
export interface VerifierIdentity {
  /** Short fingerprint of the public key (first 16 hex chars of its sha256). */
  verifierId: string;
  /** base64 SPKI DER public key, published with every record. */
  publicKeyB64: string;
  privateKey: KeyObject;
}

/** Generate a fresh ephemeral verifier identity. */
export function createVerifierIdentity(): VerifierIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return identityFromKeyPair(publicKey, privateKey);
}

/**
 * Load a verifier identity from a base64-encoded PKCS8 DER private key (the
 * format `node -e` one-liners and keypairs export). Production deployments
 * must set a persistent key (VERIFIER_PRIVATE_KEY) so the verifier_id stays
 * stable across restarts; results from rotated keys remain verifiable because
 * each record carries its own public key.
 */
export function loadVerifierIdentity(privateKeyPkcs8B64: string): VerifierIdentity {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return identityFromKeyPair(createPublicKey(privateKey), privateKey);
}

function identityFromKeyPair(publicKey: KeyObject, privateKey: KeyObject): VerifierIdentity {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    verifierId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
    publicKeyB64: spki.toString('base64'),
    privateKey,
  };
}

/** Sign a result record, returning it with the signature envelope added. */
export function signResultRecord(
  identity: VerifierIdentity,
  record: ResultRecord,
): SignedResultRecord {
  const canonical = canonicalJson(record);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString(
    'base64',
  );
  return { ...record, signature, public_key: identity.publicKeyB64 };
}

/**
 * Verify a signed record independently: the embedded public key's fingerprint
 * must match verifier_id AND the signature must validate over the canonical
 * payload. Returns false (never throws) for any malformed or invalid record.
 */
export function verifyResultRecord(record: SignedResultRecord): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(record.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const fingerprint = createHash('sha256').update(spki).digest('hex').slice(0, 16);
    if (fingerprint !== record.verifier_id) {
      return false;
    }
    // public_key is an envelope field, not part of the signed payload.
    const { signature, public_key: _publicKey, ...payload } = record;
    return verify(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Canonical JSON: keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}
