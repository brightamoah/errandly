import knex, { Knex } from 'knex';
import path from 'path';
import { config } from './config';

const isCompiled = path.extname(__filename) === '.js';

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

const connectionUrl = normalizeConnectionString(config.databaseUrl);

export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: config.databaseSsl
    ? { connectionString: connectionUrl, ssl: { rejectUnauthorized: false } }
    : connectionUrl,
  pool: { min: 0, max: 10 },
  migrations: {
    directory: path.join(__dirname, '..', 'migrations'),
    loadExtensions: [isCompiled ? '.js' : '.ts'],
  },
  seeds: {
    directory: path.join(__dirname, '..', 'seeds'),
    loadExtensions: [isCompiled ? '.js' : '.ts'],
  },
};

export const db = knex(knexConfig);
