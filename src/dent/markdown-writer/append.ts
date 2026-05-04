/**
 * Append a fragment to a markdown page in the dent-brain-data clone.
 *
 * The append-by-default model (PLAN v2.0): instead of three-way merging
 * a full rewrite, agents append individual observations / bullets to a
 * named section (or EOF). Append commutes — concurrent agent writes
 * stack up via `git pull --rebase` rather than conflict.
 *
 * Flow (under the repo lock from lock.ts):
 *   1. git pull --ff-only
 *   2. Read the file (or create the bones if missing).
 *   3. Splice content_to_append at the requested location.
 *   4. Write file, git add, git commit.
 *   5. Push with rebase-retry. On rebase, re-splice on top of the
 *      now-merged file before retrying push.
 *   6. performSync({sourceId: 'dent'}) to refresh the Postgres index.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { performSync } from '../../commands/sync.ts';
import { slugToPath } from './paths.ts';
import { git } from './git-helpers.ts';
import { withRepoLock } from './lock.ts';
import { getRepoContext, DENT_SOURCE_ID } from './repo.ts';

export interface AppendArgs {
  slug: string;
  /** Optional heading text. Matched case-insensitively against `## …` lines.
   *  When omitted, append at end-of-file. */
  section?: string;
  /** The fragment to splice in. Trailing newline normalized internally. */
  content: string;
  /** Optional commit-message hint shown after `agent: append <slug>`. */
  commitNote?: string;
}

export type AppendResult =
  | { status: 'ok'; commit_sha: string; file_path: string; section_created: boolean; rebased: boolean }
  | { status: 'busy' }
  | { status: 'error'; error: string };

/**
 * Splice `fragment` into `body` at the appropriate location.
 *
 * If `section` is set:
 *   - Find the first `## <section>` heading (case-insensitive, leading
 *     `##` optional in the input).
 *   - Append the fragment just before the next `## `, the next `# `,
 *     or EOF — whichever comes first.
 *   - If the section is missing, create it at EOF and append under it.
 *
 * If `section` is null:
 *   - Append the fragment at EOF.
 *
 * The fragment is wrapped with a leading blank line if the prior content
 * doesn't already end with one, so consecutive appends don't run together.
 */
export function spliceFragment(
  body: string,
  fragment: string,
  section?: string,
): { body: string; sectionCreated: boolean } {
  const fragNormalized = fragment.endsWith('\n') ? fragment : fragment + '\n';

  if (!section) {
    const sep = body.length === 0 ? '' : (body.endsWith('\n\n') ? '' : (body.endsWith('\n') ? '\n' : '\n\n'));
    return { body: body + sep + fragNormalized, sectionCreated: false };
  }

  const headingText = section.replace(/^#+\s*/, '').trim();
  const lines = body.split('\n');
  const sectionRe = new RegExp(`^##\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i])) {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart === -1) {
    // Create the section at EOF.
    const sep = body.length === 0 ? '' : (body.endsWith('\n\n') ? '' : (body.endsWith('\n') ? '\n' : '\n\n'));
    const newBody = body + sep + `## ${headingText}\n\n` + fragNormalized;
    return { body: newBody, sectionCreated: true };
  }

  // Find the end of this section: first subsequent `## ` or `# ` heading.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Trim trailing blank lines inside the section so the splice doesn't
  // accumulate growing whitespace on every append.
  let insertAt = sectionEnd;
  while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }

  const fragLines = fragNormalized.replace(/\n$/, '').split('\n');
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  // Ensure exactly one blank line between existing content and fragment.
  if (before.length > 0 && before[before.length - 1].trim() !== '') {
    before.push('');
  }
  // And one blank line after the fragment before the next heading.
  const afterWithGap = (after.length > 0 && after[0].trim() !== '') ? ['', ...after] : after;
  return { body: [...before, ...fragLines, ...afterWithGap].join('\n'), sectionCreated: false };
}

/**
 * Initial body for a brand-new page. Kept deliberately minimal — pages
 * are unstructured (PLAN v2.0 principle 2). Frontmatter only when the
 * caller passes a section (so the section heading isn't homeless).
 */
function bootstrapBody(slug: string): string {
  const title = slug.split('/').pop() ?? slug;
  return `---\ntitle: ${title}\nslug: ${slug}\n---\n\n`;
}

export async function appendToPage(
  engine: BrainEngine,
  args: AppendArgs,
): Promise<AppendResult> {
  if (!args.content || args.content.trim().length === 0) {
    return { status: 'error', error: 'content_to_append is empty' };
  }

  const repo = getRepoContext();
  let absolutePath: string;
  let relativePath: string;
  try {
    ({ absolutePath, relativePath } = slugToPath(repo.repoPath, args.slug));
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  const lockResult = await withRepoLock(engine, async (): Promise<AppendResult> => {
    // 1. Pull latest.
    try {
      git(repo.repoPath, ['pull', '--ff-only', 'origin', repo.branch], { env: repo.gitEnv });
    } catch (e) {
      // Non-FF or transient — log and proceed; push step will catch real divergence.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer] pull warning for ${args.slug}: ${msg.slice(0, 200)}`);
    }

    // 2. Read existing body or bootstrap a new page.
    let priorBody: string;
    if (existsSync(absolutePath)) {
      priorBody = readFileSync(absolutePath, 'utf-8');
    } else {
      mkdirSync(dirname(absolutePath), { recursive: true });
      priorBody = bootstrapBody(args.slug);
    }

    // 3. Splice in the fragment.
    const spliced = spliceFragment(priorBody, args.content, args.section);

    // 4. Write + commit.
    writeFileSync(absolutePath, spliced.body);
    git(repo.repoPath, ['add', '--', relativePath], { env: repo.gitEnv });

    // If add produced no staged change (e.g. caller appended an exact dupe),
    // skip the commit/push but still return success — the caller's intent
    // (the bullet exists in the page) is satisfied.
    let stagedDiff = '';
    try {
      stagedDiff = git(repo.repoPath, ['diff', '--cached', '--name-only', '--', relativePath], { env: repo.gitEnv });
    } catch {
      stagedDiff = '';
    }
    if (stagedDiff.length === 0) {
      const head = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });
      return { status: 'ok', commit_sha: head, file_path: relativePath, section_created: false, rebased: false };
    }

    const commitMsg = args.commitNote
      ? `agent: append ${args.slug}\n\n${args.commitNote}`
      : `agent: append ${args.slug}`;
    git(repo.repoPath, ['commit', '-m', commitMsg], { env: repo.gitEnv });

    // 5. Push with rebase-retry. Append commutes, so on rebase we just
    //    re-splice on top of whatever landed and re-commit if the file
    //    moved during the pull-rebase. The pull-rebase itself replays
    //    our commit, but if a sibling agent appended to the SAME slug,
    //    git's auto-merge handles it (different lines). The retry path
    //    below covers the rare case where it can't.
    let rebased = false;
    let pushed = false;
    try {
      git(repo.repoPath, ['push', 'origin', `HEAD:${repo.branch}`], { env: repo.gitEnv });
      pushed = true;
    } catch {
      try {
        git(repo.repoPath, ['pull', '--rebase', 'origin', repo.branch], { env: repo.gitEnv });
        git(repo.repoPath, ['push', 'origin', `HEAD:${repo.branch}`], { env: repo.gitEnv });
        rebased = true;
        pushed = true;
      } catch (e2) {
        // Rebase conflict or auth failure. Abort the rebase to leave the
        // working tree clean for the next attempt.
        try { git(repo.repoPath, ['rebase', '--abort'], { env: repo.gitEnv }); } catch { /* noop */ }
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return { status: 'error', error: `push failed after rebase: ${msg.slice(0, 300)}` };
      }
    }
    if (!pushed) {
      return { status: 'error', error: 'push not completed (unknown state)' };
    }

    const commitSha = git(repo.repoPath, ['rev-parse', 'HEAD'], { env: repo.gitEnv });

    // 6. Refresh the Postgres index for this slug. performSync's diff
    //    walker picks up the one changed file. Failures here are
    //    non-fatal — markdown is canonical and already committed.
    try {
      await performSync(engine, { repoPath: repo.repoPath, sourceId: DENT_SOURCE_ID, noPull: true, noEmbed: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[markdown-writer] performSync warning after append ${args.slug}: ${msg.slice(0, 200)}`);
    }

    return {
      status: 'ok',
      commit_sha: commitSha,
      file_path: relativePath,
      section_created: spliced.sectionCreated,
      rebased,
    };
  });

  if (!lockResult.acquired) return { status: 'busy' };
  return lockResult.result!;
}
