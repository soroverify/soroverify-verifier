/**
 * Resolver RPC retry and failure-classification tests.
 *
 * The resolver is the only module that talks to Soroban RPC, and the
 * long-running server's intermittent `fetch failed` bug lives here: the SDK's
 * fetch-based HTTP client reuses pooled keep-alive connections, and a
 * connection the RPC server has silently closed fails once before a fresh
 * connection succeeds. These tests pin the recovery behavior — bounded retry
 * of transient failures with a short delay, never retrying permanent
 * not-found results — against the real rpc.Server transport by spying on the
 * SDK's RPC methods, so no live RPC is required.
 */

import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError, StrKey, rpc } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWasmHashHex, Resolver, type ResolverConfig } from '../src/resolve.js';

/** A syntactically valid contract id; the RPC calls are mocked, not executed. */
const CONTRACT_ID = StrKey.encodeContract(randomBytes(32));
const WASM_BYTES = Buffer.from('fake wasm bytes for resolver tests');
const WASM_HASH = createHash('sha256').update(WASM_BYTES).digest('hex');

/** The SDK's RPC-path rejection for a missing ledger entry (plain object). */
const SDK_NOT_FOUND = { code: 404, message: 'Could not obtain contract wasm from server' };
/** A transport failure like Node's global fetch reports on a dead socket. */
const FETCH_FAILED = new TypeError('fetch failed');

/**
 * Build a Resolver with spies on its internal rpc.Server methods. The server
 * field is private; the cast reaches it only because TS private is a
 * compile-time check, not a runtime one.
 */
function makeResolver(overrides: Partial<ResolverConfig> = {}) {
  const resolver = new Resolver({ rpcUrl: 'https://rpc.invalid', retryDelayMs: 0, ...overrides });
  const server = (resolver as unknown as { server: rpc.Server }).server;
  return {
    resolver,
    getContractWasmByContractId: vi.spyOn(server, 'getContractWasmByContractId'),
    getContractWasmByHash: vi.spyOn(server, 'getContractWasmByHash'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Resolver transient-failure retry', () => {
  it('retries a stale-connection failure once and succeeds on the fresh connection', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver();
    // Exactly the observed failure: one `fetch failed` on a reused pooled
    // connection, then the next attempt opens a fresh connection and works.
    getContractWasmByContractId
      .mockRejectedValueOnce(FETCH_FAILED)
      .mockResolvedValueOnce(WASM_BYTES);

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).resolves.toBe(WASM_HASH);
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(2);
    expect(getContractWasmByContractId).toHaveBeenCalledWith(CONTRACT_ID);
  });

  it('retries at most maxAttempts times, then reports the transient failure', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver({ maxAttempts: 3 });
    getContractWasmByContractId.mockRejectedValue(FETCH_FAILED);

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).rejects.toMatchObject({
      kind: 'transient',
    });
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts: 1 (retry disabled) for operators who opt out', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver({ maxAttempts: 1 });
    getContractWasmByContractId.mockRejectedValue(FETCH_FAILED);

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).rejects.toMatchObject({
      kind: 'transient',
    });
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(1);
  });

  it('retries fetchWasmByHash the same way, passing the normalized lowercase hex', async () => {
    const { resolver, getContractWasmByHash } = makeResolver();
    getContractWasmByHash
      .mockRejectedValueOnce(FETCH_FAILED)
      .mockResolvedValueOnce(WASM_BYTES);

    await expect(resolver.fetchWasmByHash(WASM_HASH.toUpperCase())).resolves.toEqual(WASM_BYTES);
    expect(getContractWasmByHash).toHaveBeenCalledTimes(2);
    expect(getContractWasmByHash).toHaveBeenCalledWith(WASM_HASH, 'hex');
  });

  it('never retries a NotFoundError (permanent)', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver();
    // The real SDK class: name is 'Error' on the transpiled classes, so only
    // the instanceof branch can recognize it.
    getContractWasmByContractId.mockRejectedValue(new NotFoundError('contract not found', null));

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(1);
  });

  it('never retries the SDK RPC path\u2019s plain-object 404 rejection (missing ledger entry)', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver();
    getContractWasmByContractId.mockRejectedValue(SDK_NOT_FOUND);

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('Could not obtain contract wasm from server'),
    });
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(1);
  });

  it('reports an empty wasm as not_found without retrying', async () => {
    const { resolver, getContractWasmByContractId } = makeResolver();
    getContractWasmByContractId.mockResolvedValue(Buffer.alloc(0));

    await expect(resolver.resolveWasmHash(CONTRACT_ID)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed wasm hash as not_found before any RPC call', async () => {
    const { resolver, getContractWasmByHash } = makeResolver();

    await expect(resolver.fetchWasmByHash('not-a-hash')).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(getContractWasmByHash).not.toHaveBeenCalled();
  });
});

describe('normalizeWasmHashHex', () => {
  it('lowercases uppercase hex', () => {
    expect(normalizeWasmHashHex('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('decodes base64 to canonical hex', () => {
    const bytes = randomBytes(32);
    expect(normalizeWasmHashHex(bytes.toString('base64'))).toBe(bytes.toString('hex'));
  });

  it('rejects values that are not a plausible 32-byte hex/base64 encoding', () => {
    expect(normalizeWasmHashHex('z'.repeat(64))).toBeNull(); // not hex
    expect(normalizeWasmHashHex('a'.repeat(63))).toBeNull(); // wrong length
    expect(normalizeWasmHashHex(`${'A'.repeat(43)}!`)).toBeNull(); // bad base64 char
    expect(normalizeWasmHashHex(Buffer.alloc(16).toString('base64'))).toBeNull(); // 16 bytes
  });
});
