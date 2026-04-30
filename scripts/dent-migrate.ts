#!/usr/bin/env bun
/**
 * Apply Dent-specific schema migrations against the configured database.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/dent-migrate.ts
 *
 * Reads `dent_version` from the shared `config` table and applies any
 * migrations newer than that. Idempotent: re-running is a no-op.
 *
 * For production: pull DATABASE_URL from Railway:
 *   DATABASE_URL=$(railway variables --kv | grep '^DATABASE_URL=' | cut -d= -f2-) \
 *     bun run scripts/dent-migrate.ts
 */

import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runDentMigrations, DENT_LATEST_VERSION } from '../src/dent/migrate.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required.');
  console.error('Hint: railway variables --kv | grep DATABASE_URL');
  process.exit(1);
}

async function main() {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL!, poolSize: 2 });

  try {
    console.log(`Applying dent migrations (latest available: v${DENT_LATEST_VERSION})...`);
    const { applied, current } = await runDentMigrations(engine);
    if (applied === 0) {
      console.log(`Already at v${current}. Nothing to do.`);
    } else {
      console.log(`Applied ${applied} migration(s). Now at v${current}.`);
    }
  } finally {
    await engine.disconnect();
  }
}

main().catch((err) => {
  console.error('dent-migrate failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
