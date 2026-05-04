/**
 * Batched markdown-writer transaction.
 *
 * Use this when an orchestrator (the RegFox cron, the legacy-SQL importer,
 * any future bulk path) wants to land N file edits as ONE git commit and
 * ONE push, instead of N commits + N pushes.
 *
 * Without this, every per-registrant append re-acquires the repo lock,
 * pulls, commits one bullet, pushes, and runs performSync. At 50 registrants
 * per cron tick that's 50 commits and 50 pushes — fragile under concurrent
 * editors and produces a useless "agent: append <slug>" history wall.
 *
 * Lifecycle:
 *   1. Acquire repo lock (returns `{status: 'busy'}` if held — caller retries).
 *   2. `git pull --ff-only origin <branch>` once.
 *   3. Run the user callback. Inside, call `batch.appendToPage(args)` and
 *      `batch.replacePage(args)` as many times as needed. Each splices its
 *      target file and runs `git add`. No commit. No push. No sync.
 *   4. If `git status --porcelain` is non-empty, single commit + push (with
 *      one rebase-retry) + one performSync to refresh the Postgres index.
 *   5. Release the lock.
 *
 * Per-call returns are intentionally minimal — there is no commit_sha
 * yet because the commit hasn't happened. If a caller needs that, batches
 * aren't the right primitive; use the standalone `appendToPage` instead.
 *
 * `replacePage` inside a batch still honors `expected_prior_hash` (reads
 * the file fresh and compares). Returns `page_changed` without staging if
 * the file diverged. Other slugs in the same batch keep going.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { performSync } from '../../commands/sync.ts';
import { slugToPath } from './paths.ts';
import { git } from './git-helpers.ts';
import { withRepoLock } from './lock.ts';
import { getRepoContext, DENT_SOURCE_ID } from './repo.ts';
import { spliceFragment, type AppendArgs, type AppendResult } from './append.ts';
import { hashContent, type ReplaceArgs, type ReplaceResult } from './replace.ts';

export interface BatchHandle {
  /** Splice + git-add. No commit. Returns ok/error/page_changed only. */
  appendToPage(args: AppendArgs): BatchAppendResult;
  /** Write + git-add. No commit. Honors expected_prior_hash. */
  replacePage(args: ReplaceArgs): BatchReplaceResult;
  /** Read the current on-disk content of a slug, post-pull. Returns null
   *  if the file does not exist. Useful for caller idempotency checks
   *  (e.g. "is this Source: id already on the page"). */
  readSlug(slug: string): string | null;
  /** Override the commit message before withBatch commits. Useful when the
   *  caller wants the message to reflect counts known only at end-of-batch
   *  (e.g. "regfox-ingestor: 47 registrants, 3 pending"). The first call
   *  becomes the commit title; subsequent calls overwrite. Empty string
   *  reverts to the default. */
  setCommitMessage(title: string, note?: string): void;
}

export type BatchAppendResult =
  | { status: 'ok'; file_path: string; section_created: boolean; staged: boolean }
  | { status: 'error'; error: string };

export type BatchReplaceResult =
  | { status: 'ok'; file_path: string; created: boolean; staged: boolean }
  | { status: 'page_changed'; current_content: string; current_hash: string }
  | { status: 'error'; error: string };

export type BatchOutcome<T> =
  | { status: 'ok'; result: T; staged_files: number; commit_sha?: string; rebased: boolean; pushed: boolean; commits: number }
  | { status: 'busy' }
  | { status: 'error'; error: string; result?: T };

export interface BatchOptions {
  /** First line of the commit message. Default: `agent: batch update (N files)`. */
  commitTitle?: string;
  /** Optional body appended after a blank line. Use this for the per-batch
   *  context the orchestrator wants in the log (counts, source, etc). */
  commitNote?: string;
}

export async function withBatch<T>(
  engine: BrainEngine,
  fn: (batch: BatchHandle) => Promise<T>,
  opts: BatchOptions = {},
): Promise<BatchOutcome<T>> {
  const repo = getRepoContext();

  const lockResult = await withRepoLock(engine, async (): Promise<BatchOutcome<T>> => {
    // 1. Pull once.
    try {
      git(repo.repoPath, ['pull', '--ff-only', 'origin', repo.branch], { env: repo.gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer/batch] pull warning: ${msg.slice(0, 200)}`);
    }

    // Track what was staged so we can report counts.
    const stagedSlugs = new Set<string>();
    let dynamicTitle: string | undefined;
    let dynamicNote: string | undefined;

    const batch: BatchHandle = {
      appendToPage(args: AppendArgs): BatchAppendResult {
        if (!args.content || args.content.trim().length === 0) {
          return { status: 'error', error: 'content is empty' };
        }
        let absolutePath: string;
        let relativePath: string;
        try {
          ({ absolutePath, relativePath } = slugToPath(repo.repoPath, args.slug));
        } catch (e) {
          return { status: 'error', error: e instanceof Error ? e.message : String(e) };
        }

        let priorBody: string;
        if (existsSync(absolutePath)) {
          priorBody = readFileSync(absolutePath, 'utf-8');
        } else {
          mkdirSync(dirname(absolutePath), { recursive: true });
          const title = args.slug.split('/').pop() ?? args.slug;
          priorBody = `---\ntitle: ${title}\nslug: ${args.slug}\n---\n\n`;
        }
        const spliced = spliceFragment(priorBody, args.content, args.section);
        if (spliced.body === priorBody) {
          return { status: 'ok', file_path: relativePath, section_created: false, staged: false };
        }
        writeFileSync(absolutePath, spliced.body);
        git(repo.repoPath, ['add', '--', relativePath], { env: repo.gitEnv });
        stagedSlugs.add(args.slug);
        return { status: 'ok', file_path: relativePath, section_created: spliced.sectionCreated, staged: true };
      },

      replacePage(args: ReplaceArgs): BatchReplaceResult {
        if (typeof args.content !== 'string' || args.content.length === 0) {
          return { status: 'error', error: 'content is empty' };
        }
        let absolutePath: string;
        let relativePath: string;
        try {
          ({ absolutePath, relativePath } = slugToPath(repo.repoPath, args.slug));
        } catch (e) {
          return { status: 'error', error: e instanceof Error ? e.message : String(e) };
        }

        const exists = existsSync(absolutePath);
        if (exists && args.expected_prior_hash) {
          const current = readFileSync(absolutePath, 'utf-8');
          const currentHash = hashContent(current);
          if (currentHash !== args.expected_prior_hash) {
            return { status: 'page_changed', current_content: current, current_hash: currentHash };
          }
        }
        if (!exists) {
          mkdirSync(dirname(absolutePath), { recursive: true });
        } else {
          const before = readFileSync(absolutePath, 'utf-8');
          if (before === args.content) {
            return { status: 'ok', file_path: relativePath, created: false, staged: false };
          }
        }
        writeFileSync(absolutePath, args.content);
        git(repo.repoPath, ['add', '--', relativePath], { env: repo.gitEnv });
        stagedSlugs.add(args.slug);
        return { status: 'ok', file_path: relativePath, created: !exists, staged: true };
      },

      readSlug(slug: string): string | null {
        let absolutePath: string;
        try {
          ({ absolutePath } = slugToPath(repo.repoPath, slug));
        } catch {
          return null;
        }
        return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : null;
      },

      setCommitMessage(title: string, note?: string): void {
        dynamicTitle = title.length > 0 ? title : undefined;
        dynamicNote = note;
      },
    };

    // 3. Run user fn.
    let userResult: T;
    try {
      userResult = await fn(batch);
    } catch (e) {
      // Reset any staged changes before unlocking — keeps the working tree clean.
      try { git(repo.repoPath, ['reset', '--hard', 'HEAD'], { env: repo.gitEnv }); } catch { /* noop */ }
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', error: `batch callback threw: ${msg.slice(0, 300)}` };
    }

    // 4. Anything to commit?
    let porcelain = '';
    try {
      porcelain = git(repo.repoPath, ['status', '--porcelain'], { env: repo.gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', error: `git status failed: ${msg.slice(0, 200)}`, result: userResult };
    }
    if (porcelain.trim().length === 0) {
      return { status: 'ok', result: userResult, staged_files: 0, rebased: false, pushed: false, commits: 0 };
    }

    const stagedCount = stagedSlugs.size;
    const title = dynamicTitle ?? opts.commitTitle ?? `agent: batch update (${stagedCount} files)`;
    const note = dynamicNote ?? opts.commitNote;
    const commitMsg = note ? `${title}\n\n${note}` : title;
    try {
      git(repo.repoPath, ['commit', '-m', commitMsg], { env: repo.gitEnv });
    } catch (e) {
      try { git(repo.repoPath, ['reset', '--hard', 'HEAD'], { env: repo.gitEnv }); } catch { /* noop */ }
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', error: `commit failed: ${msg.slice(0, 200)}`, result: userResult };
    }

    // 5. Push with rebase-retry.
    let rebased = false;
    try {
      git(repo.repoPath, ['push', 'origin', `HEAD:${repo.branch}`], { env: repo.gitEnv });
    } catch {
      try {
        git(repo.repoPath, ['pull', '--rebase', 'origin', repo.branch], { env: repo.gitEnv });
        git(repo.repoPath, ['push', 'origin', `HEAD:${repo.branch}`], { env: repo.gitEnv });
        rebased = true;
      } catch (e2) {
        try { git(repo.repoPath, ['rebase', '--abort'], { env: repo.gitEnv }); } catch { /* noop */ }
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return { status: 'error', error: `push failed after rebase: ${msg.slice(0, 300)}`, result: userResult };
      }
    }
    const commitSha = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });

    // 6. One sync at end.
    try {
      await performSync(engine, { repoPath: repo.repoPath, sourceId: DENT_SOURCE_ID, noPull: true, noEmbed: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer/batch] performSync warning: ${msg.slice(0, 200)}`);
    }

    return {
      status: 'ok',
      result: userResult,
      staged_files: stagedCount,
      commit_sha: commitSha,
      rebased,
      pushed: true,
      commits: 1,
    };
  });

  if (!lockResult.acquired) return { status: 'busy' };
  return lockResult.result!;
}
