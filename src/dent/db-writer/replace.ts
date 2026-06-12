/**
 * DB-direct full-page replace with optimistic concurrency (Stage A of the
 * single-Postgres-brain conversion).
 *
 * Optimistic concurrency: caller passes `expected_prior_hash` (sha256 of the
 * canonical markdown the agent read before synthesizing). If the page's
 * current rendering differs, we return `page_changed` with the current
 * content + hash so the caller re-synthesizes against fresh state.
 *
 * Brand-new pages (no row) skip the hash check — nothing to conflict with.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { importFromContent } from '../../core/import-file.ts';
import { tryAcquireDbLock } from '../../core/db-lock.ts';
import {
  DENT_SOURCE_ID,
  hashContent,
  readPageMarkdown,
  validateSlug,
  loadActivePackBestEffort,
  type ActivePackLite,
} from './page-io.ts';
import { guardPageSize } from './append.ts';

export interface ReplaceArgs {
  slug: string;
  /** Full markdown text (frontmatter + body) the agent wants to write. */
  content: string;
  /** sha256 of the markdown the agent read before synthesizing. Optional;
   *  omit only when creating a brand-new page. */
  expected_prior_hash?: string;
  /** Advisory note. Accepted for caller compat (the old path put it in the
   *  git commit message); there is no commit anymore, so it is not persisted. */
  commitNote?: string;
}

export type ReplaceResult =
  | { status: 'ok'; content_hash: string; file_path: string; created: boolean }
  | { status: 'busy' }
  | { status: 'page_changed'; current_content: string; current_hash: string }
  | { status: 'error'; error: string };

export async function replacePageDb(
  engine: BrainEngine,
  args: ReplaceArgs,
  /** Pre-loaded schema pack (batch path). Loaded best-effort when omitted. */
  activePack?: ActivePackLite,
): Promise<ReplaceResult> {
  if (typeof args.content !== 'string' || args.content.length === 0) {
    return { status: 'error', error: 'content is empty' };
  }
  validateSlug(args.slug);
  guardPageSize(args.content);

  const lock = await tryAcquireDbLock(engine, `dent-page:${args.slug}`);
  if (!lock) return { status: 'busy' };
  try {
    const current = await readPageMarkdown(engine, args.slug);
    if (current && args.expected_prior_hash && current.hash !== args.expected_prior_hash) {
      return { status: 'page_changed', current_content: current.markdown, current_hash: current.hash };
    }
    // No-op short-circuit when the new content is byte-identical.
    if (current && current.markdown === args.content) {
      return { status: 'ok', content_hash: current.hash, file_path: `${args.slug}.md`, created: false };
    }

    const pack = activePack ?? await loadActivePackBestEffort();
    const imported = await importFromContent(engine, args.slug, args.content, {
      sourceId: DENT_SOURCE_ID,
      noEmbed: true,
      activePack: pack,
    });
    if (imported.status === 'error') {
      return { status: 'error', error: imported.error ?? 'import failed' };
    }

    const after = await readPageMarkdown(engine, args.slug);
    return {
      status: 'ok',
      content_hash: after?.hash ?? hashContent(args.content),
      file_path: `${args.slug}.md`,
      created: current == null,
    };
  } finally {
    await lock.release();
  }
}
