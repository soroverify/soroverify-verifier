/**
 * API server entry point (Fastify).
 *
 * Boots the HTTP server, ensures the Postgres schema exists, and wires
 * graceful shutdown. Dependencies are constructed here from environment
 * variables and injected into the route handlers; this module contains no
 * business logic.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { createDatabase, type Database } from './db.js';
import { registerRoutes } from './routes.js';

/** Everything the API routes need, injected rather than imported. */
export interface ServerDependencies {
  database: Database;
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

async function main(): Promise<void> {
  const database = createDatabase({
    connectionString: requiredEnv('DATABASE_URL'),
    logger: console,
  });

  await database.ensureSchema();

  const config: ServerConfig = {
    host: process.env.HOST ?? '0.0.0.0',
    port: parsePort(process.env.PORT, 8080),
  };

  const app = buildServer(config, { database });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
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
