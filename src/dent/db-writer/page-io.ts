/**
 * Shared read/hash primitives for the DB-direct write path (Stage A of
 * the single-Postgres-brain conversion).
 *
 * The git dual-write is retired: agent writes land straight in the DB via
 * upstream's `importFromContent`, scoped to source 'dent'. Reads render the
 * stored Page row back to canonical markdown via `serializePageToMarkdown`
 * so append/replace operate on the same text a subsequent read returns.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import { serializePageToMarkdown } from '../../core/markdown.ts';
import { DentOperationError } from '../errors.ts';

/** Canonical source id for dent pages. Moved here from markdown-writer/repo.ts
 *  (which keeps its own export until Stage B deletes that directory). */
export const DENT_SOURCE_ID = 'dent';

/** Hard cap on a single page's rendered markdown. Well under importFromContent's
 *  5MB guard; a page this large is an agent runaway, not a real page. */
export const MAX_PAGE_BYTES = 500 * 1024;

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Slug shape + traversal guard. Mirrors markdown-writer/paths.ts's
 * `slugToPath` validation but without touching the filesystem — there is
 * no repo root anymore, so we reject traversal segments structurally.
 */
export function validateSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new DentOperationError('invalid_slug', 'slug must be a non-empty string');
  }
  if (slug.endsWith('/')) {
    throw new DentOperationError('invalid_slug', `slug must not end with a slash: ${slug}`);
  }
  if (slug.startsWith('/') || slug.includes('\\')) {
    throw new DentOperationError('invalid_slug', `slug must be a relative forward-slash path: ${slug}`);
  }
  const segments = slug.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new DentOperationError('invalid_slug', `slug contains an empty or traversal segment: ${slug}`);
  }
}

export interface PageMarkdown {
  markdown: string;
  hash: string;
}

/**
 * Read a dent page and render it to canonical markdown. Returns null when
 * the page doesn't exist (or is soft-deleted).
 */
export async function readPageMarkdown(
  engine: BrainEngine,
  slug: string,
): Promise<PageMarkdown | null> {
  const page = await engine.getPage(slug, { sourceId: DENT_SOURCE_ID });
  if (!page) return null;
  const tags = await engine.getTags(slug, { sourceId: DENT_SOURCE_ID });
  const markdown = serializePageToMarkdown(page, tags);
  return { markdown, hash: hashContent(markdown) };
}

/** Shape importFromContent expects for schema-pack type inference. */
export interface ActivePackLite {
  page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }>;
}

/**
 * Best-effort active schema pack load, mirroring performSync's pattern:
 * load once per command/batch, never per page; any failure falls through
 * to legacy prefix typing.
 */
export async function loadActivePackBestEffort(): Promise<ActivePackLite | undefined> {
  try {
    const { loadActivePack } = await import('../../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../../core/config.ts');
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: false, // db-writer runs server-side / trusted CLI only
      sourceId: DENT_SOURCE_ID,
    });
    return { page_types: resolved.manifest.page_types };
  } catch {
    return undefined;
  }
}
