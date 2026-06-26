/**
 * DB-direct append (Stage A of the single-Postgres-brain conversion).
 *
 * Replaces markdown-writer/append.ts's git pull/commit/push flow: the page
 * is read from the DB, the fragment is spliced into its canonical markdown
 * rendering, and the result lands via upstream's `importFromContent`
 * (source 'dent'). Versioning comes from the page_versions table
 * (get_versions), not git history.
 *
 * Concurrency: a per-slug DB lock (`dent-page:<slug>`) serializes writers
 * on the same page; `busy` keeps the old contract (op layer maps it to a
 * rate_limited retry hint).
 */

import type { BrainEngine } from '../../core/engine.ts';
import { importFromContent } from '../../core/import-file.ts';
import { tryAcquireDbLock } from '../../core/db-lock.ts';
import { DentOperationError } from '../errors.ts';
import {
  DENT_SOURCE_ID,
  MAX_PAGE_BYTES,
  hashContent,
  readPageMarkdown,
  validateSlug,
  loadActivePackBestEffort,
  type ActivePackLite,
} from './page-io.ts';

export interface AppendArgs {
  slug: string;
  /** Optional heading text. Matched case-insensitively against `## …` lines.
   *  When omitted, append at end-of-file. */
  section?: string;
  /** The fragment to splice in. Trailing newline normalized internally. */
  content: string;
  /** When true (and `section` is set): REPLACE the section instead of appending
   *  under it — every existing occurrence of the heading is removed and ONE
   *  fresh section is written with `content`. Makes a section write idempotent
   *  and collapses accidental duplicates (e.g. a meeting's `## Mentioned`). */
  replace?: boolean;
  /** Advisory note. Accepted for caller compat (the old path put it in the
   *  git commit message); there is no commit anymore, so it is not persisted. */
  commitNote?: string;
}

export type AppendResult =
  | { status: 'ok'; content_hash: string; file_path: string; section_created: boolean; created: boolean }
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
 *   - When `replace` is true: every existing occurrence of the section is
 *     removed and ONE fresh section is written at EOF with the fragment. This
 *     makes the write idempotent and collapses accidental duplicate sections.
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
  replace = false,
): { body: string; sectionCreated: boolean } {
  const fragNormalized = fragment.endsWith('\n') ? fragment : fragment + '\n';

  if (!section) {
    const sep = body.length === 0 ? '' : (body.endsWith('\n\n') ? '' : (body.endsWith('\n') ? '\n' : '\n\n'));
    return { body: body + sep + fragNormalized, sectionCreated: false };
  }

  const headingText = section.replace(/^#+\s*/, '').trim();
  const lines = body.split('\n');
  const sectionRe = new RegExp(`^##\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

  if (replace) {
    // Strip EVERY occurrence of the section (heading through the line before the
    // next `##`/`#` heading or EOF), then write one fresh section at EOF. This
    // is idempotent and collapses duplicates that an append-only path created.
    const kept: string[] = [];
    let i = 0;
    let removedAny = false;
    while (i < lines.length) {
      if (sectionRe.test(lines[i])) {
        removedAny = true;
        i++; // drop the heading
        while (i < lines.length && !/^#{1,2}\s/.test(lines[i])) i++; // drop its body
      } else {
        kept.push(lines[i]);
        i++;
      }
    }
    const cleaned = kept.join('\n').replace(/\n+$/, '');
    const sep = cleaned.length === 0 ? '' : '\n\n';
    return { body: cleaned + sep + `## ${headingText}\n\n` + fragNormalized, sectionCreated: !removedAny };
  }

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
export function bootstrapBody(slug: string): string {
  const title = slug.split('/').pop() ?? slug;
  return `---\ntitle: ${title}\nslug: ${slug}\n---\n\n`;
}

export function guardPageSize(body: string): void {
  const bytes = Buffer.byteLength(body, 'utf-8');
  if (bytes > MAX_PAGE_BYTES) {
    throw new DentOperationError(
      'content_too_large',
      `Page would be ${bytes} bytes after the write (max ${MAX_PAGE_BYTES}). Split the content across smaller pages.`,
    );
  }
}

export async function appendToPageDb(
  engine: BrainEngine,
  args: AppendArgs,
  /** Pre-loaded schema pack (batch path). Loaded best-effort when omitted. */
  activePack?: ActivePackLite,
): Promise<AppendResult> {
  if (!args.content || args.content.trim().length === 0) {
    return { status: 'error', error: 'content_to_append is empty' };
  }
  validateSlug(args.slug);

  const lock = await tryAcquireDbLock(engine, `dent-page:${args.slug}`);
  if (!lock) return { status: 'busy' };
  try {
    const prior = await readPageMarkdown(engine, args.slug);
    const created = prior == null;
    const priorBody = prior?.markdown ?? bootstrapBody(args.slug);
    const spliced = spliceFragment(priorBody, args.content, args.section, args.replace === true);
    guardPageSize(spliced.body);

    const pack = activePack ?? await loadActivePackBestEffort();
    const imported = await importFromContent(engine, args.slug, spliced.body, {
      sourceId: DENT_SOURCE_ID,
      noEmbed: true,
      activePack: pack,
    });
    if (imported.status === 'error') {
      return { status: 'error', error: imported.error ?? 'import failed' };
    }

    // Hash the canonical post-write rendering so the returned hash matches
    // what a subsequent readPageMarkdown reports (the DB round-trip can
    // normalize frontmatter ordering / whitespace).
    const after = await readPageMarkdown(engine, args.slug);
    return {
      status: 'ok',
      content_hash: after?.hash ?? hashContent(spliced.body),
      file_path: `${args.slug}.md`,
      section_created: spliced.sectionCreated,
      created,
    };
  } finally {
    await lock.release();
  }
}
