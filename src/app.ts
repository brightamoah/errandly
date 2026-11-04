import cors from 'cors';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { config } from './config';
import { errorHandler } from './errors';
import { router } from './routes';

export function createApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  // Method, path, status and timing only: no headers, bodies or tokens reach the logs.
  if (config.env !== 'test') app.use(morgan(':method :url :status :response-time ms'));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Project root: src/ in development, dist/src/ when compiled.
  const root = path.join(__dirname, path.extname(__filename) === '.js' ? '../..' : '..');
  const specPath = path.join(root, 'docs', 'openapi.yaml');
  if (fs.existsSync(specPath)) {
    const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
    app.get('/openapi.json', (_req, res) => res.json(spec));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  }

  app.use('/api', router);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));

  // Serve the built React interface, with SPA fallback.
  const staticDir = path.join(root, 'web', 'dist');
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api|\/docs).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
