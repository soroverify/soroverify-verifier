/**
 * Rate limiting on POST /submissions and the public read endpoints.
 *
 * POST /submissions is the highest-risk endpoint in the service: every
 * accepted submission triggers a real git clone and a real, resource-
 * consuming isolated container build. These tests exercise, through the real
 * Fastify routing:
 *
 *  - a burst beyond the configured per-IP limit on POST /submissions gets a
 *    429, not silent queuing or acceptance;
 *  - the read-only GET /verifications/:wasmHash endpoint stays reachable at
 *    a much higher request volume, proving the strict limit is scoped to
 *    POST /submissions and not applied globally.
 *
 * The database is an in-memory fake; nothing here touches a real Postgres,
 * git, or docker. The global active-submission ceiling (a separate control)
 * is covered by test/submissionCeiling.test.ts.
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
const WASM_HASH = randomBytes(32).toString('hex');

/** In-memory Database stand-in covering only what these routes touch. */
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

  async getResultsByWasmHash(): Promise<[]> {
    return [];
  }

  async getSubmissionByWasmHash(): Promise<null> {
    return null;
  }

  async close(): Promise<void> {}
}

function submissionBody(rev: string): Record<string, unknown> {
  return { contractId: VALID_CONTRACT, sourceRepo: VALID_REPO, sourceRev: rev };
}

const resolver = new Resolver({ rpcUrl: 'https://rpc.invalid' });

describe('POST /submissions rate limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const deps: ServerDependencies = {
      database: new FakeDatabase() as unknown as Database,
      store: new ContentStore('/tmp/soroverify-ratelimit-test-store'),
      resolver,
      peerVerifiers: [],
      // Large enough that the active-submission ceiling never interferes
      // with this describe block; that ceiling has its own test file.
      maxActiveSubmissions: 1000,
    };
    // Production defaults for both limits (buildServer fills these in when
    // omitted): global 300/min, POST /submissions 5/min. Exercising the real
    // defaults here, not a loosened test-only value, is the point.
    app = await buildServer({ host: '127.0.0.1', port: 0, loggerEnabled: false }, deps);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts requests up to the limit, then answers 429 for the rest of the burst', async () => {
    const PRODUCTION_SUBMISSIONS_LIMIT = 5;
    const BURST = PRODUCTION_SUBMISSIONS_LIMIT + 5;

    // Fired back-to-back rather than via Promise.all: a per-IP, per-window
    // limiter cares about request *count* within the window, not about
    // wall-clock concurrency, and driving requests one at a time keeps this
    // deterministic. A real burst against the running server, exercised with
    // concurrent curl requests, is the live-server proof outside this suite.
    const responses = [];
    for (let i = 0; i < BURST; i++) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/submissions',
          payload: submissionBody(`rev-${i}`),
        }),
      );
    }

    const statusCodes = responses.map((r) => r.statusCode);
    const accepted = statusCodes.filter((code) => code === 202);
    const throttled = statusCodes.filter((code) => code === 429);

    // Exactly the configured limit gets through; every request past it is a
    // 429, never a silent accept and never a silent drop (every response is
    // accounted for as either 202 or 429).
    expect(accepted).toHaveLength(PRODUCTION_SUBMISSIONS_LIMIT);
    expect(throttled).toHaveLength(BURST - PRODUCTION_SUBMISSIONS_LIMIT);
    expect(accepted.length + throttled.length).toBe(BURST);

    const throttledResponse = responses.find((r) => r.statusCode === 429);
    expect(throttledResponse).toBeDefined();
    // @fastify/rate-limit's default 429 body; asserting its shape pins that
    // callers get an honest, structured rejection rather than a bare status.
    const body = throttledResponse?.json() as { statusCode: number; error: string };
    expect(body.statusCode).toBe(429);
  });
});

describe('GET /verifications/:wasmHash stays reachable at high volume', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const deps: ServerDependencies = {
      database: new FakeDatabase() as unknown as Database,
      store: new ContentStore('/tmp/soroverify-ratelimit-test-store-read'),
      resolver,
      peerVerifiers: [],
      maxActiveSubmissions: 1000,
    };
    app = await buildServer({ host: '127.0.0.1', port: 0, loggerEnabled: false }, deps);
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers far more requests than the submissions limit without being throttled', async () => {
    // Comfortably more than the 5/min POST /submissions limit, and well
    // under the generous 300/min global default, so this proves the strict
    // limit is scoped to submissions rather than applied service-wide.
    const VOLUME = 50;

    const responses = await Promise.all(
      Array.from({ length: VOLUME }, () =>
        app.inject({ method: 'GET', url: `/verifications/${WASM_HASH}` }),
      ),
    );

    const statusCodes = responses.map((r) => r.statusCode);
    expect(statusCodes.every((code) => code === 200)).toBe(true);
    expect(statusCodes).not.toContain(429);
  });
});
