/**
 * Ingest validation and injection-resistance tests (build sequence step 12).
 *
 * Exercises POST /submissions end to end through the real Fastify routing:
 * every malformed or injection-flavored payload must be rejected with a 4xx
 * before anything is inserted — the queue must never see the submission —
 * and a well-formed submission must be accepted, persisted as a 'pending'
 * row, and answered without touching the rebuild pipeline at all.
 *
 * The database is an in-memory fake with a call log, so tests can assert
 * exactly which persistence work a request performed. The real exec layer
 * (child_process.execFile) is spied on to prove POST /submissions never
 * spawns docker/git, and the downstream source-fetch step is exercised
 * directly against a recording executor to pin the argument-array-only
 * contract (never a shell string).
 */

import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, NewSubmission, Submission } from '../src/db.js';
import { buildServer, type ServerDependencies } from '../src/index.js';
import { fetchSourceTarball, type CommandExecutor, type RebuildConfig } from '../src/rebuild.js';
import { Resolver } from '../src/resolve.js';
import { ContentStore } from '../src/store.js';

// Replace the process-spawning surface of node:child_process with a spy so a
// test can assert the request path never execs anything (docker, git). The
// real implementation is retained behind the spy, so any import-time behavior
// of dependencies is unaffected.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const execFileMock = vi.mocked(execFile);

/** Syntactically valid fixtures (checked against the same gates the route uses). */
const VALID_CONTRACT = StrKey.encodeContract(randomBytes(32));
const VALID_WASM_B64 = Buffer.alloc(32).toString('base64');
const VALID_REPO = 'https://github.com/example/soroban-contract.git';
const VALID_REV = 'main';

/** In-memory Database stand-in with a call log and queue-guard canaries. */
class FakeDatabase {
  readonly calls: string[] = [];
  private readonly rows = new Map<string, Submission>();

  async insertSubmission(input: NewSubmission): Promise<{ id: string }> {
    this.calls.push('insertSubmission');
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

  async getSubmission(id: string): Promise<Submission | null> {
    this.calls.push('getSubmission');
    return this.rows.get(id) ?? null;
  }

  /** The job-runner transitions must never fire inside POST /submissions. */
  claimNextJob(): never {
    throw new Error('queue touched during POST /submissions (claimNextJob)');
  }
  completeSubmission(): never {
    throw new Error('queue touched during POST /submissions (completeSubmission)');
  }
  scheduleRetry(): never {
    throw new Error('queue touched during POST /submissions (scheduleRetry)');
  }
  saveResult(): never {
    throw new Error('queue touched during POST /submissions (saveResult)');
  }
  reclaimStuckJobs(): never {
    throw new Error('queue touched during POST /submissions (reclaimStuckJobs)');
  }

  async close(): Promise<void> {}
}

let app: FastifyInstance;
let db: FakeDatabase;

beforeAll(() => {
  db = new FakeDatabase();
  const deps: ServerDependencies = {
    database: db as unknown as Database,
    store: new ContentStore('/tmp/soroverify-ingest-test-store'),
    resolver: new Resolver({ rpcUrl: 'https://rpc.invalid' }),
    peerVerifiers: [],
  };
  app = buildServer({ host: '127.0.0.1', port: 0, loggerEnabled: false }, deps);
});

beforeEach(() => {
  db.calls.length = 0;
  execFileMock.mockClear();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

function post(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/submissions', payload: body });
}

function expectRejected(
  response: Awaited<ReturnType<typeof post>>,
  field: string,
): void {
  expect(response.statusCode).toBe(400);
  const body = response.json() as {
    error: { code: string; issues: { field: string }[] };
  };
  expect(body.error.code).toBe('validation_failed');
  expect(body.error.issues.some((issue) => issue.field === field)).toBe(true);
}

describe('POST /submissions validation and injection resistance', () => {
  describe('malformed contractId', () => {
    const cases: [string, unknown][] = [
      [
        'wrong prefix (valid G-address, not a contract)',
        StrKey.encodeEd25519PublicKey(randomBytes(32)),
      ],
      ['wrong prefix (unknown C-variant)', 'X'.repeat(56)],
      ['too short', 'C'.repeat(20)],
      ['too long', 'C'.repeat(57)],
      ['invalid characters (0 is not base32)', `C${'0'.repeat(55)}`],
      ['empty string', ''],
      ['null', null],
    ];

    it.each(cases)('rejects a contractId that is %s', async (_label, contractId) => {
      const response = await post({
        contractId,
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expectRejected(response, 'contractId');
      expect(db.calls).toEqual([]);
    });
  });

  describe('malformed wasmHash', () => {
    const cases: [string, unknown][] = [
      ['too short', 'abcd1234'],
      ['too long', 'a'.repeat(65)],
      ['non-hex characters', 'z'.repeat(64)],
      ['non-base64 characters', `${'A'.repeat(43)}!`],
      ['empty string', ''],
      ['null', null],
    ];

    it.each(cases)('rejects a wasmHash that is %s', async (_label, wasmHash) => {
      const response = await post({
        wasmHash,
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expectRejected(response, 'wasmHash');
      expect(db.calls).toEqual([]);
    });
  });

  describe('malformed sourceRepo (injection resistance)', () => {
    const cases: [string, unknown][] = [
      ['a bare shell chain', '; rm -rf /'],
      ['an https URL with a command separator', 'https://github.com/evil/repo; rm -rf /'],
      ['an https URL with command substitution', 'https://evil.com/$(id)'],
      ['an https URL with backticks', 'https://evil.com/`id`'],
      ['an https URL with &&', 'https://evil.com/x&&y'],
      ['an https URL with a pipe', 'https://evil.com/x|y'],
      ['an https URL with an embedded null byte', 'https://evil.com/\u0000x'],
      ['not a URL at all', 'not a url'],
      ['an empty string', ''],
      ['null', null],
    ];

    it.each(cases)('rejects sourceRepo that is %s', async (_label, sourceRepo) => {
      const response = await post({
        contractId: VALID_CONTRACT,
        sourceRepo,
        sourceRev: VALID_REV,
      });
      expectRejected(response, 'sourceRepo');
      expect(db.calls).toEqual([]);
    });
  });

  describe('malformed sourceRev (injection resistance)', () => {
    const cases: [string, unknown][] = [
      ['a bare shell chain', '; rm -rf /'],
      ['command substitution', '$(id)'],
      ['backticks', '`id`'],
      ['&&', 'a&&b'],
      ['a pipe', 'a|b'],
      ['an embedded null byte', 'rev\u0000'],
      ['whitespace', 'main branch'],
      ['longer than 128 characters', 'a'.repeat(129)],
      ['an empty string', ''],
      ['null', null],
    ];

    it.each(cases)('rejects sourceRev that is %s', async (_label, sourceRev) => {
      const response = await post({
        contractId: VALID_CONTRACT,
        sourceRepo: VALID_REPO,
        sourceRev,
      });
      expectRejected(response, 'sourceRev');
      expect(db.calls).toEqual([]);
    });
  });

  describe('missing both contractId and wasmHash', () => {
    it('rejects a submission with neither field', async () => {
      const response = await post({ sourceRepo: VALID_REPO, sourceRev: VALID_REV });
      expectRejected(response, 'body');
      expect(db.calls).toEqual([]);
    });
  });

  describe('well-formed submissions', () => {
    it('accepts a contractId submission and persists a pending row', async () => {
      expect(StrKey.isValidContract(VALID_CONTRACT)).toBe(true);
      const response = await post({
        contractId: VALID_CONTRACT,
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expect(response.statusCode).toBe(202);
      const { submissionId } = response.json() as { submissionId: string };
      expect(typeof submissionId).toBe('string');
      expect(submissionId.length).toBeGreaterThan(0);
      // The only database work was the pending insert.
      expect(db.calls).toEqual(['insertSubmission']);
      // The row is readable back as a pending submission.
      const row = await db.getSubmission(submissionId);
      expect(row?.status).toBe('pending');
      expect(row?.contractId).toBe(VALID_CONTRACT);
      expect(row?.wasmHash).toBeNull();
      expect(row?.sourceRepo).toBe(VALID_REPO);
      expect(row?.sourceRev).toBe(VALID_REV);
      // The read-only status endpoint reports it too.
      const status = await app.inject({ method: 'GET', url: `/status/${submissionId}` });
      expect(status.statusCode).toBe(200);
      expect(status.json().status).toBe('pending');
    });

    it('accepts a wasmHash-only submission and normalizes hex to lowercase', async () => {
      const response = await post({
        wasmHash: 'A'.repeat(64),
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expect(response.statusCode).toBe(202);
      const { submissionId } = response.json() as { submissionId: string };
      const row = await db.getSubmission(submissionId);
      expect(row?.wasmHash).toBe('a'.repeat(64));
      expect(row?.contractId).toBeNull();
    });

    it('accepts a base64 wasm hash and stores it as canonical hex', async () => {
      const response = await post({
        wasmHash: VALID_WASM_B64,
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expect(response.statusCode).toBe(202);
      const { submissionId } = response.json() as { submissionId: string };
      const row = await db.getSubmission(submissionId);
      expect(row?.wasmHash).toBe(Buffer.alloc(32).toString('hex'));
    });
  });

  describe('response does not block on rebuild', () => {
    it('returns 202 after only the insert; the rebuild pipeline is untouched', async () => {
      const response = await post({
        contractId: VALID_CONTRACT,
        sourceRepo: VALID_REPO,
        sourceRev: VALID_REV,
      });
      expect(response.statusCode).toBe(202);
      // No claim/complete/retry/result transitions — those belong to the
      // asynchronously running job runner, not to the request.
      expect(db.calls).toEqual(['insertSubmission']);
      // No docker/git invocation happened during the request.
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe('exec-layer contract (argument-array only)', () => {
    it('hands sourceRepo/sourceRev to the executor as single argv entries, never a shell string', async () => {
      const calls: { command: string; args: string[] }[] = [];
      const exec: CommandExecutor = {
        async exec(command: string, args: string[]) {
          calls.push({ command, args });
          return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false };
        },
      };
      const config: RebuildConfig = {
        allowedBuildImages: new Set(),
        verifyImage: 'verify-image:test',
        workDir: '/tmp/soroverify-ingest-test-work',
      };
      const repo = 'https://evil.example/$(id)`id`;rm -rf /';
      const rev = '$(pwd)';
      const outcome = await fetchSourceTarball(exec, config, { repo, rev }, 5_000);
      expect(outcome.status).toBe('error');
      expect(calls).toHaveLength(1);
      // calls has exactly one entry (asserted above); the cast only narrows
      // past noUncheckedIndexedAccess.
      const call = calls[0] as { command: string; args: string[] };
      const { command, args } = call;
      expect(command).toBe('docker'); // an executable, never a composed shell string
      // Hostile values arrive verbatim as standalone elements.
      expect(args).toContain(repo);
      expect(args).toContain(rev);
      expect(args.filter((arg) => arg === repo)).toHaveLength(1);
      expect(args.filter((arg) => arg === rev)).toHaveLength(1);
      // The interpreter script passed via -c stays static: it never embeds the
      // untrusted values, which only ever arrive as "$1"/"$2" positional args.
      const scriptIndex = args.indexOf('-c');
      expect(scriptIndex).toBeGreaterThan(-1);
      const scriptArg = args[scriptIndex + 1] ?? '';
      expect(scriptArg).not.toContain(repo);
      expect(scriptArg).not.toContain(rev);
    });
  });
});
