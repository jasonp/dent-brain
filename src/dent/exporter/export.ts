/**
 * One-way DB→git export (single-brain Stage B).
 *
 * The Postgres brain is canonical; dent-brain-data is a derived mirror so
 * teammates can browse/grep the brain on GitHub. `exportBrainToGit`:
 *
 *   1. Takes the `dent-export` DB lock (skips with {status:'busy'} if held).
 *   2. `git pull --ff-only` (tolerated failure — continue with local state).
 *   3. Renders every live page (source 'dent', deleted_at IS NULL) to
 *      canonical markdown via db-writer's readPageMarkdown and writes
 *      `<repo>/<slug>.md` atomically (tmp + rename). Flat slug→path layout.
 *   4. Prunes stale files. MANAGED-FILE RULE: the exporter owns every
 *      `*.md` file EXCEPT (a) files at the repo root (README.md,
 *      DENT_SCHEMA.md, etc. are human-owned), (b) any path containing a
 *      segment that starts with '.' or '_' (.git/, .github/, _meta/ …).
 *      A managed file whose round-tripped slug has no live DB row is
 *      deleted. Non-.md files are never touched.
 *   5. If `git status --porcelain` is non-empty: one `git add -A` + commit
 *      ("brain-export: N changed, M deleted") + push with a single
 *      pull --rebase retry.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { tryAcquireDbLock } from '../../core/db-lock.ts';
import { DENT_SOURCE_ID, readPageMarkdown } from '../db-writer/page-io.ts';
import { slugToPath } from './paths.ts';
import { git } from './git-helpers.ts';
import type { MirrorRepoContext } from './repo.ts';

export const DENT_EXPORT_LOCK_ID = 'dent-export';

export type ExportResult =
  | { status: 'ok'; written: number; deleted: number; committed: boolean; commit_sha?: string; pages: number }
  | { status: 'busy' }
  | { status: 'error'; error: string };

/**
 * Is this repo-relative path (forward-slash) one the exporter manages?
 * See the MANAGED-FILE RULE in the file header.
 */
export function isManagedPath(relPath: string): boolean {
  if (!relPath.endsWith('.md')) return false;
  const segments = relPath.split('/');
  if (segments.length < 2) return false; // repo-root files are human-owned
  if (segments.some((s) => s.startsWith('.') || s.startsWith('_'))) return false;
  return true;
}

/** Recursively collect managed `*.md` files, repo-relative, forward-slash. */
function collectManagedFiles(repoRoot: string, relDir = ''): string[] {
  const out: string[] = [];
  const absDir = relDir ? join(repoRoot, relDir) : repoRoot;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    // Skip dot/underscore segments at every level (covers .git, _meta…).
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectManagedFiles(repoRoot, rel));
    } else if (entry.isFile() && isManagedPath(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** Write content atomically: tmp file in the same dir, then rename. */
function writeFileAtomic(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-export-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, absPath);
}

export async function exportBrainToGit(
  engine: BrainEngine,
  repoCtx: MirrorRepoContext,
): Promise<ExportResult> {
  const lock = await tryAcquireDbLock(engine, DENT_EXPORT_LOCK_ID);
  if (!lock) return { status: 'busy' };
  try {
    const { repoPath, gitEnv, branch } = repoCtx;

    // 1. Pull (tolerate failure — export proceeds on local state and the
    // push's rebase-retry reconciles).
    try {
      git(repoPath, ['pull', '--ff-only', 'origin', branch], { env: gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[dent-exporter] pull warning: ${msg.slice(0, 200)}`);
    }

    // 2. Live page set.
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`,
      [DENT_SOURCE_ID],
    );
    const liveSlugs = new Set(rows.map((r) => r.slug));
    console.error(`[dent-exporter] exporting ${liveSlugs.size} live page(s) → ${repoPath}`);

    // 3. Render + write (only when content changed, so porcelain stays honest).
    let written = 0;
    let renderFailures = 0;
    for (const slug of liveSlugs) {
      let absolutePath: string;
      try {
        ({ absolutePath } = slugToPath(repoPath, slug));
      } catch (e) {
        renderFailures++;
        console.error(`[dent-exporter] skipping unexportable slug "${slug}": ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      try {
        const page = await readPageMarkdown(engine, slug);
        if (!page) continue; // deleted between SELECT and read — fine
        const prior = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : null;
        if (prior === page.markdown) continue;
        writeFileAtomic(absolutePath, page.markdown);
        written++;
      } catch (e) {
        renderFailures++;
        console.error(`[dent-exporter] render/write failed for "${slug}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (renderFailures > 0) {
      console.error(`[dent-exporter] ${renderFailures} page(s) failed to export this run`);
    }

    // 4. Prune managed files with no live DB row.
    let deleted = 0;
    for (const rel of collectManagedFiles(repoPath)) {
      const slug = rel.slice(0, -3); // strip ".md"
      if (liveSlugs.has(slug)) continue;
      try {
        unlinkSync(join(repoPath, rel));
        deleted++;
      } catch (e) {
        console.error(`[dent-exporter] prune failed for ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5. Commit + push if anything changed.
    const porcelain = git(repoPath, ['status', '--porcelain'], { env: gitEnv });
    if (porcelain.trim().length === 0) {
      console.error('[dent-exporter] mirror already up to date (no commit)');
      return { status: 'ok', written, deleted, committed: false, pages: liveSlugs.size };
    }

    git(repoPath, ['add', '-A'], { env: gitEnv });
    git(repoPath, ['commit', '-m', `brain-export: ${written} changed, ${deleted} deleted`], { env: gitEnv });

    // Push with one pull --rebase retry (the mirror is append-mostly; a
    // reject means a human pushed — replay our export commit on top).
    try {
      git(repoPath, ['push', 'origin', `HEAD:${branch}`], { env: gitEnv });
    } catch {
      try {
        git(repoPath, ['pull', '--rebase', 'origin', branch], { env: gitEnv });
        git(repoPath, ['push', 'origin', `HEAD:${branch}`], { env: gitEnv });
      } catch (e2) {
        try { git(repoPath, ['rebase', '--abort'], { env: gitEnv }); } catch { /* noop */ }
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return { status: 'error', error: `push failed after rebase: ${msg.slice(0, 300)}` };
      }
    }
    const commitSha = git(repoPath, ['rev-parse', 'HEAD'], { env: gitEnv });
    console.error(`[dent-exporter] pushed ${commitSha.slice(0, 8)} (${written} changed, ${deleted} deleted)`);
    return { status: 'ok', written, deleted, committed: true, commit_sha: commitSha, pages: liveSlugs.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'error', error: msg.slice(0, 500) };
  } finally {
    try { await lock.release(); } catch { /* TTL cleans up */ }
  }
}
