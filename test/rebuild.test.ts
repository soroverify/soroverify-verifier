/**
 * Rebuild isolation and timeout tests (build sequence step 13).
 *
 * runRebuild is the highest-stakes path in the service: it constructs the
 * exact docker create argument list that isolates a build. These tests pin
 * every load-bearing property against the exec layer itself — allowlist
 * gating, no host bind mounts, --network none, resource limits, the
 * wall-clock timeout kill, RUSTUP_TOOLCHAIN pinning, unconditional container
 * cleanup, and the argument-array-only exec contract — using the injectable
 * CommandExecutor exactly as the design intends (no real Docker anywhere).
 *
 * The executor records every invocation and lets each test script responses
 * per docker subcommand ('create', 'cp', 'start', 'wait', 'logs', 'kill',
 * 'rm'), so assertions are made on the exact argument lists the container
 * host would receive.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runRebuild,
  sha256Hex,
  type CommandExecutor,
  type CommandResult,
  type RebuildConfig,
  type RebuildOutcome,
  type RebuildRequest,
} from '../src/rebuild.js';

/** A digest-pinned image used everywhere the allowlist is configured. */
const BUILD_IMAGE = `ghcr.io/soroverify/verify@sha256:${'a'.repeat(64)}`;
/** The container id docker create is scripted to return. */
const CONTAINER_ID = 'container-abc';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'soroverify-rebuild-test-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function result(
  exitCode: number,
  stdout: Buffer = Buffer.alloc(0),
  stderr: Buffer = Buffer.alloc(0),
  timedOut = false,
): CommandResult {
  return { exitCode, stdout, stderr, timedOut };
}

/** One recorded exec call. */
interface RecordedCall {
  command: string;
  args: string[];
  opts?: { timeoutMs?: number };
}

/**
 * Injectable CommandExecutor that records every call and lets each test
 * script per-subcommand responses (first matching handler wins; the default
 * is a clean exit 0 with empty output).
 */
class RecordingExecutor implements CommandExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: ((args: string[]) => CommandResult | null)[] = [];

  handle(handler: (args: string[]) => CommandResult | null): void {
    this.handlers.push(handler);
  }

  async exec(
    command: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    this.calls.push({ command, args, opts });
    for (const handler of this.handlers) {
      const handled = handler(args);
      if (handled !== null) {
        return handled;
      }
    }
    return result(0);
  }
}

function makeConfig(overrides: Partial<RebuildConfig> = {}): RebuildConfig {
  return {
    allowedBuildImages: new Set([BUILD_IMAGE]),
    verifyImage: 'soroverify/verify-image:test',
    workDir,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RebuildRequest> = {}): RebuildRequest {
  return {
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    attempt: 1,
    buildImage: BUILD_IMAGE,
    rustVersion: null,
    sourceTarball: Buffer.from('fake source tarball'),
    buildArgs: ['contract', 'build'],
    buildOptions: [],
    metaEntries: [],
    ...overrides,
  };
}

/** Script a clean run: create -> cp -> start -> wait 0 -> logs -> rm. */
function scriptHappyPath(exec: RecordingExecutor, containerId = CONTAINER_ID): void {
  exec.handle((args) => (args[0] === 'create' ? result(0, Buffer.from(containerId)) : null));
  exec.handle((args) => (args[0] === 'cp' ? result(0) : null));
  exec.handle((args) => (args[0] === 'start' ? result(0) : null));
  exec.handle((args) => (args[0] === 'wait' ? result(0, Buffer.from('0')) : null));
  exec.handle((args) => (args[0] === 'logs' ? result(0, Buffer.from('build log output')) : null));
  exec.handle((args) => (args[0] === 'rm' ? result(0) : null));
}

/** The docker create invocation's arguments, or fail the test when absent. */
function createArgs(exec: RecordingExecutor): string[] {
  const call = exec.calls.find((c) => c.args[0] === 'create');
  if (call === undefined) {
    throw new Error(`no docker create call recorded; calls=${JSON.stringify(exec.calls)}`);
  }
  return call.args;
}

/** A recorded invocation of a docker subcommand, or fail the test when absent. */
function findCall(exec: RecordingExecutor, subcommand: string): RecordedCall {
  const call = exec.calls.find((c) => c.args[0] === subcommand);
  if (call === undefined) {
    throw new Error(`no docker ${subcommand} call recorded; calls=${JSON.stringify(exec.calls)}`);
  }
  return call;
}

/** Narrow a RebuildOutcome to the 'error' variant (fails the test otherwise). */
function asError(outcome: RebuildOutcome): Extract<RebuildOutcome, { status: 'error' }> {
  if (outcome.status !== 'error') {
    throw new Error(`expected status 'error', got '${outcome.status}'`);
  }
  return outcome;
}

/** Narrow a RebuildOutcome to the 'success' variant (fails the test otherwise). */
function asSuccess(outcome: RebuildOutcome): Extract<RebuildOutcome, { status: 'success' }> {
  if (outcome.status !== 'success') {
    throw new Error(`expected status 'success', got '${outcome.status}'`);
  }
  return outcome;
}

describe('runRebuild isolation and timeout', () => {
  describe('bldimg allowlist enforcement', () => {
    it('rejects a digest-pinned image not on the allowlist before any container is created', async () => {
      const exec = new RecordingExecutor();
      const other = `docker.io/library/nginx@sha256:${'b'.repeat(64)}`;
      const outcome = await runRebuild(exec, makeConfig(), makeRequest({ buildImage: other }));
      expect(outcome.status).toBe('rejected');
      expect(outcome.buildLog).toBe('');
      // Permanent, not retryable — and docker was never even invoked.
      expect(exec.calls).toEqual([]);
    });

    it('rejects a tag-only image reference (not digest-pinned)', async () => {
      const exec = new RecordingExecutor();
      const outcome = await runRebuild(exec, makeConfig(), makeRequest({ buildImage: 'ubuntu:latest' }));
      expect(outcome.status).toBe('rejected');
      expect(exec.calls).toEqual([]);
    });

    it('fails closed when the allowlist is unconfigured (empty)', async () => {
      const exec = new RecordingExecutor();
      const outcome = await runRebuild(
        exec,
        makeConfig({ allowedBuildImages: new Set() }),
        makeRequest(),
      );
      expect(outcome.status).toBe('rejected');
      expect(exec.calls).toEqual([]);
    });
  });

  describe('no host bind mounts', () => {
    it('creates the container without -v / --volume / --mount and moves data via docker cp', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      const outcome = await runRebuild(exec, makeConfig(), makeRequest());
      expect(outcome.status).toBe('success');

      const args = createArgs(exec);
      expect(args).not.toContain('-v');
      expect(args).not.toContain('--volume');
      expect(args).not.toContain('--mount');
      expect(args.some((arg) => arg.startsWith('-v='))).toBe(false);
      expect(args.some((arg) => arg.startsWith('--volume='))).toBe(false);
      expect(args.some((arg) => arg.startsWith('--mount='))).toBe(false);

      // Source in, rebuilt wasm out — both via docker cp, never a mount.
      const cpIn = exec.calls.find(
        (c) => c.args[0] === 'cp' && c.args[2] === `${CONTAINER_ID}:/tmp/src.tar.gz`,
      );
      const cpOut = exec.calls.find(
        (c) => c.args[0] === 'cp' && c.args[1] === `${CONTAINER_ID}:/source/target/wasm32v1-none/release`,
      );
      expect(cpIn).toBeDefined();
      expect(cpOut).toBeDefined();
    });
  });

  describe('network isolation', () => {
    it('runs the build container with --network none (zero egress)', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      const outcome = await runRebuild(exec, makeConfig(), makeRequest());
      expect(outcome.status).toBe('success');

      const args = createArgs(exec);
      const index = args.indexOf('--network');
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe('none');
    });
  });

  describe('resource limits', () => {
    it('applies the defaults: 2 CPUs, 2 GiB memory with swap disabled, 512 pids', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      await runRebuild(exec, makeConfig(), makeRequest());

      const args = createArgs(exec);
      const memoryIndex = args.indexOf('--memory');
      const swapIndex = args.indexOf('--memory-swap');
      expect(memoryIndex).toBeGreaterThan(-1);
      expect(swapIndex).toBeGreaterThan(-1);
      // Swap is set equal to memory: disabled entirely, not merely capped.
      expect(args[memoryIndex + 1]).toBe('2147483648');
      expect(args[swapIndex + 1]).toBe(args[memoryIndex + 1]);

      const cpusIndex = args.indexOf('--cpus');
      expect(cpusIndex).toBeGreaterThan(-1);
      expect(args[cpusIndex + 1]).toBe('2');

      const pidsIndex = args.indexOf('--pids-limit');
      expect(pidsIndex).toBeGreaterThan(-1);
      expect(args[pidsIndex + 1]).toBe('512');
    });

    it('honors explicit RebuildConfig overrides and passes them through', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      await runRebuild(
        exec,
        makeConfig({ cpus: 4, memoryBytes: 1024 ** 3, pidsLimit: 256 }),
        makeRequest(),
      );

      const args = createArgs(exec);
      const memoryIndex = args.indexOf('--memory');
      const swapIndex = args.indexOf('--memory-swap');
      expect(memoryIndex).toBeGreaterThan(-1);
      expect(swapIndex).toBeGreaterThan(-1);
      expect(args[memoryIndex + 1]).toBe(String(1024 ** 3));
      expect(args[swapIndex + 1]).toBe(args[memoryIndex + 1]);

      const cpusIndex = args.indexOf('--cpus');
      expect(cpusIndex).toBeGreaterThan(-1);
      expect(args[cpusIndex + 1]).toBe('4');

      const pidsIndex = args.indexOf('--pids-limit');
      expect(pidsIndex).toBeGreaterThan(-1);
      expect(args[pidsIndex + 1]).toBe('256');
    });
  });

  describe('wall-clock timeout', () => {
    it('kills the container, reports a timeout error, and preserves the build log', async () => {
      const exec = new RecordingExecutor();
      exec.handle((args) => (args[0] === 'create' ? result(0, Buffer.from(CONTAINER_ID)) : null));
      exec.handle((args) => (args[0] === 'cp' ? result(0) : null));
      exec.handle((args) => (args[0] === 'start' ? result(0) : null));
      exec.handle(
        (args) => (args[0] === 'wait' ? result(0, Buffer.alloc(0), Buffer.alloc(0), true) : null),
      );
      exec.handle(
        (args) => (args[0] === 'logs' ? result(0, Buffer.from('partial build output before kill')) : null),
      );
      exec.handle((args) => (args[0] === 'kill' ? result(0) : null));
      exec.handle((args) => (args[0] === 'rm' ? result(0) : null));

      const buildTimeoutMs = 5_000;
      const outcome = await runRebuild(exec, makeConfig({ buildTimeoutMs }), makeRequest());
      expect(outcome.status).toBe('error');
      const err = asError(outcome);

      // The container was killed with the id docker create returned.
      const killCall = findCall(exec, 'kill');
      expect(killCall.args[1]).toBe(CONTAINER_ID);
      // The wall-clock bound was passed through to docker wait.
      const waitCall = findCall(exec, 'wait');
      expect(waitCall.opts?.timeoutMs).toBe(buildTimeoutMs);
      // Timeout is recorded as an error outcome with an explicit reason.
      expect(err.reason).toContain('timeout');
      // The build log captured before the kill is preserved, not lost.
      expect(err.buildLog).toContain('partial build output before kill');
      // Cleanup still ran.
      const rmCall = findCall(exec, 'rm');
      expect(rmCall.args).toEqual(['rm', '-f', CONTAINER_ID]);
    });
  });

  describe('successful rebuild', () => {
    it('proceeds through wait 0, hashes the rebuilt wasm, and reports success', async () => {
      const submissionId = 'happy-path-submission';
      const wasmBytes = Buffer.from('rebuilt wasm bytes for hash comparison');
      const releaseDir = join(workDir, submissionId, 'out', 'target', 'wasm32v1-none', 'release');
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, 'contract.wasm'), wasmBytes);

      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      const outcome = await runRebuild(exec, makeConfig(), makeRequest({ submissionId }));
      const ok = asSuccess(outcome);

      expect(ok.rebuiltArtifacts).toEqual([
        { name: 'contract.wasm', hash: sha256Hex(wasmBytes) },
      ]);
      expect(ok.buildLog).toContain('build log output');
      // The container was removed after the successful run.
      const rmCall = findCall(exec, 'rm');
      expect(rmCall.args).toEqual(['rm', '-f', CONTAINER_ID]);
    });

    it('reports an error when the build fails inside the container and still cleans up', async () => {
      const exec = new RecordingExecutor();
      exec.handle((args) => (args[0] === 'create' ? result(0, Buffer.from(CONTAINER_ID)) : null));
      exec.handle((args) => (args[0] === 'cp' ? result(0) : null));
      exec.handle((args) => (args[0] === 'start' ? result(0) : null));
      exec.handle((args) => (args[0] === 'wait' ? result(0, Buffer.from('1')) : null));
      exec.handle((args) => (args[0] === 'logs' ? result(0, Buffer.from('compile error log')) : null));
      exec.handle((args) => (args[0] === 'rm' ? result(0) : null));

      const outcome = await runRebuild(exec, makeConfig(), makeRequest());
      expect(outcome.status).toBe('error');
      const err = asError(outcome);

      expect(err.reason).toContain('build failed inside container');
      expect(err.buildLog).toContain('compile error log');
      // The failed container was still removed.
      const rmCall = findCall(exec, 'rm');
      expect(rmCall.args).toEqual(['rm', '-f', CONTAINER_ID]);
    });
  });

  describe('RUSTUP_TOOLCHAIN pinning', () => {
    it('passes --env RUSTUP_TOOLCHAIN=<rustVersion> when rustVersion is set', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      await runRebuild(exec, makeConfig(), makeRequest({ rustVersion: '1.85.0' }));

      const args = createArgs(exec);
      const envIndex = args.indexOf('--env');
      expect(envIndex).toBeGreaterThan(-1);
      expect(args[envIndex + 1]).toBe('RUSTUP_TOOLCHAIN=1.85.0');
    });

    it('omits the flag entirely when rustVersion is null (never an empty value)', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      await runRebuild(exec, makeConfig(), makeRequest({ rustVersion: null }));

      const args = createArgs(exec);
      expect(args).not.toContain('--env');
      expect(args.some((arg) => arg.startsWith('RUSTUP_TOOLCHAIN='))).toBe(false);
    });
  });

  describe('argument-array exec only', () => {
    it('invokes every external command as (executable, string array), never a concatenated shell string', async () => {
      const exec = new RecordingExecutor();
      scriptHappyPath(exec);
      await runRebuild(exec, makeConfig(), makeRequest());

      expect(exec.calls.length).toBeGreaterThan(0);
      for (const call of exec.calls) {
        // A single executable token, never a full shell command line.
        expect(typeof call.command).toBe('string');
        expect(call.command).toBe('docker');
        expect(call.command).not.toMatch(/\s/);
        // Arguments arrive as a non-empty array of strings — the shape that
        // makes shell-string concatenation impossible at the call site.
        expect(Array.isArray(call.args)).toBe(true);
        expect(call.args.length).toBeGreaterThan(0);
        expect(call.args.every((arg) => typeof arg === 'string')).toBe(true);
      }
    });
  });
});
