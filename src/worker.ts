import { env } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createWorkerApp } from './cf/app';
import { configure } from './config';
import { createKnex, runWithDb } from './db';

/**
 * Cloudflare Workers entry point.
 *
 * Express runs on the Workers runtime through `node:http` (see
 * https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).
 * Static files are served by Workers Assets; only /api, /health, /docs and
 * /openapi.json reach this Worker, as configured in wrangler.jsonc.
 */

export interface Env {
  HYPERDRIVE: Hyperdrive;
  JWT_SECRET: string;
  JWT_EXPIRES_IN?: string;
  CURRENCY?: string;
  SERVICE_FEE_MINOR?: string;
  NODE_ENV?: string;
  ASSETS: Fetcher;
}

const PORT = 3000;

const app = createWorkerApp();
app.listen(PORT);

export default {
  async fetch(request: Request, workerEnv: Env, ctx: ExecutionContext): Promise<Response> {
    if (!workerEnv.HYPERDRIVE) {
      return Response.json(
        { error: { code: 'NOT_CONFIGURED', message: 'The HYPERDRIVE binding is missing' } },
        { status: 500 },
      );
    }

    // Bindings are only available inside the handler, and config is read lazily.
    configure({
      NODE_ENV: workerEnv.NODE_ENV ?? 'production',
      JWT_SECRET: workerEnv.JWT_SECRET,
      JWT_EXPIRES_IN: workerEnv.JWT_EXPIRES_IN,
      CURRENCY: workerEnv.CURRENCY,
      SERVICE_FEE_MINOR: workerEnv.SERVICE_FEE_MINOR,
      // Hyperdrive provides the connection string; no DATABASE_URL var is needed.
      DATABASE_URL: workerEnv.HYPERDRIVE.connectionString,
    });

    // Workers cannot reuse I/O (database sockets) across requests, so every
    // request gets its own Knex instance. Hyperdrive does the real pooling.
    const instance = createKnex(workerEnv.HYPERDRIVE.connectionString, { poolMax: 1 });
    try {
      return await runWithDb(instance, () => handleAsNodeRequest(PORT, request));
    } catch (err) {
      console.error('Worker error:', err instanceof Error ? err.message : err);
      return Response.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
        { status: 500 },
      );
    } finally {
      ctx.waitUntil(instance.destroy().catch(() => undefined));
    }
  },
};
