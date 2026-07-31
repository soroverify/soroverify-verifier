/**
 * RPC resolution: contractId -> currently deployed wasm, and wasm fetch.
 *
 * Soroban's contract code hash is the SHA-256 of the wasm bytes, so both
 * directions of this module are derived from a single primitive: fetching the
 * deployed wasm bytes for a contract or for a wasm hash via rpc.Server
 * (`getContractWasmByContractId` / `getContractWasmByHash`). Confirmed against
 * @stellar/stellar-sdk 16.2.0 — these methods supersede the older
 * `getContractData`-based instance parsing that moved between SDK versions.
 *
 * Failure modes:
 *  - Every failure is reported as an RpcError with a `kind`, so the job queue
 *    can decide between a transient retry ('transient') and a permanent stop
 *    ('not_found'). A contract or hash with no ledger entry is 'not_found'; a
 *    transport or SDK failure is 'transient'.
 */

import { createHash } from 'node:crypto';
import { rpc } from '@stellar/stellar-sdk';

/** Kind of failure reported by the resolver. */
export type RpcErrorKind = 'not_found' | 'transient';

/** A resolution failure with a queue-usable classification. */
export class RpcError extends Error {
  readonly kind: RpcErrorKind;

  constructor(kind: RpcErrorKind, message: string) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
  }
}

export interface ResolverConfig {
  /** Soroban RPC endpoint, e.g. https://soroban-mainnet.stellar.org */
  rpcUrl: string;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

export class Resolver {
  private readonly server: rpc.Server;

  constructor(config: ResolverConfig) {
    this.server = new rpc.Server(config.rpcUrl, { timeout: config.timeoutMs ?? 30_000 });
  }

  /**
   * Resolve the currently deployed wasm hash for a contract id.
   *
   * The hash is the SHA-256 of the deployed wasm bytes, so it is derived by
   * fetching those bytes rather than parsing the contract instance XDR — one
   * primitive, verified end-to-end. Returns lowercase hex. Throws RpcError.
   */
  async resolveWasmHash(contractId: string): Promise<string> {
    let wasm: Buffer;
    try {
      wasm = await this.server.getContractWasmByContractId(contractId);
    } catch (err) {
      throw this.classify(err, `failed to resolve contract ${contractId}`);
    }
    if (wasm.length === 0) {
      throw new RpcError('not_found', `contract ${contractId} has an empty wasm`);
    }
    return createHash('sha256').update(wasm).digest('hex');
  }

  /**
   * Fetch the wasm bytes for a wasm hash (hex or base64). The hash is
   * validated as plausible 32-byte hex/base64 before use. Throws RpcError.
   */
  async fetchWasmByHash(wasmHash: string): Promise<Buffer> {
    const hex = toHex(wasmHash);
    if (hex === null) {
      throw new RpcError('not_found', `wasm hash is not a 32-byte hex/base64 value: ${wasmHash}`);
    }
    try {
      return await this.server.getContractWasmByHash(hex, 'hex');
    } catch (err) {
      throw this.classify(err, `failed to fetch wasm ${hex}`);
    }
  }

  /** Classify an SDK/transport failure into a queue-usable RpcError. */
  private classify(err: unknown, context: string): RpcError {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'NotFoundError') {
      return new RpcError('not_found', `${context}: ${message}`);
    }
    return new RpcError('transient', `${context}: ${message}`);
  }
}

/** Normalize a 32-byte hex/base64 hash to lowercase hex, or null if invalid. */
function toHex(wasmHash: string): string | null {
  if (/^[0-9a-fA-F]{64}$/.test(wasmHash)) {
    return wasmHash.toLowerCase();
  }
  const match = /^[A-Za-z0-9+/]{43}={0,1}$/.exec(wasmHash);
  if (match === null) {
    return null;
  }
  const padded = match[0].length % 4 === 0 ? match[0] : `${match[0]}${'='.repeat(4 - (match[0].length % 4))}`;
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length !== 32) {
    return null;
  }
  return decoded.toString('hex');
}
