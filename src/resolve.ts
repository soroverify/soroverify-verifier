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
 *  - Transient failures are retried in-process with a short delay before they
 *    are ever surfaced. The transport underneath rpc.Server (the SDK's
 *    fetch-based HTTP client on Node's pooled keep-alive connections) can
 *    fail once on a stale socket: a long-running process that reuses an idle
 *    connection the RPC server has silently closed gets `fetch failed`, while
 *    a fresh one-off process always opens a new connection and succeeds. A
 *    bounded retry opens a fresh connection and recovers. 'not_found'
 *    failures are never retried.
 */

import { createHash } from 'node:crypto';
import { NotFoundError, rpc } from '@stellar/stellar-sdk';

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
  /**
   * Total attempts per resolution when the failure is transient (stale
   * connection, timeout, SDK error). Defaults to 3. 'not_found' failures are
   * never retried regardless of this value.
   */
  maxAttempts?: number;
  /** Delay between transient-failure retries, in milliseconds. Defaults to 250. */
  retryDelayMs?: number;
  /**
   * Allow an http:// RPC URL (defaults to false, mirroring rpc.Server's
   * allowHttp). Needed only for local RPC endpoints without TLS.
   */
  allowHttp?: boolean;
}

export class Resolver {
  private readonly server: rpc.Server;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(config: ResolverConfig) {
    this.maxAttempts = config.maxAttempts ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 250;
    this.server = new rpc.Server(config.rpcUrl, {
      timeout: config.timeoutMs ?? 30_000,
      allowHttp: config.allowHttp ?? false,
    });
  }

  /**
   * Resolve the currently deployed wasm hash for a contract id.
   *
   * The hash is the SHA-256 of the deployed wasm bytes, so it is derived by
   * fetching those bytes rather than parsing the contract instance XDR — one
   * primitive, verified end-to-end. Returns lowercase hex. Throws RpcError.
   */
  async resolveWasmHash(contractId: string): Promise<string> {
    const wasm = await this.withTransientRetry(
      () => this.server.getContractWasmByContractId(contractId),
      `failed to resolve contract ${contractId}`,
    );
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
    const hex = normalizeWasmHashHex(wasmHash);
    if (hex === null) {
      throw new RpcError('not_found', `wasm hash is not a 32-byte hex/base64 value: ${wasmHash}`);
    }
    return this.withTransientRetry(
      () => this.server.getContractWasmByHash(hex, 'hex'),
      `failed to fetch wasm ${hex}`,
    );
  }

  /**
   * Cheap reachability check for GET /ready: the RPC server's own
   * `getHealth` JSON-RPC method, not a full request against contract data.
   * Deliberately makes a single attempt with no transient retry, unlike the
   * resolution methods above: a readiness probe should reflect the current
   * state of the dependency, not mask a real outage behind an in-process
   * retry loop. Throws on failure.
   */
  async checkHealth(): Promise<void> {
    await this.server.getHealth();
  }

  /**
   * Run an RPC operation, retrying only transient failures with a short delay
   * between attempts. A stale pooled keep-alive connection fails once and then
   * a fresh connection succeeds, so a bounded retry heals the common
   * intermittent `fetch failed` without burning the job queue's retry budget.
   * Permanent 'not_found' failures are never retried.
   */
  private async withTransientRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        const rpcError = this.classify(err, context);
        if (rpcError.kind !== 'transient' || attempt >= this.maxAttempts) {
          throw rpcError;
        }
        await sleep(this.retryDelayMs);
      }
    }
  }

  /** Classify an SDK/transport failure into a queue-usable RpcError. */
  private classify(err: unknown, context: string): RpcError {
    return new RpcError(
      isNotFound(err) ? 'not_found' : 'transient',
      `${context}: ${errorMessage(err)}`,
    );
  }
}

/**
 * True when the failure means the requested contract/wasm does not exist on
 * the network, which is permanent and must never be retried. The RPC path of
 * @stellar/stellar-sdk rejects missing ledger entries with a plain
 * `{ code: 404, message }` object (not an Error instance), and the legacy
 * Horizon path throws a NotFoundError. Both mean "not found".
 *
 * The name property cannot identify the error: the SDK's transpiled classes
 * all report `name === 'Error'`, so the instanceof check is the reliable one.
 */
function isNotFound(err: unknown): boolean {
  if (err instanceof NotFoundError) {
    return true;
  }
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 404;
}

/** Best-effort message for any rejection shape the SDK can throw. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Canonicalize a 32-byte wasm hash to lowercase hex (hex stays hex, base64 is
 * decoded and re-encoded as hex), or null when the value is not a plausible
 * 32-byte hex/base64 encoding. Every part of the service that keys on wasm
 * hashes uses this so one byte value has exactly one spelling.
 */
export function normalizeWasmHashHex(wasmHash: string): string | null {
  if (/^[0-9a-fA-F]{64}$/.test(wasmHash)) {
    return wasmHash.toLowerCase();
  }
  const match = /^[A-Za-z0-9+/]{43}={0,1}$/.exec(wasmHash);
  if (match === null) {
    return null;
  }
  const padded =
    match[0].length % 4 === 0 ? match[0] : `${match[0]}${'='.repeat(4 - (match[0].length % 4))}`;
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length !== 32) {
    return null;
  }
  return decoded.toString('hex');
}
