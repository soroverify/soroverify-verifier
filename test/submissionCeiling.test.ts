/**
 * The global (service-wide, not per-submitter) active-submission ceiling.
 *
 * POST /submissions is the highest-risk endpoint in the service: every
 * accepted submission triggers a real git clone and a real, resource-
 * consuming isolated container build. MAX_ACTIVE_SUBMISSIONS bounds how many
 * submissions can be queued-or-running at once across the whole service, so
 * a distributed set of submitters cannot collectively exhaust the machine
 * even if each individually stays under the per-IP rate limit (covered
 * separately by test/rateLimit.test.ts). This test proves the ceiling turns
 * away a new submission with a clear 503 once already met, rather than
 * accepting it silently or hanging.
 *
 * The database is an in-memory fake; nothing here touches a real Postgres,
 * git, or docker.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, NewSubmission, Submission } from '../src/db.js';
import { buildServer, type ServerDependencies } from '../src/index.js';
import { Resolver } from '../src/resolve.js';
import { ContentStore } from '../src/store.js';

const VALID_CONTRACT = StrKey.encodeContract(randomBytes(32));
const VALID_REPO = 'https://github.com/example/soroban-contract.git';

/** In-memory Database stand-in covering only what this route touches. */
class FakeDatabase {
  private readonly rows = new Map<string, Submission>();

  async insertSubmissionIfUnderCeiling(
    input: NewSubmission,
    maxActive: number,
  ): Promise<{ id: string } | null> {
    if (this.countActive() >= maxActive) {
      return null;
    }
    const id = randomUUID();
    const now = new Date();
    this.rows.set(id, {
      id,
      contractId: input.contractId,
      wasmHash: input.wasmHash,
      sourceRepo: input.sourceRepo,
      sourceRev: input.sourceRev,
      buildImage: input.buildImage,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextAttemptAt: now,
      buildLog: null,
      tarballSha256: null,
      resultId: null,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  }

  async countActiveSubmissions(): Promise<number> {
    return this.countActive();
  }

  private countActive(): number {
    return [...this.rows.values()].filter(
      (row) =>
        row.status === 'running' ||
        ((row.status === 'pending' || row.status === 'inconclusive') &&
          row.attempts < row.maxAttempts),
    ).length;
  }

  async close(): Promise<void> {}
}

function submissionBody(rev: string): Record<string, unknown> {
  return { contractId: VALID_CONTRACT, sourceRepo: VALID_REPO, sourceRev: rev };
}

const resolver = new Resolver({ rpcUrl: 'https://rpc.invalid' });

describe('global active-submission ceiling', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const deps: ServerDependencies = {
      database: new FakeDatabase() as unknown as Database,
      store: new ContentStore('/tmp/soroverify-ceiling-test-store'),
      resolver,
      peerVerifiers: [],
      // A tiny ceiling makes the "already met" case reachable in two
      // requests instead of needing a real backlog.
      maxActiveSubmissions: 1,
    };
    // A high rate limit so the limiter never interferes with this test; the
    // ceiling and the rate limit are independent, separately-tested controls.
    app = await buildServer(
      { host: '127.0.0.1', port: 0, loggerEnabled: false, submissionsRateLimitMax: 1000 },
      deps,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a submission under the ceiling, then rejects the next with a clear 503', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: submissionBody('first'),
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: submissionBody('second'),
    });

    // Rejected honestly with a specific error, not accepted and not a
    // connection drop / hang.
    expect(second.statusCode).toBe(503);
    const body = second.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('queue_full');
    expect(body.error.message).toContain('1');
    expect(body.error.message.toLowerCase()).toContain('capacity');
  });
});
