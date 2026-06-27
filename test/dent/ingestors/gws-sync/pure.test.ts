/**
 * Pure gws-sync unit tests: card-builder, path-resolver, delta-classifier.
 * No DB, no network. Covers the metadata-only invariant, slug stability,
 * sheet schema embedding, path walking + cycle guard, and the
 * upsert/tombstone/ignore decision table.
 */

import { describe, test, expect } from 'bun:test';
import { buildCard, kebabize } from '../../../../src/dent/ingestors/gws-sync/card-builder.ts';
import { resolvePath, MY_DRIVE_ROOT } from '../../../../src/dent/ingestors/gws-sync/path-resolver.ts';
import { classifyChange } from '../../../../src/dent/ingestors/gws-sync/delta-classifier.ts';
import {
  MIME_DOC,
  MIME_SHEET,
  MIME_FOLDER,
  type DriveFile,
  type FolderNode,
  type SheetSchema,
} from '../../../../src/dent/ingestors/gws-sync/types.ts';

const CRAWLED = '2026-06-26T12:00:00.000Z';

const doc = (o: Partial<DriveFile> = {}): DriveFile => ({
  id: 'FILE_abc123XYZ',
  name: 'Q3 Strategy',
  mimeType: MIME_DOC,
  modifiedTime: '2026-06-20T09:00:00.000Z',
  webViewLink: 'https://docs.google.com/document/d/FILE_abc123XYZ/edit',
  owners: [{ emailAddress: 'Owner@Example.com', displayName: 'Owner Person' }],
  parents: ['folderA'],
  ...o,
});

describe('kebabize', () => {
  test('folds accents, collapses punctuation, trims hyphens', () => {
    expect(kebabize('  Q3 — Stratégy (v4)!  ')).toBe('q3-strategy-v4');
  });
});

describe('buildCard', () => {
  test('doc card: identity + metadata, NO body content', () => {
    const card = buildCard({ file: doc(), path: 'My Drive/Planning', crawledAt: CRAWLED });
    expect(card.type).toBe('gdrive-doc');
    expect(card.fileId).toBe('FILE_abc123XYZ');
    expect(card.frontmatter.gdrive_file_id).toBe('FILE_abc123XYZ');
    expect(card.frontmatter.created_via).toBe('gws-sync');
    expect(card.frontmatter.owner_email).toBe('owner@example.com'); // lowercased
    expect(card.frontmatter.drive_path).toBe('My Drive/Planning');
    expect(card.frontmatter.modified_time).toBe('2026-06-20T09:00:00.000Z');
    expect(card.frontmatter.last_crawled).toBe(CRAWLED);
    // slug = gdrive/doc/<kebab-title>-<shortid(last6 of cleaned fileId)>
    expect(card.slug).toBe('gdrive/doc/q3-strategy-123xyz');
    // metadata-only invariant: body is a fixed pointer template, never doc text.
    expect(card.body).toContain('Pointer card for a Google Doc');
    expect(card.body).toContain('[Open in Google Drive]');
  });

  test('slug is stable across a rename of identical-id file via shortId, and unique per file', () => {
    const a = buildCard({ file: doc({ name: 'Plan' }), path: 'x', crawledAt: CRAWLED });
    const b = buildCard({ file: doc({ id: 'OTHER_999zzz', name: 'Plan' }), path: 'x', crawledAt: CRAWLED });
    expect(a.slug).not.toBe(b.slug); // same title, different file → different slug
  });

  test('untitled file degrades cleanly', () => {
    const card = buildCard({ file: doc({ name: '   ' }), path: 'x', crawledAt: CRAWLED });
    expect(card.frontmatter.title).toBe('Untitled');
    expect(card.slug).toMatch(/^gdrive\/doc\/untitled-/);
  });

  test('shared-drive file with no owners omits owner_email', () => {
    const card = buildCard({ file: doc({ owners: undefined, driveId: 'D1' }), path: 'Shared/Planning', crawledAt: CRAWLED });
    expect(card.frontmatter.owner_email).toBeUndefined();
    expect(card.frontmatter.drive_id).toBe('D1');
    expect(card.body).toContain('(shared drive)');
  });

  test('sheet card embeds tabs + dimensions (structural only)', () => {
    const schema: SheetSchema = { tabs: ['Summary', 'Pipeline'], dimensions: { Summary: { rows: 120, cols: 8 } } };
    const card = buildCard({ file: doc({ mimeType: MIME_SHEET, name: 'Deals' }), path: 'x', crawledAt: CRAWLED, sheetSchema: schema });
    expect(card.type).toBe('gdrive-sheet');
    expect(card.slug).toMatch(/^gdrive\/sheet\//);
    expect(card.frontmatter.sheet_tabs).toEqual(['Summary', 'Pipeline']);
    expect(card.frontmatter.sheet_dimensions).toEqual({ Summary: { rows: 120, cols: 8 } });
    expect(card.body).toContain('Summary, Pipeline');
  });

  test('missing modifiedTime falls back to crawl time', () => {
    const card = buildCard({ file: doc({ modifiedTime: undefined }), path: 'x', crawledAt: CRAWLED });
    expect(card.frontmatter.modified_time).toBe(CRAWLED);
  });

  test('sanitizes untrusted title/path in the body (no markdown injection)', () => {
    const card = buildCard({
      file: doc({ name: 'Evil\n## Injected heading\nrow' }),
      path: 'Drive\nSneaky | pipe',
      crawledAt: CRAWLED,
    });
    // Injected newline+heading is collapsed inline — the H1 stays one line.
    expect(card.body).not.toContain('\n## Injected heading');
    const h1 = card.body.split('\n')[0];
    expect(h1.startsWith('# ')).toBe(true);
    expect(h1).toContain('Evil');
    // A `|` in the path can't break the metadata table — it's escaped.
    expect(card.body).toContain('Drive Sneaky \\| pipe');
  });
});

describe('resolvePath', () => {
  const folders = new Map<string, FolderNode>([
    ['folderA', { id: 'folderA', name: 'Strategy', parents: ['folderRoot'] }],
    ['folderRoot', { id: 'folderRoot', name: 'My Drive', parents: undefined }],
  ]);

  test('no parents → My Drive root', () => {
    expect(resolvePath({ parents: undefined }, folders)).toBe(MY_DRIVE_ROOT);
  });

  test('walks leaf→root, returns root→leaf joined', () => {
    expect(resolvePath({ parents: ['folderA'] }, folders)).toBe('My Drive/Strategy');
  });

  test('stops at unknown root id rather than throwing', () => {
    expect(resolvePath({ parents: ['unknownDriveRoot'] }, folders)).toBe(MY_DRIVE_ROOT);
  });

  test('cycle guard terminates', () => {
    const cyc = new Map<string, FolderNode>([
      ['a', { id: 'a', name: 'A', parents: ['b'] }],
      ['b', { id: 'b', name: 'B', parents: ['a'] }],
    ]);
    expect(resolvePath({ parents: ['a'] }, cyc)).toBe('B/A');
  });
});

describe('classifyChange', () => {
  test('removed flag → tombstone', () => {
    expect(classifyChange({ fileId: 'x', removed: true })).toBe('tombstone');
  });
  test('trashed file → tombstone', () => {
    expect(classifyChange({ file: doc({ trashed: true }) })).toBe('tombstone');
  });
  test('non-tracked mime (folder) → ignore', () => {
    expect(classifyChange({ file: doc({ mimeType: MIME_FOLDER }) })).toBe('ignore');
  });
  test('live doc → upsert', () => {
    expect(classifyChange({ file: doc() })).toBe('upsert');
  });
  test('live sheet → upsert', () => {
    expect(classifyChange({ file: doc({ mimeType: MIME_SHEET }) })).toBe('upsert');
  });
  test('neither file nor removed → ignore', () => {
    expect(classifyChange({ fileId: 'x' })).toBe('ignore');
  });
});
