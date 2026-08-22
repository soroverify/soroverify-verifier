/**
 * Isolated container rebuild (SEP-58 replay) and source fetch.
 *
 * The upstream `stellar contract build verify` subcommand (stellar-cli #2525)
 * is not present in the released CLI (27.0.0 as of this writing) — verified
 * against the installed tool's `--help`, per the spec's own instruction to
 * trust the installed CLI over this document. This module therefore
 * implements the SEP-58 Appendix-A replay procedure directly, which is exactly
 * what that subcommand performs internally: run the wasm's recorded `bldimg`
 * container with the recorded `bldarg`/`bldopt` arguments (plus every
 * replayable meta entry passed back via `--meta` so the rebuilt
 * `contractmetav0` section is byte-identical), then hash the rebuilt wasms
 * and compare against the deployed hash in compare.ts.
 *
 * Security model:
 *  - The build image comes only from the wasm's `bldimg` meta and must be on
 *    an explicit allowlist of digest-pinned references this service vets
 *    (fail-closed when unconfigured). This closes the upstream gap where the
 *    CLI accepts any image.
 *  - No host bind mounts on the build path: the source archive is copied in
 *    and the rebuilt wasm copied out via `docker cp` (black-box), never a
 *    mounted directory.
 *  - Every docker/git invocation is argument-array exec; untrusted values are
 *    passed as positional arguments to a static entrypoint script, never
 *    interpolated into a shell string.
 *  - Containers are removed after every job, never reused.
 *  - The build container runs with `--network none` (zero egress), a hard
 *    wall-clock timeout (the container is killed when it trips), and CPU /
 *    memory / process-count limits. A submission that never finishes cannot
 *    block the queue forever.
 *  - The wasm's recorded rust version (rsver) is pinned into the container as
 *    RUSTUP_TOOLCHAIN so an in-source rust-toolchain.toml cannot silently
 *    swap the toolchain mid-build (SEP-58).
 *
 * Failure modes:
 *  - fetchSourceTarball returns { status: 'error' } on clone/checkout failure
 *    with the captured log; it never throws.
 *  - runRebuild returns 'rejected' for a build image outside the allowlist
 *    (permanent — the job must not be retried), 'error' for environment or
 *    build failures (retryable), and 'success' with the rebuilt wasm hashes
 *    when the build completed.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetaEntry } from './meta.js';

/** Result of one external command (docker, git, ...). */
export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  /** True when the command was killed by its wall-clock timeout. */
  timedOut: boolean;
}

/** Injectable process execution (argument-array only — never a shell string). */
export interface CommandExecutor {
  exec(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
}

/** Real executor over child_process.execFile. */
export class ChildProcessExecutor implements CommandExecutor {
  async exec(
    command: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    const maxBuffer = 512 * 1024 * 1024; // wasm trees can be large
    return new Promise<CommandResult>((resolve) => {
      // encoding: 'buffer' is load-bearing: execFile defaults to utf8, which
      // would corrupt binary stdout (e.g. the source tarball).
      execFile(
        command,
        args,
        {
          maxBuffer,
          timeout: opts?.timeoutMs ?? 0,
          killSignal: 'SIGKILL',
          windowsHide: true,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }
          const timedOut = error.killed === true;
          const code = typeof error.code === 'number' ? error.code : 1;
          resolve({ exitCode: code, stdout, stderr, timedOut });
        },
      );
    });
  }
}

/** Configuration shared by the fetch and rebuild steps. */
export interface RebuildConfig {
  /** Digest-pinned build images this service vets. Fail-closed when empty. */
  allowedBuildImages: ReadonlySet<string>;
  /** Image used for the source-fetch step (docker/verify-image). */
  verifyImage: string;
  /** Scratch directory for tarballs and extracted artifacts. */
  workDir?: string;
  /** Wall-clock limit for one rebuild, in ms. Defaults to 10 minutes. */
  buildTimeoutMs?: number;
  /** Wall-clock limit for the source fetch, in ms. Defaults to 5 minutes. */
  fetchTimeoutMs?: number;
  /** CPU limit for the build container. Defaults to 2. */
  cpus?: number;
  /** Memory limit for the build container, in bytes. Defaults to 2 GiB. */
  memoryBytes?: number;
  /** Max processes inside the build container. Defaults to 512. */
  pidsLimit?: number;
}

/**
 * Parse the ALLOWED_BUILD_IMAGES environment value (comma-separated,
 * digest-pinned image references) into a set. Empty/unset yields an empty
 * set — the service then rejects every build, which is the fail-closed
 * default until an operator configures the allowlist.
 */
export function parseBuildImageAllowlist(raw: string | undefined): Set<string> {
  const allowlist = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      allowlist.add(trimmed);
    }
  }
  return allowlist;
}

/**
 * Gate a build image. The image must be digest-pinned and on the allowlist;
 * a tag-only reference is rejected outright because a mutable tag defeats the
 * reproducibility guarantee.
 */
export function isAllowedBuildImage(
  image: string,
  allowlist: ReadonlySet<string>,
): { allowed: true } | { allowed: false; reason: string } {
  if (!/^[^\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
    return { allowed: false, reason: `build image is not digest-pinned: ${image}` };
  }
  if (!allowlist.has(image)) {
    return { allowed: false, reason: `build image is not on the allowlist: ${image}` };
  }
  return { allowed: true };
}

export interface FetchRequest {
  repo: string;
  rev: string;
}

export type FetchOutcome =
  { status: 'success'; tarball: Buffer } | { status: 'error'; reason: string; log: string };

/** Static script for the fetch container; repo/rev arrive as $1/$2 (argv). */
const FETCH_SCRIPT =
  'git clone --filter=blob:none "$1" /src || git clone "$1" /src; ' +
  'git -C /src checkout --detach "$2" && tar -czf - --exclude=.git -C /src .';

/**
 * Fetch and archive a source tree inside an ephemeral container, returning
 * the gzip tarball on stdout. The container has network egress — this is the
 * initial source fetch, the only allowed egress in the whole pipeline — but it
 * contains no secrets, runs only the static script above with the repo and
 * rev as positional arguments, and is destroyed by --rm.
 */
export async function fetchSourceTarball(
  exec: CommandExecutor,
  config: RebuildConfig,
  request: FetchRequest,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const result = await exec.exec(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      '/bin/sh',
      config.verifyImage,
      '-c',
      FETCH_SCRIPT,
      'sh',
      request.repo,
      request.rev,
    ],
    { timeoutMs },
  );
  const log = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
  if (result.timedOut) {
    return { status: 'error', reason: 'source fetch exceeded its wall-clock timeout', log };
  }
  if (result.exitCode !== 0) {
    return { status: 'error', reason: `source fetch failed (exit ${result.exitCode})`, log };
  }
  if (result.stdout.length === 0) {
    return { status: 'error', reason: 'source fetch produced an empty archive', log };
  }
  return { status: 'success', tarball: result.stdout };
}

export interface RebuildRequest {
  submissionId: string;
  attempt: number;
  /** The wasm's bldimg value (already validated against the allowlist). */
  buildImage: string;
  /** The wasm's recorded rust version (rsver), pinned as RUSTUP_TOOLCHAIN. */
  rustVersion: string | null;
  /** The source tarball produced by fetchSourceTarball. */
  sourceTarball: Buffer;
  /** Recorded build arguments (bldarg), default ['contract','build']. */
  buildArgs: string[];
  /** Recorded build options (bldopt / bldopt_*), replayed verbatim. */
  buildOptions: string[];
  /** Every meta entry from the target wasm, for --meta replay. */
  metaEntries: readonly MetaEntry[];
}

export type RebuildOutcome =
  | { status: 'success'; rebuiltArtifacts: { name: string; hash: string }[]; buildLog: string }
  | { status: 'error'; reason: string; buildLog: string }
  | { status: 'rejected'; reason: string; buildLog: string };

/**
 * Meta keys that were recorded via `--meta` on the original build command and
 * must therefore be passed back through `--meta` so the rebuilt
 * contractmetav0 section is byte-identical. rsver/rssdkver/cliver are
 * toolchain-derived and are reproduced by the pinned build image itself.
 */
const REPLAYABLE_META_KEYS: ReadonlySet<string> = new Set([
  'bldimg',
  'bldopt',
  'bldarg',
  'bldopt_manifest_path',
  'bldopt_package',
  'bldopt_profile',
  'bldopt_optimize',
  'source_repo',
  'source_rev',
  'source_sha256',
  'source_uri',
]);

/**
 * Rebuild the submitted source in an isolated container and hash the rebuilt
 * wasms. The container is created, the source archive copied in, started,
 * waited on, and its outputs copied out; the container is removed in every
 * path. Comparison against the deployed hash happens in compare.ts.
 */
export async function runRebuild(
  exec: CommandExecutor,
  config: RebuildConfig,
  request: RebuildRequest,
): Promise<RebuildOutcome> {
  const allowed = isAllowedBuildImage(request.buildImage, config.allowedBuildImages);
  if (!allowed.allowed) {
    return { status: 'rejected', reason: allowed.reason, buildLog: '' };
  }

  const containerName = sanitizeContainerName(
    `soroverify-${request.submissionId}-${request.attempt}`,
  );
  const jobDir = join(config.workDir ?? '/tmp/soroverify', request.submissionId);
  const tarballPath = join(jobDir, 'source.tar.gz');
  const outDir = join(jobDir, 'out');

  const metaArgs: string[] = [];
  for (const entry of request.metaEntries) {
    if (REPLAYABLE_META_KEYS.has(entry.key)) {
      metaArgs.push('--meta', `${entry.key}=${entry.value}`);
    }
  }

  // Static entrypoint: extract the copied archive into /source, then exec the
  // recorded build command. Untrusted arguments arrive as "$@" (argv), never
  // inside the script. The 'sh' placeholder after the script becomes $0 so
  // the recorded arguments start at $1 and "$@" sees every one of them.
  const entrypointScript = 'tar -xzf /tmp/src.tar.gz -C /source && exec stellar "$@"';

  // Network isolation: --network none gives the build container zero egress.
  // This is the load-bearing constraint of the whole service — the rebuild
  // must not be able to phone home or fetch anything unexpected. Memory and
  // swap are set equal to disable swap; cpu and pid limits bound a runaway
  // build.
  const memoryBytes = config.memoryBytes ?? 2 * 1024 ** 3;
  const createArgs = [
    'create',
    '--name',
    containerName,
    '--network',
    'none',
    '--memory',
    String(memoryBytes),
    '--memory-swap',
    String(memoryBytes),
    '--cpus',
    String(config.cpus ?? 2),
    '--pids-limit',
    String(config.pidsLimit ?? 512),
    '--workdir',
    '/source',
    '--entrypoint',
    '/bin/sh',
    ...(request.rustVersion === null ? [] : ['--env', `RUSTUP_TOOLCHAIN=${request.rustVersion}`]),
    request.buildImage,
    '-c',
    entrypointScript,
    'sh',
    ...request.buildArgs,
    ...request.buildOptions,
    ...metaArgs,
  ];

  const createResult = await exec.exec('docker', createArgs);
  if (createResult.exitCode !== 0) {
    const buildLog = commandLog(createResult);
    return {
      status: 'error',
      reason: `docker create failed (exit ${createResult.exitCode})`,
      buildLog,
    };
  }
  const containerId = createResult.stdout.toString('utf8').trim();

  try {
    await mkdir(jobDir, { recursive: true });
    await writeFile(tarballPath, request.sourceTarball);

    const copyIn = await exec.exec('docker', ['cp', tarballPath, `${containerId}:/tmp/src.tar.gz`]);
    if (copyIn.exitCode !== 0) {
      return {
        status: 'error',
        reason: 'docker cp (source in) failed',
        buildLog: commandLog(copyIn),
      };
    }

    const start = await exec.exec('docker', ['start', containerId]);
    if (start.exitCode !== 0) {
      return { status: 'error', reason: 'docker start failed', buildLog: commandLog(start) };
    }

    // Wall-clock bound: if the wait itself times out, the container is killed
    // and the job is reported as timed out rather than left running forever.
    const waitResult = await exec.exec('docker', ['wait', containerId], {
      timeoutMs: config.buildTimeoutMs ?? 10 * 60 * 1000,
    });
    if (waitResult.timedOut) {
      await exec.exec('docker', ['kill', containerId]);
      const buildLog = await readContainerLogs(exec, containerId);
      return {
        status: 'error',
        reason: 'build exceeded the wall-clock timeout and was killed',
        buildLog,
      };
    }
    if (waitResult.exitCode !== 0) {
      return { status: 'error', reason: 'docker wait failed', buildLog: commandLog(waitResult) };
    }
    const waitOutput = waitResult.stdout.toString('utf8').trim();
    const containerExit = Number.parseInt(waitOutput, 10);
    const buildLog = await readContainerLogs(exec, containerId);
    if (!Number.isInteger(containerExit)) {
      return {
        status: 'error',
        reason: `docker wait returned unexpected output: ${waitOutput}`,
        buildLog,
      };
    }
    if (containerExit !== 0) {
      return {
        status: 'error',
        reason: `build failed inside container (exit ${containerExit})`,
        buildLog,
      };
    }

    await mkdir(outDir, { recursive: true });
    // Standard layout first; fall back to the whole tree for exotic layouts.
    const copyOutRelease = await exec.exec('docker', [
      'cp',
      `${containerId}:/source/target/wasm32v1-none/release`,
      outDir,
    ]);
    if (copyOutRelease.exitCode !== 0) {
      const copyOutSource = await exec.exec('docker', ['cp', `${containerId}:/source`, outDir]);
      if (copyOutSource.exitCode !== 0) {
        return {
          status: 'error',
          reason: 'could not extract rebuilt wasm from container',
          buildLog,
        };
      }
    }

    const copyWasPrimary = copyOutRelease.exitCode === 0;
    // With the primary copy the outDir holds only build artifacts. With the
    // whole-tree fallback, restrict to cargo's target/ tree so fixture .wasm
    // files in the source (e.g. under test/) cannot pollute the hash set.
    const rebuiltArtifacts = await findWasmFiles(outDir, { onlyTargetTree: !copyWasPrimary });
    return { status: 'success', rebuiltArtifacts, buildLog };
  } finally {
    await cleanupContainer(exec, containerId, jobDir);
  }
}

/** Hash every .wasm under a directory, skipping cargo's deps/ subdirectories. */
async function findWasmFiles(
  dir: string,
  opts: { onlyTargetTree: boolean },
): Promise<{ name: string; hash: string }[]> {
  const found: { name: string; hash: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'deps') {
          continue;
        }
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.wasm')) {
        if (opts.onlyTargetTree && !full.includes('/target/')) {
          continue;
        }
        const bytes = await readFile(full);
        found.push({ name: entry.name, hash: sha256Hex(bytes) });
      }
    }
  };
  await walk(dir);
  return found;
}

/** SHA-256 hex digest of a buffer (the Soroban wasm hash function). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readContainerLogs(exec: CommandExecutor, containerId: string): Promise<string> {
  const result = await exec.exec('docker', ['logs', containerId]);
  return `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
}

async function cleanupContainer(
  exec: CommandExecutor,
  containerId: string,
  jobDir: string,
): Promise<void> {
  await exec.exec('docker', ['rm', '-f', containerId]);
  await rm(jobDir, { recursive: true, force: true });
}

function commandLog(result: CommandResult): string {
  return `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
}

/** Docker container names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*; clamp to 63. */
function sanitizeContainerName(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
  return sanitized.length > 0 ? sanitized : 'soroverify';
}
