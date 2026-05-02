/**
 * Full-page replace with optimistic concurrency.
 *
 * The append op handles the common case (add an observation). Replace is
 * for the rare cases where an agent must rewrite the whole page:
 *   - First-time stub creation by /dent-resolve-entity (Phase 2).
 *   - Synthesized rewrites by /dent-enrich (Phase 2).
 *
 * Optimistic concurrency: caller passes `expected_prior_hash` (sha256 of
 * the markdown the agent based its rewrite on). If the file on disk has
 * changed since the agent read it, we return `page_changed` with the
 * current content + hash so the caller can re-synthesize against the
 * fresh state.
 *
 * Brand-new pages (no file on disk) skip the hash check — there's nothing
 * to conflict with.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import { performSync } from '../../commands/sync.ts';
import { slugToPath } from './paths.ts';
import { git } from './git-helpers.ts';
import { withRepoLock } from './lock.ts';
import { getRepoContext, DENT_SOURCE_ID } from './repo.ts';

export interface ReplaceArgs {
  slug: string;
  /** Full markdown text (frontmatter + body) the agent wants to write. */
  content: string;
  /** sha256 of the markdown the agent read before synthesizing. Optional;
   *  omit only when creating a brand-new page. */
  expected_prior_hash?: string;
  /** Optional commit-message hint shown after `agent: replace <slug>`. */
  commitNote?: string;
}

export type ReplaceResult =
  | { status: 'ok'; commit_sha: string; file_path: string; created: boolean; rebased: boolean }
  | { status: 'busy' }
  | { status: 'page_changed'; current_content: string; current_hash: string }
  | { status: 'error'; error: string };

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function replacePage(
  engine: BrainEngine,
  args: ReplaceArgs,
): Promise<ReplaceResult> {
  if (typeof args.content !== 'string' || args.content.length === 0) {
    return { status: 'error', error: 'content is empty' };
  }

  const repo = getRepoContext();
  let absolutePath: string;
  let relativePath: string;
  try {
    ({ absolutePath, relativePath } = slugToPath(repo.repoPath, args.slug));
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  const lockResult = await withRepoLock(engine, async (): Promise<ReplaceResult> => {
    try {
      git(repo.repoPath, ['pull', '--ff-only', 'origin', 'master'], { env: repo.gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer] pull warning for ${args.slug}: ${msg.slice(0, 200)}`);
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
    }

    // Write — no-op short-circuit if content equals what's already on disk.
    if (exists) {
      const before = readFileSync(absolutePath, 'utf-8');
      if (before === args.content) {
        const head = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });
        return { status: 'ok', commit_sha: head, file_path: relativePath, created: false, rebased: false };
      }
    }
    writeFileSync(absolutePath, args.content);
    git(repo.repoPath, ['add', '--', relativePath], { env: repo.gitEnv });

    const commitMsg = args.commitNote
      ? `agent: replace ${args.slug}\n\n${args.commitNote}`
      : `agent: replace ${args.slug}`;
    git(repo.repoPath, ['commit', '-m', commitMsg], { env: repo.gitEnv });

    let rebased = false;
    try {
      git(repo.repoPath, ['push', 'origin', 'HEAD:master'], { env: repo.gitEnv });
    } catch {
      try {
        git(repo.repoPath, ['pull', '--rebase', 'origin', 'master'], { env: repo.gitEnv });
        git(repo.repoPath, ['push', 'origin', 'HEAD:master'], { env: repo.gitEnv });
        rebased = true;
      } catch (e2) {
        try { git(repo.repoPath, ['rebase', '--abort'], { env: repo.gitEnv }); } catch { /* noop */ }
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return { status: 'error', error: `push failed after rebase: ${msg.slice(0, 300)}` };
      }
    }

    const commitSha = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });

    try {
      await performSync(engine, { repoPath: repo.repoPath, sourceId: DENT_SOURCE_ID, noPull: true, noEmbed: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer] performSync warning after replace ${args.slug}: ${msg.slice(0, 200)}`);
    }

    return { status: 'ok', commit_sha: commitSha, file_path: relativePath, created: !exists, rebased };
  });

  if (!lockResult.acquired) return { status: 'busy' };
  return lockResult.result!;
}
