import { AsyncLocalStorage } from 'node:async_hooks';
import knex, { Knex } from 'knex';
import path from 'node:path';
import { config } from './config';

/**
 * Normalizes connection string SSL parameters to suppress pg-connection-string
 * deprecation warnings and prepare for future libpq compatibility.
 */
function normalizeConnectionString(url: string): string {
  if (url.includes('sslmode=require') && !url.includes('uselibpqcompat')) {
    return url.replace('sslmode=require', 'sslmode=verify-full');
  }
  return url;
}

/**
 * Builds a standalone Knex instance. On Cloudflare Workers each request must
 * use its own instance (Workers forbid reusing sockets across requests), so the
 * worker entry calls this per request and destroys it when the request ends.
 */
export function createKnex(
  connectionString: string,
  options: { ssl?: boolean; poolMax?: number } = {},
): Knex {
  // Unlike the Node path, the URL is used verbatim: in production this is the
  // Hyperdrive-generated string, and rewriting its sslmode would break TLS.
  return knex({
    client: 'pg',
    connection: options.ssl ? { connectionString, ssl: { rejectUnauthorized: false } } : connectionString,
    pool: { min: 0, max: options.poolMax ?? 10 },
    acquireConnectionTimeout: 15000,
  });
}

/** Knex instance that belongs to the request currently being handled (Workers). */
const requestDb = new AsyncLocalStorage<Knex>();

/** Process-wide instance for Node (server, CLI, tests). Created on first use. */
let nodeDb: Knex | undefined;

function createNodeKnex(): Knex {
  const isWorkersRuntime =
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'Cloudflare-Workers';
  if (isWorkersRuntime) {
    throw new Error('Database used outside a request context; wrap the handler in runWithDb()');
  }
  // Kept lazy: __dirname/__filename and migration paths only exist on Node.
  const isCompiled = path.extname(__filename) === '.js';
  return knex({
    client: 'pg',
    connection: config.databaseSsl
      ? { connectionString: normalizeConnectionString(config.databaseUrl), ssl: { rejectUnauthorized: false } }
      : normalizeConnectionString(config.databaseUrl),
    pool: { min: 0, max: 10 },
    acquireConnectionTimeout: 15000,
    migrations: {
      directory: path.join(__dirname, '..', 'migrations'),
      loadExtensions: [isCompiled ? '.js' : '.ts'],
    },
    seeds: {
      directory: path.join(__dirname, '..', 'seeds'),
      loadExtensions: [isCompiled ? '.js' : '.ts'],
    },
  });
}

function current(): Knex {
  const scoped = requestDb.getStore();
  if (scoped) return scoped;
  if (!nodeDb) nodeDb = createNodeKnex();
  return nodeDb;
}

/** Runs `fn` with `instance` bound as the database for the current async context. */
export function runWithDb<T>(instance: Knex, fn: () => T): T {
  return requestDb.run(instance, fn);
}

/**
 * The database entry point used by routes and services. It resolves to the
 * request-scoped instance on Workers, and to the shared Node instance
 * everywhere else, so application code never needs to know which it is.
 */
export const db = new Proxy(function () {} as unknown as Knex, {
  apply(_target, _thisArg, args: unknown[]) {
    return (current() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    const instance = current() as unknown as Record<PropertyKey, unknown>;
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
  set(_target, prop, value) {
    (current() as unknown as Record<PropertyKey, unknown>)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (current() as unknown as object);
  },
});
