/**
 * Per-form cursor state for the RegFox ingestor.
 *
 * Stored in Postgres (`regfox_ingest_state` table, dent migration v4).
 * Key = form_id. The reserved key 0 represents the "all forms (no
 * formId filter)" cursor used when DENT_BRAIN_REGFOX_FORM_IDS is
 * unset.
 */

import type { BrainEngine } from '../../../core/engine.ts';

export const ALL_FORMS_CURSOR_KEY = 0;

export interface FormCursorState {
  formId: number;
  lastSeenId: number;
  lastPolledAt: string | null;
  lastStatus: string | null;
}

export async function readCursor(
  engine: BrainEngine,
  formId: number,
): Promise<FormCursorState> {
  const rows = await engine.executeRaw<{
    form_id: string | number;
    last_seen_id: string | number;
    last_polled_at: string | null;
    last_status: string | null;
  }>(
    `SELECT form_id, last_seen_id, last_polled_at::text AS last_polled_at, last_status
       FROM regfox_ingest_state
      WHERE form_id = $1`,
    [formId],
  );
  if (rows.length === 0) {
    return { formId, lastSeenId: 0, lastPolledAt: null, lastStatus: null };
  }
  const r = rows[0];
  return {
    formId: Number(r.form_id),
    lastSeenId: Number(r.last_seen_id),
    lastPolledAt: r.last_polled_at,
    lastStatus: r.last_status,
  };
}

export async function writeCursor(
  engine: BrainEngine,
  formId: number,
  lastSeenId: number,
  status: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO regfox_ingest_state (form_id, last_seen_id, last_polled_at, last_status)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (form_id) DO UPDATE
       SET last_seen_id   = GREATEST(regfox_ingest_state.last_seen_id, EXCLUDED.last_seen_id),
           last_polled_at = EXCLUDED.last_polled_at,
           last_status    = EXCLUDED.last_status`,
    [formId, lastSeenId, status],
  );
}
