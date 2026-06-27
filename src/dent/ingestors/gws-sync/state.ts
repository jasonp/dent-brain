/**
 * Singleton cursor state for the gws-sync ingestor.
 *
 * Stored in Postgres (`gws_sync_state` table, dent migration v5) so the Drive
 * changes-feed pageToken survives Railway redeploys — the server FS is
 * ephemeral, so a local cursor file (the email-sync pattern) would reset the
 * crawler to a full walk on every deploy.
 *
 * `changesPageToken === null` means "never seeded": the orchestrator runs the
 * one-time full walk, then banks the start token.
 */

import type { BrainEngine } from '../../../core/engine.ts';

export interface GwsSyncState {
  changesPageToken: string | null;
  lastFullWalkAt: string | null;
  lastPolledAt: string | null;
}

export async function readGwsState(engine: BrainEngine): Promise<GwsSyncState> {
  const rows = await engine.executeRaw<{
    changes_page_token: string | null;
    last_full_walk_at: string | null;
    last_polled_at: string | null;
  }>(
    `SELECT changes_page_token,
            last_full_walk_at::text AS last_full_walk_at,
            last_polled_at::text     AS last_polled_at
       FROM gws_sync_state
      WHERE id = 1`,
    [],
  );
  if (rows.length === 0) {
    return { changesPageToken: null, lastFullWalkAt: null, lastPolledAt: null };
  }
  const r = rows[0];
  return {
    changesPageToken: r.changes_page_token,
    lastFullWalkAt: r.last_full_walk_at,
    lastPolledAt: r.last_polled_at,
  };
}

/** Persist the changes token (and stamp last_polled_at). */
export async function writeChangesToken(engine: BrainEngine, token: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO gws_sync_state (id, changes_page_token, last_polled_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE
       SET changes_page_token = EXCLUDED.changes_page_token,
           last_polled_at     = EXCLUDED.last_polled_at`,
    [token],
  );
}

/** Stamp completion of a full seed walk (also persists the start token). */
export async function writeFullWalkDone(engine: BrainEngine, token: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO gws_sync_state (id, changes_page_token, last_full_walk_at, last_polled_at)
     VALUES (1, $1, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET changes_page_token = EXCLUDED.changes_page_token,
           last_full_walk_at  = EXCLUDED.last_full_walk_at,
           last_polled_at     = EXCLUDED.last_polled_at`,
    [token],
  );
}
