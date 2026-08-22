/**
 * Read-only verifications endpoint tests.
 *
 * Exercises GET /verifications/:wasmHash and GET
 * /verifications/by-contract/:contractId through the real Fastify routing
 * with an in-memory database fake and no live RPC.
 *
 * The contract -> wasm lookup is performed by a real Resolver instance behind
 * a spy. Asserting the spy is invoked (with the contract ID) is the
 * code-level proof that the by-contract route shares the resolution logic in
 * src/resolve.ts — the same function the submission queue uses — instead of
 * duplicating an RPC implementation.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, Submission, VerificationResult } from '../src/db.js';
import { buildServer, type ServerDependencies } from '../src/index.js';
import { Resolver, RpcError } from '../src/resolve.js';
import { ContentStore } from '../src/store.js';

/** Syntactically valid contract id (checked against the same gate the route uses). */
const VALID_CONTRACT = StrKey.encodeContract(randomBytes(32));
const WASM_HASH = randomBytes(32).toString('hex');
const SOURCE_REPO = 'https://github.com/example/contract.git';
const TARBALL_SHA256 = randomBytes(32).toString('hex');

function resultFixture(overrides: Partial<VerificationResult> = {}): VerificationResult {
  const now = new Date();
  return {
    id: randomUUID(),
    wasmHash: WASM_HASH,
    sourceRepo: SOURCE_REPO,
    sourceRev: 'main',
    status: 'verified',
    buildMeta: { bldimg: 'example/build@sha256:abc' },
    verifierId: 'a1b2c3d4e5f60718',
    publicKey: 'base64-public-key',
    timestamp: '2026-07-01T12:00:00.000Z',
    signature: 'base64-signature',
    tarballSha256: TARBALL_SHA256,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** In-memory Database stand-in covering only what the read endpoints touch. */
class FakeDatabase {
  readonly calls: string[] = [];
  private results: VerificationResult[] = [];
  private submission: Submission | null = null;
  private result: VerificationResult | null = null;

  setResults(results: VerificationResult[]): void {
    this.results = results;
  }

  setSubmission(submission: Submission | null): void {
    this.submission = submission;
  }

  setResult(result: VerificationResult | null): void {
    this.result = result;
  }

  async getResultsByWasmHash(wasmHash: string): Promise<VerificationResult[]> {
    this.calls.push('getResultsByWasmHash');
    return this.results.filter((result) => result.wasmHash === wasmHash);
  }

  async getSubmissionByWasmHash(): Promise<Submission | null> {
    this.calls.push('getSubmissionByWasmHash');
    return this.submission;
  }

  async getSubmission(submissionId: string): Promise<Submission | null> {
    this.calls.push('getSubmission');
    return this.submission !== null && this.submission.id === submissionId ? this.submission : null;
  }

  async getResultById(resultId: string): Promise<VerificationResult | null> {
    this.calls.push('getResultById');
    return this.result !== null && this.result.id === resultId ? this.result : null;
  }

  async close(): Promise<void> {}
}

// A real Resolver, so the shared resolve.ts code path is under test. The RPC
// URL is deliberately unreachable: every test either stubs resolveWasmHash or
// never reaches it, so an unspied call would fail loudly instead of passing.
const resolver = new Resolver({ rpcUrl: 'https://rpc.invalid' });
const resolveSpy = vi.spyOn(resolver, 'resolveWasmHash');

let app: FastifyInstance;
let db: FakeDatabase;

beforeAll(() => {
  db = new FakeDatabase();
  const deps: ServerDependencies = {
    database: db as unknown as Database,
    store: new ContentStore('/tmp/soroverify-routes-test-store'),
    resolver,
    peerVerifiers: [],
  };
  app = buildServer({ host: '127.0.0.1', port: 0, loggerEnabled: false }, deps);
});

beforeEach(() => {
  db.calls.length = 0;
  db.setResults([]);
  db.setSubmission(null);
  db.setResult(null);
  resolveSpy.mockClear();
});

afterAll(async () => {
  await app.close();
});

describe('GET /verifications/:wasmHash', () => {
  it('returns the envelope with results, aggregate status, and sources', async () => {
    db.setResults([resultFixture()]);
    const response = await app.inject({ method: 'GET', url: `/verifications/${WASM_HASH}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      wasmHash: string;
      status: string;
      results: unknown[];
      sources: { sha256: string; url: string }[];
    };
    expect(body.wasmHash).toBe(WASM_HASH);
    expect(body.status).toBe('verified');
    expect(body.results).toHaveLength(1);
    expect(body.sources).toEqual([{ sha256: TARBALL_SHA256, url: `/sources/${TARBALL_SHA256}` }]);
  });

  it('rejects a malformed wasm hash with 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/verifications/not-a-hash' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_failed');
  });
});

describe('GET /verifications/by-contract/:contractId', () => {
  describe('malformed contract ID', () => {
    const cases: [string, string][] = [
      [
        'wrong prefix (valid G-address, not a contract)',
        StrKey.encodeEd25519PublicKey(randomBytes(32)),
      ],
      ['wrong prefix (unknown C-variant)', 'X'.repeat(56)],
      ['too short', 'C'.repeat(20)],
      ['invalid characters (0 is not base32)', `C${'0'.repeat(55)}`],
    ];

    it.each(cases)('rejects %s with 400 before any RPC call', async (_label, contractId) => {
      const response = await app.inject({
        method: 'GET',
        url: `/verifications/by-contract/${contractId}`,
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
      // Rejected before touching RPC or the database.
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(db.calls).toEqual([]);
    });
  });

  it('returns the same envelope as the wasm-hash endpoint with correct data', async () => {
    db.setResults([resultFixture()]);
    resolveSpy.mockResolvedValueOnce(WASM_HASH);

    const byContract = await app.inject({
      method: 'GET',
      url: `/verifications/by-contract/${VALID_CONTRACT}`,
    });
    const byHash = await app.inject({ method: 'GET', url: `/verifications/${WASM_HASH}` });

    expect(byContract.statusCode).toBe(200);
    expect(byHash.statusCode).toBe(200);
    // Identical response shape regardless of which endpoint was called.
    expect(byContract.json()).toEqual(byHash.json());

    const body = byContract.json() as {
      wasmHash: string;
      status: string;
      results: Array<Record<string, unknown>>;
      sources: { sha256: string; url: string }[];
    };
    expect(body.wasmHash).toBe(WASM_HASH);
    expect(body.status).toBe('verified');
    expect(body.results).toEqual([
      expect.objectContaining({
        wasm_hash: WASM_HASH,
        source_repo: SOURCE_REPO,
        source_rev: 'main',
        status: 'verified',
        verifier_id: 'a1b2c3d4e5f60718',
        signature: 'base64-signature',
        tarball_sha256: TARBALL_SHA256,
      }),
    ]);
    expect(body.sources).toEqual([{ sha256: TARBALL_SHA256, url: `/sources/${TARBALL_SHA256}` }]);
  });

  it('resolves the wasm hash through the shared Resolver, not a parallel implementation', async () => {
    // Code-level check: the handler must call the injected
    // Resolver.resolveWasmHash — the same function the submission queue uses.
    // The spy wraps a real Resolver instance, so this only passes if the route
    // shares resolve.ts: a duplicated RPC implementation would never hit the
    // spy and would fail against the deliberately unreachable RPC URL.
    resolveSpy.mockResolvedValueOnce(WASM_HASH);
    const response = await app.inject({
      method: 'GET',
      url: `/verifications/by-contract/${VALID_CONTRACT}`,
    });
    expect(response.statusCode).toBe(200);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(VALID_CONTRACT);
  });

  it('returns 404 for a well-formed contract that is not deployed', async () => {
    resolveSpy.mockRejectedValueOnce(
      new RpcError('not_found', 'contract not found on the network'),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/verifications/by-contract/${VALID_CONTRACT}`,
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain(VALID_CONTRACT);
    // A missing contract is a 404, never a 200 with an empty envelope.
    expect(db.calls).toEqual([]);
  });
});

describe('GET /status/:submissionId', () => {
  describe('malformed submissionId', () => {
    const cases: [string, string][] = [
      ['a non-UUID string', 'unknown-id'],
      ['an empty string', ''],
      ['a wrong-length string', 'a'.repeat(35)],
      ['a wrong-format string (no dashes, non-hex)', 'z'.repeat(36)],
    ];

    it.each(cases)(
      'rejects %s with 400 before any database query',
      async (_label, submissionId) => {
        const response = await app.inject({ method: 'GET', url: `/status/${submissionId}` });
        expect(response.statusCode).toBe(400);
        const body = response.json() as { error: { code: string; message: string } };
        expect(body.error.code).toBe('validation_failed');
        expect(body.error.message).toBe('submissionId must be a valid UUID');
        // Rejected at the input-validation boundary: no database query executed.
        expect(db.calls).toEqual([]);
      },
    );
  });

  it('returns 404 for a well-formed UUID with no matching submission', async () => {
    const response = await app.inject({ method: 'GET', url: `/status/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    // The lookup ran (a single read), then correctly reported missing.
    expect(db.calls).toEqual(['getSubmission']);
  });

  it('returns 200 with the submission and result data for an existing submission', async () => {
    const submissionId = randomUUID();
    const result = resultFixture();
    const now = new Date();
    db.setSubmission({
      id: submissionId,
      contractId: null,
      wasmHash: WASM_HASH,
      sourceRepo: SOURCE_REPO,
      sourceRev: 'main',
      buildImage: null,
      status: 'verified',
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: now,
      buildLog: null,
      tarballSha256: null,
      resultId: result.id,
      createdAt: now,
      updatedAt: now,
    });
    db.setResult(result);

    const response = await app.inject({ method: 'GET', url: `/status/${submissionId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      submissionId: string;
      status: string;
      attempts: number;
      result: { status: string } | null;
    };
    expect(body.submissionId).toBe(submissionId);
    expect(body.status).toBe('verified');
    expect(body.attempts).toBe(1);
    expect(body.result?.status).toBe('verified');
    expect(db.calls).toEqual(['getSubmission', 'getResultById']);
  });
});

describe('CORS on public read endpoints', () => {
  it('sets Access-Control-Allow-Origin: * on GET /verifications/:wasmHash', async () => {
    db.setResults([resultFixture()]);
    const response = await app.inject({ method: 'GET', url: `/verifications/${WASM_HASH}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET');
    // Wildcard-only, never credentialed.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('sets Access-Control-Allow-Origin: * on GET /verifications/by-contract/:contractId', async () => {
    db.setResults([resultFixture()]);
    resolveSpy.mockResolvedValueOnce(WASM_HASH);
    const response = await app.inject({
      method: 'GET',
      url: `/verifications/by-contract/${VALID_CONTRACT}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('sets Access-Control-Allow-Origin: * on GET /status/:submissionId, including 404 responses', async () => {
    const response = await app.inject({ method: 'GET', url: `/status/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it.each([
    ['GET /verifications/:wasmHash', `/verifications/${WASM_HASH}`],
    ['GET /verifications/by-contract/:contractId', `/verifications/by-contract/${VALID_CONTRACT}`],
    ['GET /status/:submissionId', '/status/any-id'],
  ])('answers an OPTIONS preflight for %s', async (_label, url) => {
    const response = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://wallet.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET');
    expect(response.headers['access-control-allow-headers']).toBe('content-type');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not send CORS headers on POST /submissions', async () => {
    const response = await app.inject({ method: 'POST', url: '/submissions', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not answer an OPTIONS preflight for POST /submissions with CORS headers', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/submissions',
      headers: {
        origin: 'https://wallet.example.com',
        'access-control-request-method': 'POST',
      },
    });
    // Write routes are same-origin only: unmatched OPTIONS gets no CORS.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS_ALLOWED_ORIGINS restriction', () => {
  const ALLOWED = 'https://wallet.example.com, https://explorer.example.org';
  let restrictedApp: FastifyInstance;

  beforeAll(() => {
    restrictedApp = buildServer(
      { host: '127.0.0.1', port: 0, loggerEnabled: false, corsAllowedOrigins: ALLOWED },
      {
        database: db as unknown as Database,
        store: new ContentStore('/tmp/soroverify-routes-cors-test-store'),
        resolver,
        peerVerifiers: [],
      },
    );
  });

  afterAll(async () => {
    await restrictedApp.close();
  });

  it('echoes the request origin when it is allow-listed', async () => {
    const response = await restrictedApp.inject({
      method: 'GET',
      url: `/verifications/${WASM_HASH}`,
      headers: { origin: 'https://wallet.example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://wallet.example.com');
    // Caches must key on Origin since the echoed header varies per request.
    expect(response.headers.vary).toBe('Origin');
  });

  it('sends no CORS headers for a non-allow-listed origin', async () => {
    const response = await restrictedApp.inject({
      method: 'GET',
      url: `/verifications/${WASM_HASH}`,
      headers: { origin: 'https://evil.example.net' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight only for an allow-listed origin', async () => {
    const denied = await restrictedApp.inject({
      method: 'OPTIONS',
      url: `/verifications/${WASM_HASH}`,
      headers: { origin: 'https://evil.example.net', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await restrictedApp.inject({
      method: 'OPTIONS',
      url: `/verifications/${WASM_HASH}`,
      headers: { origin: 'https://explorer.example.org', 'access-control-request-method': 'GET' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://explorer.example.org');
  });
});
