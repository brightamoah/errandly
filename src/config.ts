/**
 * Runtime configuration.
 *
 * Values are read lazily (getters) rather than once at import time, because on
 * Cloudflare Workers environment variables are only available per request and
 * the database URL comes from the Hyperdrive binding. Node entry points load
 * `.env` first (`server.ts`, `scripts/db.ts`, `tests/env.ts`), and the worker
 * entry calls `configure()` with its bindings.
 */

const overrides: Record<string, string | number | undefined> = {};

/** Supplies values that are not ordinary environment variables (Workers bindings). */
export function configure(values: Record<string, string | number | undefined>): void {
  Object.assign(overrides, values);
}

function raw(name: string): string | undefined {
  const value = overrides[name] ?? process.env[name];
  return value === undefined || value === '' ? undefined : String(value);
}

function required(name: string, fallback?: string): string {
  const value = raw(name) ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const env = () => raw('NODE_ENV') ?? 'development';

export const config = {
  get env(): string {
    return env();
  },
  get port(): number {
    return Number(raw('PORT') ?? 3000);
  },
  get databaseUrl(): string {
    const mode = env();
    return required(
      mode === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL',
      mode === 'production' ? undefined : mode === 'test'
        ? 'postgres://postgres@localhost:5432/errands_test'
        : 'postgres://postgres@localhost:5432/errands',
    );
  },
  // In production JWT_SECRET must be set explicitly; dev/test get a throwaway value.
  get jwtSecret(): string {
    return required('JWT_SECRET', env() === 'production' ? undefined : 'dev-only-secret-change-me');
  },
  get jwtExpiresIn(): string {
    return raw('JWT_EXPIRES_IN') ?? '12h';
  },
  // Money is stored in minor units (pesewas / cents).
  get serviceFee(): number {
    return Number(raw('SERVICE_FEE_MINOR') ?? 1500);
  },
  get currency(): string {
    return raw('CURRENCY') ?? 'GHS';
  },
  get databaseSsl(): boolean {
    return raw('DATABASE_SSL') === 'true';
  },
};
