/**
 * Bounded-concurrency job runner over Postgres row status.
 *
 * A polling loop claims due submission rows atomically (FOR UPDATE SKIP LOCKED
 * in db.ts) and processes each job through the full pipeline: resolve the
 * deployed wasm hash, fetch the target wasm, read its SEP-58 metadata, fetch
 * the source, store it content-addressed, rebuild in isolation, compare, sign,
 * and persist the result. Only a bounded number of jobs run concurrently.
 *
 * Retry semantics (bounded, never infinite): a job that ends inconclusive
 * (toolchain failure, missing dependency, unrecognized metadata, transient
 * RPC error) is scheduled for another attempt with exponential backoff as
 * long as attempts < max_attempts; once the budget is exhausted it resolves
 * as final `inconclusive`. A rejected job (build image not allowlisted) is
 * terminal and never retried.
 *
 * The runner never lets a job failure crash the loop; every unexpected error
 * is caught, logged, and retried as inconclusive.
 *
 * A lease-timeout reaper (reclaimStuckJobs, driven from index.ts on its own
 * fixed interval) rescues rows left 'running' by a dead or hung worker: they
 * are reset to 'inconclusive' with their attempt counter bumped, so they go
 * back on the queue and the retry budget still bounds reclamation.
 */

import { randomUUID } from 'node:crypto';
import type { Database, Submission } from './db.js';
import type { Resolver } from './resolve.js';
import { hasBuildEnvironment, parseWasmMeta, readBuildEnvironment, type MetaEntry } from './meta.js';
import {
  fetchSourceTarball,
  runRebuild,
  type CommandExecutor,
  type RebuildConfig,
  type RebuildRequest,
} from './rebuild.js';
import { resolveStatus } from './compare.js';
import { signResultRecord, type ResultRecord, type VerifierIdentity } from './sign.js';
import type { ContentStore } from './store.js';

/** Minimal structured logger the runner can be given (pino-compatible). */
export interface RunnerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobRunnerConfig {
  database: Database;
  resolver: Resolver;
  exec: CommandExecutor;
  rebuildConfig: RebuildConfig;
  store: ContentStore;
  identity: VerifierIdentity;
  log: RunnerLog;
  /** Max jobs processed at once. Defaults to 4. */
  concurrency?: number;
  /** Idle poll interval in ms. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Wall-clock limit for the source fetch, in ms. Defaults to 5 minutes. */
  fetchTimeoutMs?: number;
  /** Base backoff for inconclusive retries, in seconds. Defaults to 60. */
  retryBackoffSeconds?: number;
}

export class JobRunner {
  private readonly config: JobRunnerConfig;
  private stopped = false;
  private running = false;
  private inFlight = 0;

  constructor(config: JobRunnerConfig) {
    this.config = config;
  }

  /** Begin polling. Safe to call once; repeated calls are ignored. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop().catch((err) => {
      this.config.log.error({ err: errMsg(err) }, 'job runner loop crashed');
      this.running = false;
    });
  }

  /** Stop polling and wait for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    while (this.inFlight > 0) {
      await sleep(100);
    }
  }

  /**
   * Lease-timeout reaper, called on a fixed interval from index.ts
   * independently of the poll loop. Any row left 'running' past the rebuild
   * container's hard wall-clock limit (plus a grace margin) means the worker
   * that claimed it died or hung, so it is reset to 'inconclusive' with its
   * attempt counter bumped and becomes claimable again. Each reclaimed job is
   * logged at warn. Sweep failures are logged and never crash the interval.
   */
  async reclaimStuckJobs(): Promise<void> {
    try {
      // The longest a healthy job can hold 'running' without touching
      // updated_at is the max of the fetch window (fetch runs before
      // setTarballSha256 refreshes the row) and the rebuild window (the build
      // itself, which is killed at buildTimeoutMs). Reclaiming anything older
      // plus a grace margin is safe against false positives.
      const buildTimeoutMs = this.config.rebuildConfig.buildTimeoutMs ?? 10 * 60 * 1000;
      const fetchTimeoutMs = this.config.fetchTimeoutMs ?? 5 * 60 * 1000;
      const graceMs = 2 * 60 * 1000;
      const staleBefore = new Date(Date.now() - (Math.max(buildTimeoutMs, fetchTimeoutMs) + graceMs));
      const reclaimed = await this.config.database.reclaimStuckJobs(staleBefore);
      for (const row of reclaimed) {
        this.config.log.warn(
          { submissionId: row.id, stuckSeconds: row.stuckSeconds },
          'reclaimed stuck running submission; reset to inconclusive',
        );
      }
    } catch (err) {
      this.config.log.error({ err: errMsg(err) }, 'stuck-job reaper sweep failed');
    }
  }

  private async loop(): Promise<void> {
    const concurrency = this.config.concurrency ?? 4;
    const pollIntervalMs = this.config.pollIntervalMs ?? 1000;
    let consecutiveErrors = 0;
    while (!this.stopped) {
      if (this.inFlight >= concurrency) {
        await sleep(200);
        continue;
      }
      try {
        const job = await this.config.database.claimNextJob();
        consecutiveErrors = 0;
        if (job === null) {
          await sleep(pollIntervalMs);
          continue;
        }
        this.inFlight += 1;
        void this.processJob(job).finally(() => {
          this.inFlight -= 1;
        });
      } catch (err) {
        // A transient database failure must not kill the loop; back off and
        // keep polling so processing resumes once the database is back.
        consecutiveErrors += 1;
        const backoffMs = Math.min(pollIntervalMs * 2 ** consecutiveErrors, 60_000);
        this.config.log.error(
          { err: errMsg(err), backoffMs },
          'job claim failed; backing off',
        );
        await sleep(backoffMs);
      }
    }
  }

  private async processJob(submission: Submission): Promise<void> {
    const { log } = this.config;
    log.info({ submissionId: submission.id }, 'processing submission');

    try {
      // 1. Resolve the deployed wasm hash when the submission was
      //    contractId-only.
      let wasmHash = submission.wasmHash;
      if (wasmHash === null) {
        if (submission.contractId === null) {
          await this.inconclusive(submission, 'submission has neither wasmHash nor contractId');
          return;
        }
        try {
          wasmHash = await this.config.resolver.resolveWasmHash(submission.contractId);
          await this.config.database.updateResolvedWasmHash(submission.id, wasmHash);
        } catch (err) {
          await this.inconclusive(submission, `could not resolve deployed wasm hash: ${errMsg(err)}`);
          return;
        }
      }

      // 2. Fetch the target wasm bytes.
      let wasmBytes: Buffer;
      try {
        wasmBytes = await this.config.resolver.fetchWasmByHash(wasmHash);
      } catch (err) {
        await this.inconclusive(submission, `could not fetch target wasm: ${errMsg(err)}`);
        return;
      }

      // 3. Read SEP-58 build metadata. Without it the environment cannot be
      //    replayed, which is a recorded inconclusive — never a mismatch.
      const metaEntries = parseWasmMeta(wasmBytes);
      const environment = readBuildEnvironment(metaEntries);
      if (!hasBuildEnvironment(metaEntries) || environment.buildImage === null) {
        await this.inconclusive(
          submission,
          'target wasm carries no SEP-58 build metadata (bldimg); the build environment cannot be replayed',
        );
        return;
      }

      // 4. Fetch the submitted source (the only egress in the pipeline).
      const fetch = await fetchSourceTarball(
        this.config.exec,
        this.config.rebuildConfig,
        { repo: submission.sourceRepo, rev: submission.sourceRev },
        this.config.fetchTimeoutMs ?? 5 * 60 * 1000,
      );
      if (fetch.status !== 'success') {
        await this.inconclusive(submission, `${fetch.reason}\n${fetch.log}`);
        return;
      }

      // 5. Store the tarball content-addressed (tamper-evident).
      const tarballSha256 = await this.config.store.put(fetch.tarball);
      await this.config.database.setTarballSha256(submission.id, tarballSha256);

      // 6. Rebuild in isolation.
      const request: RebuildRequest = {
        submissionId: submission.id,
        attempt: submission.attempts,
        buildImage: environment.buildImage,
        rustVersion: environment.rustVersion,
        sourceTarball: fetch.tarball,
        buildArgs: environment.buildArgs,
        buildOptions: environment.buildOptions,
        metaEntries,
      };
      const rebuilt = await runRebuild(this.config.exec, this.config.rebuildConfig, request);
      if (rebuilt.status === 'rejected') {
        await this.config.database.rejectSubmission(submission.id, rebuilt.reason);
        log.warn({ submissionId: submission.id, reason: rebuilt.reason }, 'submission rejected');
        return;
      }
      if (rebuilt.status === 'error') {
        await this.inconclusive(submission, `${rebuilt.reason}\n${rebuilt.buildLog}`);
        return;
      }

      // 7. Compare -> exactly one status.
      const status = resolveStatus({
        targetHash: wasmHash,
        rebuiltHashes: rebuilt.rebuiltArtifacts.map((artifact) => artifact.hash),
        buildMetadataPresent: true,
      });

      // 8. Sign and persist the result record, then mark the job complete.
      const buildMeta = metaToRecord(metaEntries);
      const record: ResultRecord = {
        wasm_hash: wasmHash,
        source_repo: submission.sourceRepo,
        source_rev: submission.sourceRev,
        status,
        build_meta: buildMeta,
        verifier_id: this.config.identity.verifierId,
        timestamp: new Date().toISOString(),
      };
      const signed = signResultRecord(this.config.identity, record);
      const resultId = randomUUID();
      await this.config.database.saveResult({
        id: resultId,
        wasmHash,
        sourceRepo: submission.sourceRepo,
        sourceRev: submission.sourceRev,
        status,
        buildMeta,
        verifierId: signed.verifier_id,
        publicKey: signed.public_key,
        timestamp: signed.timestamp,
        signature: signed.signature,
        tarballSha256,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await this.config.database.completeSubmission(submission.id, {
        status,
        buildLog: rebuilt.buildLog,
        resultId,
      });
      log.info({ submissionId: submission.id, status }, 'submission resolved');
    } catch (err) {
      // An unexpected failure must never crash the loop or wedge the job.
      log.error({ err: errMsg(err), submissionId: submission.id }, 'unexpected error processing submission');
      try {
        await this.inconclusive(submission, `internal error: ${errMsg(err)}`);
      } catch (recordErr) {
        // Recording the outcome failed too (likely the database itself); log
        // and drop the job rather than crashing the process.
        log.error(
          { err: errMsg(recordErr), submissionId: submission.id },
          'could not record inconclusive outcome after processing error',
        );
      }
    }
  }

  /**
   * Record an inconclusive outcome. If the retry budget remains, the job goes
   * back on the queue with exponential backoff; otherwise it resolves as final
   * inconclusive. Inconclusive is never conflated with mismatch.
   */
  private async inconclusive(submission: Submission, logText: string): Promise<void> {
    if (submission.attempts < submission.maxAttempts) {
      const base = this.config.retryBackoffSeconds ?? 60;
      const backoff = base * 2 ** (submission.attempts - 1);
      await this.config.database.scheduleRetry(submission.id, logText, backoff);
      this.config.log.info(
        { submissionId: submission.id, attempt: submission.attempts, backoffSeconds: backoff },
        'inconclusive; scheduling retry',
      );
    } else {
      await this.config.database.completeSubmission(submission.id, {
        status: 'inconclusive',
        buildLog: logText,
        resultId: null,
      });
      this.config.log.info({ submissionId: submission.id }, 'inconclusive after exhausting retry budget');
    }
  }
}

/** Collapse meta entries to a plain map (last value wins per key). */
function metaToRecord(entries: readonly MetaEntry[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.key] = entry.value;
  }
  return record;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
