import { createApp } from './app';
import { config } from './config';
import { db } from './db';

async function main() {
  if (process.env.MIGRATE_ON_START === 'true') {
    const [, applied] = await db.migrate.latest();
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }
  createApp().listen(config.port, () => console.log(`Errandly listening on :${config.port} (${config.env})`));
}

main().catch((err) => {
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
