import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import YAML from 'yaml';
import openapiYaml from '../../docs/openapi.yaml';
import { config } from '../config';
import { errorHandler } from '../errors';
import { router } from '../routes';

/**
 * Express app for Cloudflare Workers.
 *
 * It is the same application as `src/app.ts`, minus the two Node-only pieces:
 * static files are served by Workers Assets (see `assets` in wrangler.jsonc),
 * and the OpenAPI reference is rendered from an inlined spec instead of
 * swagger-ui-express reading from disk.
 */

const spec = YAML.parse(openapiYaml);

const docsHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Errandly API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>body { margin: 0 } .topbar { display: none }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    </script>
  </body>
</html>`;

export function createWorkerApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  // Method, path, status and timing only: no headers, bodies or tokens reach the logs.
  if (config.env !== 'test') app.use(morgan(':method :url :status :response-time ms'));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/openapi.json', (_req, res) => res.json(spec));
  app.get('/docs', (_req, res) => res.type('html').send(docsHtml));

  app.use('/api', router);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));

  app.use(errorHandler);
  return app;
}
