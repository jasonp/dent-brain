/**
 * Pure classification of a Drive `changes.list` entry into the action the
 * orchestrator must take. Keeping this pure makes the upsert/tombstone/ignore
 * decision table directly unit-testable without a live Drive.
 *
 *   - removed flag set                          → tombstone (file/grant gone)
 *   - file present but trashed                  → tombstone
 *   - file present, mimeType not Doc/Sheet      → ignore (folder, slides, …)
 *   - file present, tracked mimeType, live      → upsert
 *   - neither file nor removed (shouldn't happen)→ ignore
 */

import type { DriveChange, DeltaAction } from './types.ts';
import { isTrackedMime } from './types.ts';

export function classifyChange(change: DriveChange): DeltaAction {
  if (change.removed) return 'tombstone';
  const file = change.file;
  if (!file) return 'ignore';
  if (file.trashed) return 'tombstone';
  if (!isTrackedMime(file.mimeType)) return 'ignore';
  return 'upsert';
}
