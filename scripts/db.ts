/**
 * Database CLI: `pnpm run db [migrate | rollback | seed | reset | help]`
 */
import { db } from '../src/db';

function printHelp() {
  console.log(`
Errandly Database CLI

Usage:
  pnpm run db [command]
  pnpm run db -- <command>

Commands:
  migrate   Apply pending database migrations (default)
  rollback  Undo the last migration batch
  seed      Wipe and seed demo accounts and sample shopping list
  reset     Roll back all migrations, re-migrate, and re-seed
  help      Show this help message
`);
}

async function main() {
  const arg = process.argv[2]?.trim();
  const cmd = arg ?? 'migrate';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'migrate') {
    const [, applied] = await db.migrate.latest();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database schema is already up to date (no pending migrations)');
  } else if (cmd === 'rollback') {
    const [, rolled] = await db.migrate.rollback();
    console.log(rolled.length ? `Rolled back: ${rolled.join(', ')}` : 'Nothing to roll back');
  } else if (cmd === 'seed') {
    await db.seed.run();
    console.log('Seeded demo accounts and a ready-made shopping list');
  } else if (cmd === 'reset') {
    await db.migrate.rollback(undefined, true);
    await db.migrate.latest();
    await db.seed.run();
    console.log('Database reset, migrated and seeded');
  } else {
    console.error(`Unknown command "${cmd}"`);
    printHelp();
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
