/**
 * Pure pointer-card builder: Drive file metadata → a brain page (frontmatter +
 * tiny body). NEVER includes document body or cell values — only metadata, so
 * the card stays a router entry, not a content mirror.
 *
 * The body is deliberately minimal so the put_page embedding is dominated by
 * title + path + owner — that's the routing signal an agent searches against.
 *
 * Determinism: the crawl timestamp is injected (not read from the clock here)
 * so the output is a pure function of its inputs and unit-testable.
 */

import type { DriveFile, PointerCard, SheetSchema } from './types.ts';
import { CREATED_VIA, IDENTITY_KEY, cardTypeForMime } from './types.ts';

/** Lowercase, ASCII-fold, collapse non-alphanumeric runs to single hyphen. */
export function kebabize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short stable suffix from the opaque Drive fileId, for slug uniqueness. */
function shortId(fileId: string): string {
  const cleaned = fileId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned.slice(-6) || 'noid';
}

/**
 * Drive file titles/paths are untrusted external input that lands in a brain
 * page an agent later reads. Collapse to a single line so a title can't inject
 * extra markdown headings/lines in the body. (Frontmatter is separately safe —
 * js-yaml safeDump escapes it.)
 */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** oneLine + escape table-cell pipes so a name with `|` can't break the table. */
function cell(s: string): string {
  return oneLine(s).replace(/\|/g, '\\|');
}

export interface BuildCardParams {
  file: DriveFile;
  /** Human Drive path from path-resolver, e.g. "My Drive/Strategy". */
  path: string;
  /** Injected ISO-8601 crawl timestamp. */
  crawledAt: string;
  /** Present for sheets only; structural metadata, no cell values. */
  sheetSchema?: SheetSchema;
}

export function buildCard(params: BuildCardParams): PointerCard {
  const { file, path, crawledAt, sheetSchema } = params;
  const type = cardTypeForMime(file.mimeType);
  const kind = type === 'gdrive-sheet' ? 'sheet' : 'doc';
  const title = (file.name ?? '').trim() || 'Untitled';

  const titleSlug = kebabize(title) || 'untitled';
  const slug = `gdrive/${kind}/${titleSlug}-${shortId(file.id)}`;

  const owner = file.owners?.[0];
  const ownerEmail = owner?.emailAddress?.toLowerCase();
  const modifiedTime = file.modifiedTime ?? crawledAt;

  const frontmatter: Record<string, unknown> = {
    title,
    slug,
    type,
    created_via: CREATED_VIA,
    [IDENTITY_KEY]: file.id,
    gdrive_mime_type: file.mimeType,
    drive_path: path,
    modified_time: modifiedTime,
    last_crawled: crawledAt,
  };
  if (ownerEmail) frontmatter.owner_email = ownerEmail;
  if (owner?.displayName) frontmatter.owner_name = owner.displayName;
  if (file.webViewLink) frontmatter.web_view_link = file.webViewLink;
  if (file.driveId) frontmatter.drive_id = file.driveId;
  if (sheetSchema) {
    frontmatter.sheet_tabs = sheetSchema.tabs;
    frontmatter.sheet_dimensions = sheetSchema.dimensions;
  }

  return { slug, type, fileId: file.id, modifiedTime, frontmatter, body: buildBody({ title, kind, ownerEmail, path, modifiedTime, file, sheetSchema }) };
}

function buildBody(args: {
  title: string;
  kind: 'doc' | 'sheet';
  ownerEmail?: string;
  path: string;
  modifiedTime: string;
  file: DriveFile;
  sheetSchema?: SheetSchema;
}): string {
  const { title, kind, ownerEmail, path, modifiedTime, file, sheetSchema } = args;
  const noun = kind === 'sheet' ? 'Sheet' : 'Doc';
  const rows: string[] = [
    `| Field | Value |`,
    `| --- | --- |`,
    `| Owner | ${cell(ownerEmail ?? '(shared drive)')} |`,
    `| Path | ${cell(path)} |`,
    `| Modified | ${cell(modifiedTime)} |`,
  ];
  if (sheetSchema && sheetSchema.tabs.length > 0) {
    rows.push(`| Tabs | ${cell(sheetSchema.tabs.join(', '))} |`);
  }
  const link = file.webViewLink ? `\n\n[Open in Google Drive](${file.webViewLink})\n` : '\n';
  // Trailing fileId marker guarantees a unique content_hash even for two files
  // with byte-identical visible metadata (else the dedup layer WARN-spams).
  const marker = `\n<!-- gdrive_file_id:${file.id} -->\n`;
  return (
    `# ${oneLine(title)}\n\n` +
    `Pointer card for a Google ${noun}. The live source lives in Google Drive — ` +
    `read it there. This card exists only so agents can find it.\n\n` +
    rows.join('\n') +
    '\n' +
    link +
    marker
  );
}
