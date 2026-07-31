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
 *  - HOST, PORT
 */

import Fastify, { type FastifyInstance } from 'fastify';
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
}

export interface ServerConfig {
  host: string;
  port: number;
  loggerEnabled?: boolean;
}

/** Build a configured Fastify instance with all routes registered. */
export function buildServer(config: ServerConfig, deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: config.loggerEnabled ?? true });
  app.get('/health', async () => ({ status: 'ok' }));
  registerRoutes(app, deps);
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
  };

  const app = buildServer(config, { database, store, resolver, peerVerifiers });

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

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
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
