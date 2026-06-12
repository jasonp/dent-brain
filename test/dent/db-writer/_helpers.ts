/**
 * Shared setup bits for the DB-direct write-path tests (single-brain
 * Stage C). No git fixture anymore — the db-writer talks to PGLite only.
 *
 * The canonical PGLite block (R3/R4) stays inside each *.test.ts file;
 * this module only carries the per-test re-seed pieces that
 * `resetPgliteState` wipes (it truncates `sources` and re-seeds only
 * 'default', so the 'dent' source row pages.source_id FKs against must
 * be re-upserted before every test).
 */

import type { BrainEngine } from '../../../src/core/engine.ts';
import { DENT_SOURCE_ID } from '../../../src/dent/db-writer/page-io.ts';

/** Upsert the 'dent' sources row importFromContent writes against. */
export async function upsertDentSource(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [DENT_SOURCE_ID, 'Dent Brain (export mirror)', JSON.stringify({ mirror: true, syncEnabled: false })],
  );
}
