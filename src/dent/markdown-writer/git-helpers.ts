/**
 * Thin wrappers around `git` for the dent-brain-data clone.
 *
 * Mirrors `src/commands/sync.ts`'s shape (execFileSync with -C), but
 * routes the SSH command through whatever `GIT_SSH_COMMAND` env we
 * set at boot in `repo.ts` — that's how the deploy key is presented
 * to GitHub for clone/pull/push.
 *
 * All commands run synchronously: agent writes are inherently
 * serialized (DB lock guards the critical section), and `execFileSync`
 * makes error handling drastically simpler than spawning.
 */

import { execFileSync } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitOptions {
  /** Optional override for the env passed to git (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Timeout in ms (default: 30s). */
  timeoutMs?: number;
}

export function git(repoPath: string, args: string[], opts: GitOptions = {}): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: opts.env ?? process.env,
  }).trim();
}

/** Run a git command without throwing — returns null on non-zero exit.
 * Useful for "is this a git repo" probes. */
export function tryGit(repoPath: string, args: string[], opts: GitOptions = {}): string | null {
  try {
    return git(repoPath, args, opts);
  } catch {
    return null;
  }
}

/**
 * Push with a single rebase-retry on remote rejection.
 *
 * The append-by-default model means concurrent writes commute. If our
 * push is rejected because someone else pushed first, we:
 *   1. `git pull --rebase origin <branch>` — replays our commit on top.
 *   2. Re-push.
 *
 * If the second push still fails, give up and return false. The caller
 * decides whether to surface a `merge_conflict` error to the agent or
 * (in append's case) ask the agent to retry from scratch.
 *
 * The caller is responsible for re-applying its in-memory append on
 * top of the post-rebase file before calling this — see append.ts.
 * Here we only handle the push.
 */
export function pushWithRetry(repoPath: string, branch: string, opts: GitOptions = {}): { ok: boolean; rebased: boolean; error?: string } {
  try {
    git(repoPath, ['push', 'origin', `HEAD:${branch}`], opts);
    return { ok: true, rebased: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      git(repoPath, ['pull', '--rebase', 'origin', branch], opts);
      git(repoPath, ['push', 'origin', `HEAD:${branch}`], opts);
      return { ok: true, rebased: true };
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      return { ok: false, rebased: true, error: `push failed after rebase: ${msg2} (initial: ${msg.slice(0, 200)})` };
    }
  }
}
