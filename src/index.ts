/**
 * API server entry point (Fastify).
 *
 * Boots the HTTP server, ensures the Postgres schema exists, constructs every
 * dependency from environment variables, starts the bounded job runner, and
 * wires graceful shutdown. This module contains no business logic.
 *
 * Environment (see README for the full reference):
 *  - DATABASE_URL            Postgres connection string (required)
 *  - STELLAR_RPC_URL         Soroban RPC endpoint (required)
 *  - VERIFIER_PRIVATE_KEY    base64 PKCS8 DER Ed25519 private key; when unset
 *                            an ephemeral identity is generated per boot
 *  - ALLOWED_BUILD_IMAGES    comma-separated digest-pinned build images
 *  - VERIFY_IMAGE            the pinned fetch/verify image (default
 *                            soroverify/verify-image:latest)
 *  - PEER_VERIFIERS          comma-separated base URLs of independent verifiers
 *  - STORE_DIR               content-addressed storage directory
 *  - WORK_DIR                scratch directory for fetch/build artifacts
 *  - BUILD_TIMEOUT_MS, FETCH_TIMEOUT_MS, BUILD_CPUS, BUILD_MEMORY_BYTES,
 *    BUILD_PIDS_LIMIT, JOB_CONCURRENCY
 *  - MAX_ACTIVE_SUBMISSIONS service-wide ceiling on submissions that are
 *                            queued or running at once (see below)
 *  - RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS                 global per-IP
 *                            request rate limit (all routes)
 *  - SUBMISSIONS_RATE_LIMIT_MAX, SUBMISSIONS_RATE_LIMIT_WINDOW_MS
 *                            stricter per-IP rate limit on POST /submissions
 *  - HOST, PORT
 *  - CORS_ALLOWED_ORIGINS    '*' (default) or a comma-separated list of exact
 *                            origins for the public read endpoints; write
 *                            routes are never CORS-enabled
 */

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createDatabase, type Database } from './db.js';
import { registerRoutes } from './routes.js';
import { Resolver } from './resolve.js';
import { ChildProcessExecutor, parseBuildImageAllowlist, type RebuildConfig } from './rebuild.js';
import { ContentStore } from './store.js';
import { createVerifierIdentity, loadVerifierIdentity, type VerifierIdentity } from './sign.js';
import { JobRunner, type JobRunnerConfig } from './queue.js';

/** Everything the API routes need, injected rather than imported. */
export interface ServerDependencies {
  database: Database;
  store: ContentStore;
  resolver: Resolver;
  peerVerifiers: string[];
  /** Service-wide ceiling on submissions queued-or-running at once; see the
   * MAX_ACTIVE_SUBMISSIONS doc comment below. */
  maxActiveSubmissions: number;
}

/**
 * Rate limiting protects POST /submissions, by far the most expensive
 * endpoint in the service: every accepted submission triggers a real git
 * clone and a real, resource-consuming isolated container build. Two tiers:
 *  - A conservative global default applied to every route (RATE_LIMIT_MAX /
 *    RATE_LIMIT_WINDOW_MS), so even a future/unlisted route is never fully
 *    unprotected. 300 requests/minute per IP (~5 req/s sustained) is generous
 *    enough that legitimate polling of the read endpoints is never throttled,
 *    while still bounding gross single-source abuse.
 *  - A much stricter limit on POST /submissions specifically
 *    (SUBMISSIONS_RATE_LIMIT_MAX / SUBMISSIONS_RATE_LIMIT_WINDOW_MS): 5
 *    requests/minute per IP, matching the precedent already set by the
 *    equivalent expensive write endpoint (POST /watch) in the sibling
 *    soroverify-watch service.
 * The read-only GET /verifications/* and /status/* endpoints deliberately
 * keep the generous global default rather than the strict one: this
 * project's whole value depends on them staying genuinely public and freely
 * queryable.
 */
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_SUBMISSIONS_RATE_LIMIT_MAX = 5;
const DEFAULT_SUBMISSIONS_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Service-wide ceiling (MAX_ACTIVE_SUBMISSIONS) on submissions that are
 * queued or running at once, checked before a submission row is even
 * inserted (db.ts#insertSubmissionIfUnderCeiling). This is distinct from
 * JOB_CONCURRENCY, which bounds how many jobs the runner processes
 * *simultaneously*: without this ceiling, a distributed set of submitters,
 * each individually staying under the per-IP rate limit above, could still
 * grow the backlog (and eventually disk/DB usage as it drains) without
 * bound. 200 is sized against the worst-case per-job wall clock
 * (BUILD_TIMEOUT_MS + FETCH_TIMEOUT_MS defaults, 15 min) at the default
 * JOB_CONCURRENCY of 4: a full queue drains in at most ~12.5 hours worst
 * case — a real but bounded and honestly-reported wait (a 503 telling the
 * caller exactly how full the queue is), never unbounded growth or a silent
 * drop.
 */
const DEFAULT_MAX_ACTIVE_SUBMISSIONS = 200;

export interface ServerConfig {
  host: string;
  port: number;
  loggerEnabled?: boolean;
  /** CORS_ALLOWED_ORIGINS for the public read endpoints; '*' by default. */
  corsAllowedOrigins?: string;
  /** RATE_LIMIT_MAX: global per-IP request limit across every route. */
  rateLimitMax?: number;
  /** RATE_LIMIT_WINDOW_MS: global rate limit window, in ms. */
  rateLimitWindowMs?: number;
  /** SUBMISSIONS_RATE_LIMIT_MAX: per-IP limit on POST /submissions alone. */
  submissionsRateLimitMax?: number;
  /** SUBMISSIONS_RATE_LIMIT_WINDOW_MS: that limit's window, in ms. */
  submissionsRateLimitWindowMs?: number;
}

/**
 * Build a configured Fastify instance with all routes registered.
 *
 * Async because the rate-limit plugin must finish registering (its
 * onRequest hook attached) before any route is added — an unawaited
 * `register` leaves the hook queued but not yet applied when routes are
 * declared immediately after, silently disabling throttling.
 */
export async function buildServer(
  config: ServerConfig,
  deps: ServerDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.loggerEnabled ?? true });
  // Registered (and awaited) before any route so its onRequest hook covers
  // every route declared below, per @fastify/rate-limit's own documented
  // usage.
  await app.register(rateLimit, {
    max: config.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    timeWindow: config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  });
  app.get('/health', async () => ({ status: 'ok' }));
  registerRoutes(app, deps, config.corsAllowedOrigins, {
    max: config.submissionsRateLimitMax ?? DEFAULT_SUBMISSIONS_RATE_LIMIT_MAX,
    timeWindow: config.submissionsRateLimitWindowMs ?? DEFAULT_SUBMISSIONS_RATE_LIMIT_WINDOW_MS,
  });
  return app;
}

/** Read a required environment variable or throw a descriptive error. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

/** Parse a TCP port from an environment string, rejecting garbage at boot. */
export function parsePort(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid PORT value: ${raw === undefined ? '<unset>' : raw}`);
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function loadIdentity(raw: string | undefined): VerifierIdentity {
  if (raw === undefined || raw === '') {
    const identity = createVerifierIdentity();
    console.warn(
      `VERIFIER_PRIVATE_KEY is not set; using an ephemeral identity (verifier_id=${identity.verifierId}). ` +
        'Results stay self-verifying (each carries its public key), but the id changes across restarts. ' +
        'See README for generating and setting a persistent key.',
    );
    return identity;
  }
  return loadVerifierIdentity(raw);
}

async function main(): Promise<void> {
  const database = createDatabase({
    connectionString: requiredEnv('DATABASE_URL'),
    logger: console,
  });
  await database.ensureSchema();

  const resolver = new Resolver({ rpcUrl: requiredEnv('STELLAR_RPC_URL') });
  const store = new ContentStore(process.env.STORE_DIR ?? join(process.cwd(), 'data'));
  const exec = new ChildProcessExecutor();

  const rebuildConfig: RebuildConfig = {
    allowedBuildImages: parseBuildImageAllowlist(process.env.ALLOWED_BUILD_IMAGES),
    verifyImage: process.env.VERIFY_IMAGE ?? 'soroverify/verify-image:latest',
    workDir: process.env.WORK_DIR ?? '/tmp/soroverify',
    buildTimeoutMs: envInt('BUILD_TIMEOUT_MS', 10 * 60 * 1000),
    fetchTimeoutMs: envInt('FETCH_TIMEOUT_MS', 5 * 60 * 1000),
    cpus: envFloat('BUILD_CPUS', 2),
    memoryBytes: envInt('BUILD_MEMORY_BYTES', 2 * 1024 ** 3),
    pidsLimit: envInt('BUILD_PIDS_LIMIT', 512),
  };

  const identity = loadIdentity(process.env.VERIFIER_PRIVATE_KEY);
  const peerVerifiers = parseList(process.env.PEER_VERIFIERS);

  const config: ServerConfig = {
    host: process.env.HOST ?? '0.0.0.0',
    port: parsePort(process.env.PORT, 8080),
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? '*',
    rateLimitMax: envInt('RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX),
    rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS),
    submissionsRateLimitMax: envInt(
      'SUBMISSIONS_RATE_LIMIT_MAX',
      DEFAULT_SUBMISSIONS_RATE_LIMIT_MAX,
    ),
    submissionsRateLimitWindowMs: envInt(
      'SUBMISSIONS_RATE_LIMIT_WINDOW_MS',
      DEFAULT_SUBMISSIONS_RATE_LIMIT_WINDOW_MS,
    ),
  };
  const maxActiveSubmissions = envInt('MAX_ACTIVE_SUBMISSIONS', DEFAULT_MAX_ACTIVE_SUBMISSIONS);

  const app = await buildServer(config, {
    database,
    store,
    resolver,
    peerVerifiers,
    maxActiveSubmissions,
  });

  const runnerConfig: JobRunnerConfig = {
    database,
    resolver,
    exec,
    rebuildConfig,
    store,
    identity,
    log: app.log,
    concurrency: envInt('JOB_CONCURRENCY', 4),
    fetchTimeoutMs: envInt('FETCH_TIMEOUT_MS', 5 * 60 * 1000),
  };
  const runner = new JobRunner(runnerConfig);

  // Lease-timeout reaper: reclaims rows left 'running' by a dead or hung
  // worker. Runs on its own fixed interval, independently of the poll loop,
  // so a crash in one never starves the other.
  const REAPER_INTERVAL_MS = 60 * 1000;
  let reaperTimer: NodeJS.Timeout | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    if (reaperTimer !== undefined) {
      clearInterval(reaperTimer);
    }
    await runner.stop();
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
    runner.start();
    reaperTimer = setInterval(() => {
      // reclaimStuckJobs swallows its own errors; no unhandled rejection.
      void runner.reclaimStuckJobs();
    }, REAPER_INTERVAL_MS);
  } catch (err) {
    app.log.error(err);
    await database.close();
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
