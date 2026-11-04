import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required(
    env === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL',
    env === 'production' ? undefined : env === 'test'
      ? 'postgres://postgres@localhost:5432/errands_test'
      : 'postgres://postgres@localhost:5432/errands',
  ),
  // In production JWT_SECRET must be set explicitly; dev/test get a throwaway value.
  jwtSecret: required('JWT_SECRET', env === 'production' ? undefined : 'dev-only-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  // Money is stored in minor units (pesewas / cents).
  serviceFee: Number(process.env.SERVICE_FEE_MINOR ?? 1500),
  currency: process.env.CURRENCY ?? 'GHS',
  databaseSsl: process.env.DATABASE_SSL === 'true',
};
