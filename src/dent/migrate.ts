/**
 * Dent-specific schema migrations.
 *
 * Runs alongside gbrain's `src/core/migrate.ts` migration runner without
 * touching it. Uses the `dent_version` key in the shared `config` table
 * so version tracking doesn't collide with gbrain's `version` key.
 *
 * Adding a new migration:
 *   1. Append to DENT_MIGRATIONS with a fresh, monotonically increasing
 *      version number.
 *   2. Never modify or reorder existing entries.
 *   3. SQL must be idempotent (use IF NOT EXISTS, ON CONFLICT, etc).
 *
 * To apply: `bun run scripts/dent-migrate.ts` (uses DATABASE_URL).
 */

import type { BrainEngine } from '../core/engine.ts';

interface DentMigration {
  version: number;
  name: string;
  /** Engine-agnostic SQL. Set to '' for handler-only migrations. */
  sql: string;
  /** Engine-specific SQL overrides `sql` when present. */
  sqlFor?: { postgres?: string; pglite?: string };
  /**
   * When false, runner does NOT wrap in `engine.transaction()`. Required for
   * `CREATE INDEX CONCURRENTLY` (Postgres refuses inside a transaction).
   * Defaults to true. Ignored on PGLite.
   */
  transaction?: boolean;
  handler?: (engine: BrainEngine) => Promise<void>;
}

const DENT_CONFIG_KEY = 'dent_version';

export const DENT_MIGRATIONS: DentMigration[] = [
  {
    version: 1,
    name: 'evidence_log_core',
    sql: `
      -- evidence: append-only log of observations about entities.
      -- Phase 1 deliverable per PLAN.md; supports the materializer (Phase 3),
      -- /append-evidence (Phase 4), and Dropbox bulk import (Phase 5).
      CREATE TABLE IF NOT EXISTS evidence (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content_hash    TEXT        NOT NULL UNIQUE,
        entity_refs     TEXT[]      NOT NULL,
        content         TEXT        NOT NULL,
        source_type     TEXT        NOT NULL,
        source_ref      TEXT,
        author          TEXT        NOT NULL,
        observed_at     TIMESTAMPTZ NOT NULL,
        appended_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        batch_id        UUID,
        quarantined_at  TIMESTAMPTZ,
        metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb
      );

      -- A2 (binding eng-review decision): GIN on entity_refs is non-negotiable.
      CREATE INDEX IF NOT EXISTS evidence_entity_refs_gin
        ON evidence USING GIN (entity_refs);

      -- Active reverse-chron query path (most common: get_evidence on an entity).
      CREATE INDEX IF NOT EXISTS evidence_active_appended_idx
        ON evidence (appended_at DESC) WHERE quarantined_at IS NULL;

      -- Batch lookup for quarantine_batch.
      CREATE INDEX IF NOT EXISTS evidence_batch_id_idx
        ON evidence (batch_id) WHERE batch_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: 'drop_evidence_author',
    sql: `
      -- Per-row attribution moves to upstream's mcp_request_log (v0.22.7
      -- HTTP transport audit row: token_name, operation, latency_ms, status,
      -- created_at). Dent ops no longer need their own author column; the
      -- request log is the source of truth.
      ALTER TABLE evidence DROP COLUMN IF EXISTS author;
    `,
  },
];

export const DENT_LATEST_VERSION = DENT_MIGRATIONS.length > 0
  ? DENT_MIGRATIONS[DENT_MIGRATIONS.length - 1].version
  : 0;

export async function runDentMigrations(
  engine: BrainEngine,
): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig(DENT_CONFIG_KEY);
  const current = parseInt(currentStr || '0', 10);

  let applied = 0;
  for (const m of DENT_MIGRATIONS) {
    if (m.version > current) {
      const sql = m.sqlFor?.[engine.kind] ?? m.sql;

      if (sql) {
        const useTransaction = m.transaction !== false;
        if (useTransaction || engine.kind === 'pglite') {
          await engine.transaction(async (tx) => {
            await tx.runMigration(m.version, sql);
          });
        } else {
          await engine.runMigration(m.version, sql);
        }
      }

      if (m.handler) {
        await m.handler(engine);
      }

      await engine.setConfig(DENT_CONFIG_KEY, String(m.version));
      console.log(`  dent migration ${m.version} applied: ${m.name}`);
      applied++;
    }
  }

  return {
    applied,
    current: applied > 0 ? DENT_LATEST_VERSION : current,
  };
}
