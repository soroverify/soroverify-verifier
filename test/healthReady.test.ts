/**
 * GET /health (pure liveness) and GET /ready (dependency-aware readiness).
 *
 * /health must stay a reliable liveness signal even when every dependency is
 * down, so it must never touch the database or RPC at all. /ready is the
 * opposite: it must genuinely check both, and report exactly which one
 * failed, never a bare 503. These tests exercise both through the real
 * Fastify routing.
 *
 * The database is an in-memory fake whose ping() can be told to fail; the
 * RPC dependency is a real Resolver with its underlying rpc.Server.getHealth
 * spied on, the same pattern test/resolve.test.ts uses. Nothing here touches
 * a real Postgres or a live RPC endpoint.
 */
import { rpc } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { buildServer, type ServerDependencies } from '../src/index.js';
import { Resolver } from '../src/resolve.js';
import { ContentStore } from '../src/store.js';

/** In-memory Database stand-in whose ping() can be made to fail on demand. */
class FakeDatabase {
  pingError: Error | null = null;

  async ping(): Promise<void> {
    if (this.pingError !== null) {
      throw this.pingError;
    }
  }

  async close(): Promise<void> {}
}

/** Real Resolver with its private rpc.Server.getHealth spied on (never a live RPC call). */
function makeResolver() {
  const resolver = new Resolver({ rpcUrl: 'https://rpc.invalid' });
  const server = (resolver as unknown as { server: rpc.Server }).server;
  return { resolver, getHealth: vi.spyOn(server, 'getHealth') };
}

async function buildTestApp(db: FakeDatabase, resolver: Resolver): Promise<FastifyInstance> {
  const deps: ServerDependencies = {
    database: db as unknown as Database,
    store: new ContentStore('/tmp/soroverify-health-ready-test-store'),
    resolver,
    peerVerifiers: [],
    maxActiveSubmissions: 1000,
  };
  return buildServer({ host: '127.0.0.1', port: 0, loggerEnabled: false }, deps);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /health', () => {
  it('returns 200 even when the database is deliberately unreachable', async () => {
    const db = new FakeDatabase();
    db.pingError = new Error('connection refused');
    const { resolver, getHealth } = makeResolver();
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      // Genuinely dependency-free: neither check ran.
      expect(getHealth).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 200 even when the RPC endpoint is deliberately unreachable', async () => {
    const db = new FakeDatabase();
    const { resolver, getHealth } = makeResolver();
    getHealth.mockRejectedValue(new TypeError('fetch failed'));
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(getHealth).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /ready', () => {
  it('returns 503 naming the database when only the database is unreachable', async () => {
    const db = new FakeDatabase();
    db.pingError = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const { resolver, getHealth } = makeResolver();
    getHealth.mockResolvedValue({
      status: 'healthy',
      latestLedger: 1,
      oldestLedger: 1,
      ledgerRetentionWindow: 1,
    });
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: {
          database: { ok: boolean; error?: string };
          stellarRpc: { ok: boolean; error?: string };
        };
      };
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.ok).toBe(false);
      expect(body.checks.database.error).toContain('ECONNREFUSED');
      // The specific failing dependency is named; the healthy one is too.
      expect(body.checks.stellarRpc.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 503 naming stellar_rpc when only the RPC endpoint is unreachable', async () => {
    const db = new FakeDatabase();
    const { resolver, getHealth } = makeResolver();
    getHealth.mockRejectedValue(new TypeError('fetch failed'));
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: {
          database: { ok: boolean; error?: string };
          stellarRpc: { ok: boolean; error?: string };
        };
      };
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.stellarRpc.ok).toBe(false);
      expect(body.checks.stellarRpc.error).toContain('fetch failed');
    } finally {
      await app.close();
    }
  });

  it('returns 503 naming both when both dependencies are unreachable', async () => {
    const db = new FakeDatabase();
    db.pingError = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const { resolver, getHealth } = makeResolver();
    getHealth.mockRejectedValue(new TypeError('fetch failed'));
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: { database: { ok: boolean }; stellarRpc: { ok: boolean } };
      };
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.ok).toBe(false);
      expect(body.checks.stellarRpc.ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 200 when both dependencies are genuinely healthy', async () => {
    const db = new FakeDatabase();
    const { resolver, getHealth } = makeResolver();
    getHealth.mockResolvedValue({
      status: 'healthy',
      latestLedger: 1,
      oldestLedger: 1,
      ledgerRetentionWindow: 1,
    });
    const app = await buildTestApp(db, resolver);
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        status: string;
        checks: { database: { ok: boolean }; stellarRpc: { ok: boolean } };
      };
      expect(body.status).toBe('ready');
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.stellarRpc.ok).toBe(true);
      expect(getHealth).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
