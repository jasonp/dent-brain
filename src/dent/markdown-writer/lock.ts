/**
 * Repo-wide writer lock for the dent-brain-data clone.
 *
 * Wraps `tryAcquireDbLock` from `src/core/db-lock.ts` with a fixed
 * lock id so every `markdown_append_to_page` / `markdown_replace_page`
 * call serializes against every other write to the same repo.
 *
 * Granularity is per-repo, not per-slug: at v0.x volume there's no
 * benefit to per-slug parallelism, and a global lock avoids the
 * orchestration cost of git committing two unrelated slugs in
 * parallel against the same working tree (git index is process-wide).
 */

import { tryAcquireDbLock } from '../../core/db-lock.ts';
import type { BrainEngine } from '../../core/engine.ts';

export const DENT_REPO_WRITE_LOCK_ID = 'dent-brain-data:write';

export interface RepoLockResult<T> {
  acquired: boolean;
  result?: T;
}

/**
 * Acquire the dent-brain-data write lock, run `fn`, then release.
 * Returns `{ acquired: false }` if the lock is held by another writer
 * (caller should surface `{error: 'busy'}` to the agent so it can retry).
 *
 * No internal retry: a 30-second sleep inside an MCP handler ties up the
 * HTTP transport thread. Better to fail fast and let the agent decide.
 */
export async function withRepoLock<T>(
  engine: BrainEngine,
  fn: () => Promise<T>,
): Promise<RepoLockResult<T>> {
  const handle = await tryAcquireDbLock(engine, DENT_REPO_WRITE_LOCK_ID);
  if (!handle) return { acquired: false };
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    try {
      await handle.release();
    } catch {
      /* best-effort: TTL will clean it up */
    }
  }
}
