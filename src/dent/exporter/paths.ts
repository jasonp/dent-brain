/**
 * Slug ↔ filesystem path translation for the dent-brain-data export mirror.
 *
 * Default mapping is `<repo>/<slug>.md`. The slug is treated as a
 * relative path (forward-slash separated). We re-resolve against the
 * repo root and reject anything that escapes — defense against a
 * slug row containing `../../etc/passwd` or `entities/../../foo`.
 *
 * Moved from markdown-writer/paths.ts in Stage B of the single-brain
 * conversion: the write path validates slugs structurally in
 * db-writer/page-io.ts; this filesystem-aware variant only serves the
 * one-way DB→git exporter now.
 */

import { resolve, relative, sep } from 'path';

export interface ResolvedPath {
  /** Absolute path on disk where the markdown file lives. */
  absolutePath: string;
  /** Path relative to the repo root, forward-slash separated (matches what
   * `git add` and `performSync`'s diff machinery expect). */
  relativePath: string;
}

export function slugToPath(repoRoot: string, slug: string): ResolvedPath {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new Error('slug must be a non-empty string');
  }
  if (slug.endsWith('/')) {
    throw new Error(`slug must not end with a slash: ${slug}`);
  }

  const repoAbs = resolve(repoRoot);
  const candidate = resolve(repoAbs, `${slug}.md`);
  const rel = relative(repoAbs, candidate);

  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(repoAbs, rel) !== candidate) {
    throw new Error(`slug resolves outside repo root: ${slug}`);
  }

  // Forward-slash form for git + sync (Windows would diverge here, but
  // the dent server runs on Linux/macOS only).
  return { absolutePath: candidate, relativePath: rel.split(sep).join('/') };
}
