/**
 * Phase 4 (PLAN v2.0): server-side scheduled pull.
 *
 * Every N seconds (default 300 = 5 min), `git pull --ff-only` against
 * dent-brain-data, and if HEAD changed, run performSync to refresh the
 * Postgres index for the new content.
 *
 * Why this is needed: Phase 1's clone-on-boot + Phase 2's
 * markdown_*-write path get the AGENT side of the loop. The TEAMMATE
 * side (Phase 3) is "clone the repo, hand-edit a markdown file, push
 * to GitHub." Without a scheduled pull, the server never sees the new
 * commit until the next agent write triggers an internal pull. This
 * cron fills the gap.
 *
 * Concurrency: piggybacks on `withRepoLock` from lock.ts. If an agent
 * write is in flight when the tick fires, the pull skips (the agent
 * write will pull anyway as step 1 of its own flow). Lock contention
 * is benign — next tick catches up.
 *
 * Environment:
 *   DENT_BRAIN_PULL_INTERVAL_SECONDS    Tick interval (default 300).
 *                                       Set to 0 to disable.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { performSync } from '../../commands/sync.ts';
import { git } from './git-helpers.ts';
import { withRepoLock } from './lock.ts';
import { getRepoContext, DENT_SOURCE_ID } from './repo.ts';

export const DEFAULT_PULL_INTERVAL_SECONDS = 300; // 5 minutes

export interface ScheduledPullHandle {
  /** Stop the scheduler. Idempotent. */
  stop: () => void;
}

/**
 * One pull-and-sync tick. Pure function, exported for tests.
 *
 * Returns:
 *   - { changed: false } when HEAD didn't move (or pull was a no-op).
 *   - { changed: true, fromCommit, toCommit } when HEAD advanced and
 *     performSync ran.
 *   - { skipped: 'busy' } when the repo lock was held by another
 *     writer; this tick was a no-op (next tick will catch up).
 *   - { skipped: 'error', error } when something failed mid-flight.
 *     Errors are caught at the boundary so an interval timer never
 *     dies on a transient git/network/postgres hiccup.
 */
export type PullTickResult =
  | { changed: false }
  | { changed: true; fromCommit: string; toCommit: string }
  | { skipped: 'busy' }
  | { skipped: 'error'; error: string };

export async function pullAndSyncOnce(engine: BrainEngine): Promise<PullTickResult> {
  let repo;
  try {
    repo = getRepoContext();
  } catch (e) {
    return { skipped: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  const lockResult = await withRepoLock(engine, async (): Promise<PullTickResult> => {
    let headBefore: string;
    try {
      headBefore = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });
    } catch (e) {
      return { skipped: 'error', error: `rev-parse before pull: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
      git(repo.repoPath, ['pull', '--ff-only', 'origin', repo.branch], { env: repo.gitEnv });
    } catch (e) {
      // Non-FF means someone else's write window finished mid-pull, or
      // a force-push (which isn't a workflow we expect against master).
      // Either way, leave HEAD where it is and try again next tick.
      const msg = e instanceof Error ? e.message : String(e);
      return { skipped: 'error', error: `git pull --ff-only: ${msg.slice(0, 200)}` };
    }

    let headAfter: string;
    try {
      headAfter = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });
    } catch (e) {
      return { skipped: 'error', error: `rev-parse after pull: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (headBefore === headAfter) {
      return { changed: false };
    }

    try {
      await performSync(engine, {
        repoPath: repo.repoPath,
        sourceId: DENT_SOURCE_ID,
        noPull: true,
        noEmbed: true,
      });
    } catch (e) {
      // Markdown is canonical and is now in our local clone; the
      // index will catch up on the next tick or the next agent write.
      const msg = e instanceof Error ? e.message : String(e);
      return { skipped: 'error', error: `performSync after pull: ${msg.slice(0, 200)}` };
    }

    return { changed: true, fromCommit: headBefore, toCommit: headAfter };
  });

  if (!lockResult.acquired) return { skipped: 'busy' };
  return lockResult.result!;
}

/**
 * Start the scheduled-pull loop. Returns a handle that stops it.
 *
 * The first tick fires after `intervalMs` (NOT immediately) so it
 * doesn't redundantly pull right after `ensureDataRepo` already pulled
 * at boot.
 *
 * Errors inside `pullAndSyncOnce` are swallowed — interval timers
 * dying on a transient hiccup is the worst outcome here. We log and
 * keep going.
 */
export function startScheduledPull(
  engine: BrainEngine,
  intervalMs: number = DEFAULT_PULL_INTERVAL_SECONDS * 1000,
): ScheduledPullHandle {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await pullAndSyncOnce(engine);
      if ('changed' in result && result.changed) {
        console.error(
          `[markdown-writer:cron] pulled ${result.fromCommit.slice(0, 8)} → ${result.toCommit.slice(0, 8)} and re-synced`,
        );
      } else if ('skipped' in result && result.skipped === 'error') {
        console.error(`[markdown-writer:cron] tick skipped: ${result.error}`);
      }
      // 'busy' and 'changed: false' are silent — they're the common case.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer:cron] tick threw: ${msg}`);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // Don't keep the process alive on this timer alone — Bun will exit
  // when the HTTP server closes.
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
