/**
 * Postgres access layer.
 *
 * The database is the coordination point for the submission queue and the
 * store of signed result records. Every job transition is a row update, so
 * multiple worker processes — or several instances of this service sharing a
 * database — can coordinate safely without a separate job broker.
 *
 * Integrity note: result records are signed with the verifier's Ed25519 key
 * before they are persisted (see sign.ts). Nothing in this database is trusted
 * by itself; consumers must verify a result's signature against the verifier's
 * published public key.
 */

import { Pool } from 'pg';

/** Lifecycle status of a submission job. */
export type JobStatus =
  'pending' | 'running' | 'verified' | 'mismatch' | 'inconclusive' | 'rejected';

/** Result statuses that may appear in a signed result record. */
export type ResultStatus = 'verified' | 'mismatch' | 'inconclusive';

/** A submission row as exposed to the rest of the service. */
export interface Submission {
  id: string;
  contractId: string | null;
  /** Null until the job runner resolves it (contractId-only submissions). */
  wasmHash: string | null;
  sourceRepo: string;
  sourceRev: string;
  buildImage: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  buildLog: string | null;
  tarballSha256: string | null;
  resultId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A signed verification result row. */
export interface VerificationResult {
  id: string;
  wasmHash: string;
  sourceRepo: string;
  sourceRev: string;
  status: ResultStatus;
  buildMeta: Record<string, string> | null;
  verifierId: string;
  publicKey: string;
  /** ISO-8601 UTC timestamp (always new Date().toISOString()). Stored as text
   * so the signed payload round-trips byte-for-byte and the signature always
   * re-verifies against it. Every writer must use Date#toISOString so the
   * format stays uniform (the API also orders results by this column). */
  timestamp: string;
  /** base64url Ed25519 signature over the canonical record JSON. */
  signature: string;
  tarballSha256: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Inputs for a new submission. */
export interface NewSubmission {
  contractId: string | null;
  /** Null when only contractId was provided; the job runner resolves it. */
  wasmHash: string | null;
  sourceRepo: string;
  sourceRev: string;
  buildImage: string | null;
  /** Bounded retry budget; defaults to 3 attempts. */
  maxAttempts?: number;
}

/** Outcome of a completed verification job. */
export interface JobOutcome {
  status: ResultStatus;
  buildLog: string | null;
  resultId: string | null;
}

export interface DatabaseConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/soroverify */
  connectionString: string;
  /** Max connections in the pool; defaults to 10. */
  maxConnections?: number;
  /** Minimal logger; defaults to a no-op. */
  logger?: Pick<Console, 'error' | 'info'>;
}

type SubmissionRow = {
  id: string;
  contract_id: string | null;
  wasm_hash: string | null;
  source_repo: string;
  source_rev: string;
  build_image: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  build_log: string | null;
  tarball_sha256: string | null;
  result_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type ResultRow = {
  id: string;
  wasm_hash: string;
  source_repo: string;
  source_rev: string;
  status: ResultStatus;
  build_meta: Record<string, string> | null;
  verifier_id: string;
  public_key: string;
  timestamp: string;
  signature: string;
  tarball_sha256: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapSubmissionRow(row: SubmissionRow): Submission {
  return {
    id: row.id,
    contractId: row.contract_id,
    wasmHash: row.wasm_hash,
    sourceRepo: row.source_repo,
    sourceRev: row.source_rev,
    buildImage: row.build_image,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    buildLog: row.build_log,
    tarballSha256: row.tarball_sha256,
    resultId: row.result_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResultRow(row: ResultRow): VerificationResult {
  return {
    id: row.id,
    wasmHash: row.wasm_hash,
    sourceRepo: row.source_repo,
    sourceRev: row.source_rev,
    status: row.status,
    buildMeta: row.build_meta,
    verifierId: row.verifier_id,
    publicKey: row.public_key,
    timestamp: row.timestamp,
    signature: row.signature,
    tarballSha256: row.tarball_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Database {
  private readonly pool: Pool;
  private readonly logger: Pick<Console, 'error' | 'info'>;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 10,
    });
    this.logger = config.logger ?? { error: () => undefined, info: () => undefined };
    // An idle client error must not crash the process; log it instead.
    this.pool.on('error', (err) => {
      this.logger.error(`unexpected idle postgres client error: ${err.message}`);
    });
  }

  /** Create the submissions/results tables and supporting indexes. Idempotent. */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id text,
        wasm_hash text,
        source_repo text NOT NULL,
        source_rev text NOT NULL,
        build_image text,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        build_log text,
        tarball_sha256 text,
        result_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT submissions_status_check
          CHECK (status IN ('pending','running','verified','mismatch','inconclusive','rejected'))
      );

      CREATE TABLE IF NOT EXISTS results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wasm_hash text NOT NULL,
        source_repo text NOT NULL,
        source_rev text NOT NULL,
        status text NOT NULL,
        build_meta jsonb,
        verifier_id text NOT NULL,
        public_key text NOT NULL,
        timestamp text NOT NULL,
        signature text NOT NULL,
        tarball_sha256 text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT results_status_check
          CHECK (status IN ('verified','mismatch','inconclusive'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS results_wasm_verifier_idx ON results (wasm_hash, verifier_id);
      CREATE INDEX IF NOT EXISTS submissions_wasm_hash_idx ON submissions (wasm_hash);
      CREATE INDEX IF NOT EXISTS submissions_queue_idx ON submissions (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS submissions_result_id_idx ON submissions (result_id);
    `);
  }

  /** Insert a new submission in 'pending' state. Returns its id. */
  async insertSubmission(input: NewSubmission): Promise<{ id: string }> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO submissions (contract_id, wasm_hash, source_repo, source_rev, build_image, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.contractId,
        input.wasmHash,
        input.sourceRepo,
        input.sourceRev,
        input.buildImage,
        input.maxAttempts ?? 3,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('insertSubmission returned no row');
    }
    return { id: row.id };
  }

  /** Fetch a submission by id, or null when it does not exist. */
  async getSubmission(id: string): Promise<Submission | null> {
    const result = await this.pool.query<SubmissionRow>('SELECT * FROM submissions WHERE id = $1', [
      id,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapSubmissionRow(row);
  }

  /** Fetch the most recent submission for a wasm hash, or null. */
  async getSubmissionByWasmHash(wasmHash: string): Promise<Submission | null> {
    const result = await this.pool.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE wasm_hash = $1 ORDER BY created_at DESC LIMIT 1',
      [wasmHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSubmissionRow(row);
  }

  /**
   * Atomically claim the next due job for the worker.
   *
   * Only rows that are 'pending' or 'inconclusive', due (next_attempt_at <=
   * now()), and still within their retry budget are claimable. The claim marks
   * the row 'running' and increments attempts, and uses FOR UPDATE SKIP LOCKED
   * so concurrent workers never process the same row. Returns null when the
   * queue is empty.
   */
  async claimNextJob(): Promise<Submission | null> {
    const result = await this.pool.query<SubmissionRow>(
      `UPDATE submissions
          SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = (
          SELECT id FROM submissions
           WHERE status IN ('pending','inconclusive')
             AND next_attempt_at <= now()
             AND attempts < max_attempts
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSubmissionRow(row);
  }

  /** Mark a job complete with a terminal outcome. */
  async completeSubmission(submissionId: string, outcome: JobOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE submissions
          SET status = $2, build_log = $3, result_id = $4, updated_at = now()
        WHERE id = $1`,
      [submissionId, outcome.status, outcome.buildLog, outcome.resultId],
    );
  }

  /** Mark a job permanently rejected (e.g. build image not on the allowlist). */
  async rejectSubmission(submissionId: string, buildLog: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE submissions
          SET status = 'rejected', build_log = $2, updated_at = now()
        WHERE id = $1`,
      [submissionId, buildLog],
    );
  }

  /** Put an inconclusive job back on the retry queue with a delay. */
  async scheduleRetry(
    submissionId: string,
    buildLog: string | null,
    delaySeconds: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE submissions
          SET status = 'inconclusive', build_log = $2, next_attempt_at = $3, updated_at = now()
        WHERE id = $1`,
      [submissionId, buildLog, new Date(Date.now() + delaySeconds * 1000)],
    );
  }

  /**
   * Reclaim submission rows left 'running' past the lease timeout (e.g. a
   * worker process died mid-job). Each stale row is reset to 'inconclusive'
   * with its attempt counter bumped — the retry budget (attempts <
   * max_attempts) then still bounds how many times a genuinely stuck job can
   * be reclaimed. Returns the reclaimed ids with how long each had been
   * stuck, in seconds, for structured logging. FOR UPDATE SKIP LOCKED keeps
   * multiple reaper instances (workers sharing a database) from reclaiming
   * the same row twice.
   */
  async reclaimStuckJobs(staleBefore: Date): Promise<{ id: string; stuckSeconds: number }[]> {
    const result = await this.pool.query<{ id: string; stuck_seconds: number }>(
      // MATERIALIZED: Postgres would otherwise inline the single-reference
      // CTE, which can change FOR UPDATE SKIP LOCKED semantics and the
      // pre-update updated_at read in RETURNING.
      `WITH stale AS MATERIALIZED (
          SELECT id, updated_at
            FROM submissions
           WHERE status = 'running' AND updated_at < $1
           FOR UPDATE SKIP LOCKED
       )
       UPDATE submissions s
          SET status = 'inconclusive',
              attempts = attempts + 1,
              updated_at = now()
         FROM stale
        WHERE s.id = stale.id
        RETURNING s.id, EXTRACT(EPOCH FROM (now() - stale.updated_at))::int AS stuck_seconds`,
      [staleBefore],
    );
    return result.rows.map((row) => ({ id: row.id, stuckSeconds: row.stuck_seconds }));
  }

  /**
   * Upsert a signed result record keyed by (wasm_hash, verifier_id), keeping
   * each verifier's most recent result for a hash.
   */
  async saveResult(record: VerificationResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO results
         (id, wasm_hash, source_repo, source_rev, status, build_meta, verifier_id,
          public_key, timestamp, signature, tarball_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (wasm_hash, verifier_id) DO UPDATE SET
         source_repo = EXCLUDED.source_repo,
         source_rev = EXCLUDED.source_rev,
         status = EXCLUDED.status,
         build_meta = EXCLUDED.build_meta,
         public_key = EXCLUDED.public_key,
         timestamp = EXCLUDED.timestamp,
         signature = EXCLUDED.signature,
         tarball_sha256 = EXCLUDED.tarball_sha256,
         updated_at = now()`,
      [
        record.id,
        record.wasmHash,
        record.sourceRepo,
        record.sourceRev,
        record.status,
        record.buildMeta === null ? null : JSON.stringify(record.buildMeta),
        record.verifierId,
        record.publicKey,
        record.timestamp,
        record.signature,
        record.tarballSha256,
      ],
    );
  }

  /** All current signed results for a wasm hash, newest first. */
  async getResultsByWasmHash(wasmHash: string): Promise<VerificationResult[]> {
    const result = await this.pool.query<ResultRow>(
      'SELECT * FROM results WHERE wasm_hash = $1 ORDER BY timestamp DESC',
      [wasmHash],
    );
    return result.rows.map(mapResultRow);
  }

  /** Fetch one result by id, or null. */
  async getResultById(id: string): Promise<VerificationResult | null> {
    const result = await this.pool.query<ResultRow>('SELECT * FROM results WHERE id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? null : mapResultRow(row);
  }

  /** Record the resolved wasm hash of a contractId-only submission. */
  async updateResolvedWasmHash(submissionId: string, wasmHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE submissions SET wasm_hash = $2, updated_at = now() WHERE id = $1',
      [submissionId, wasmHash],
    );
  }

  /** Record the content address of the stored source tarball. */
  async setTarballSha256(submissionId: string, sha256: string): Promise<void> {
    await this.pool.query(
      'UPDATE submissions SET tarball_sha256 = $2, updated_at = now() WHERE id = $1',
      [submissionId, sha256],
    );
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Create a Database from config. */
export function createDatabase(config: DatabaseConfig): Database {
  return new Database(config);
}
