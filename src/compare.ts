/**
 * Rebuild-result resolution: verified / mismatch / inconclusive / unverified.
 *
 * These are exactly the four states the RFP demands, and the distinctions are
 * load-bearing:
 *  - A rebuild that errored is `inconclusive`, never `mismatch` — conflating
 *    "we couldn't check" with "it failed the check" trains consumers to
 *    distrust the signal.
 *  - A wasm carrying no SEP-58 build metadata cannot be replayed at all, so it
 *    is `inconclusive` too (the absence is recorded in the job log), even
 *    though a source submission exists.
 *  - `unverified` is the state of a hash for which no result and no submission
 *    exists at all; it is computed at the API layer in routes.ts.
 */

import type { ResultStatus } from './db.js';

/** The full verification status vocabulary. */
export type VerificationStatus = 'verified' | 'mismatch' | 'inconclusive' | 'unverified';

/**
 * Compare a successful rebuild's hashes against the deployed hash. Any rebuilt
 * artifact matching the target counts as verified (multi-crate workspaces
 * produce several wasms).
 */
export function compareRebuiltHashes(
  targetHash: string,
  rebuiltHashes: readonly string[],
): Extract<ResultStatus, 'verified' | 'mismatch'> {
  return rebuiltHashes.includes(targetHash) ? 'verified' : 'mismatch';
}

export interface ResolveInput {
  /** The deployed wasm hash being verified. */
  targetHash: string;
  /** Rebuilt hashes, or null when the rebuild errored or was killed. */
  rebuiltHashes: readonly string[] | null;
  /** Whether the target wasm carries SEP-58 build-environment metadata. */
  buildMetadataPresent: boolean;
}

/**
 * Resolve a completed job attempt to exactly one result status.
 *
 * Returns `inconclusive` when the environment cannot be replayed (no build
 * metadata) or the rebuild did not complete — these go back on the bounded
 * retry queue rather than resolving permanently. Returns `verified` or
 * `mismatch` only for a clean rebuild with a decisive hash comparison.
 */
export function resolveStatus(input: ResolveInput): ResultStatus {
  if (!input.buildMetadataPresent) {
    return 'inconclusive';
  }
  if (input.rebuiltHashes === null) {
    return 'inconclusive';
  }
  return compareRebuiltHashes(input.targetHash, input.rebuiltHashes);
}
