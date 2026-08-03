/**
 * DB-backed integration tests for the gws-sync orchestrator. A fake Drive
 * client feeds the real db-writer + PGLite engine (source 'dent'). Covers:
 * seed full-walk, modifiedTime idempotency skip, rename reuses the canonical
 * slug, trash tombstones the card, sheet cards carry structural schema, and the
 * changes cursor persists across ticks.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { PGLiteEngine } from '../../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../../helpers/reset-pglite.ts';
import { runDentMigrations } from '../../../../src/dent/migrate.ts';
import { upsertDentSource } from '../../db-writer/_helpers.ts';
import { readPageMarkdown } from '../../../../src/dent/db-writer/page-io.ts';
import { runGwsSyncTick } from '../../../../src/dent/ingestors/gws-sync/ingest.ts';
import { readGwsState } from '../../../../src/dent/ingestors/gws-sync/state.ts';
import { IDENTITY_KEY, MIME_DOC, MIME_SHEET, type DriveFile, type DriveChange } from '../../../../src/dent/ingestors/gws-sync/types.ts';
import type { DriveClient } from '../../../../src/dent/ingestors/gws-sync/drive-client.ts';

setDefaultTimeout(30_000);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await upsertDentSource(engine);
  await runDentMigrations(engine); // v5 = gws_sync_state
});

const NOW = '2026-06-26T12:00:00.000Z';
const now = () => NOW;

const doc = (o: Partial<DriveFile> = {}): DriveFile => ({
  id: 'DOC1',
  name: 'Q3 Strategy',
  mimeType: MIME_DOC,
  modifiedTime: '2026-06-20T09:00:00.000Z',
  webViewLink: 'https://docs.google.com/d/DOC1',
  owners: [{ emailAddress: 'owner@example.com' }],
  parents: undefined, // My Drive root → no folder lookups
  ...o,
});

interface FakeClientSpec {
  startToken?: string;
  files?: DriveFile[];
  changes?: { changes: DriveChange[]; newStartPageToken: string };
  sheetSchema?: { tabs: string[]; dimensions: Record<string, { rows: number; cols: number }> };
}

function fakeClient(spec: FakeClientSpec): DriveClient {
  return {
    getStartPageToken: async () => spec.startToken ?? 't0',
    listAllDocsAndSheets: async () => spec.files ?? [],
    listChanges: async () => spec.changes ?? { changes: [], newStartPageToken: 't1' },
    getFolder: async (id: string) => ({ id, name: 'Folder', parents: undefined }),
    getSpreadsheetSchema: async () => spec.sheetSchema ?? { tabs: [], dimensions: {} },
  } as unknown as DriveClient;
}

async function identity(fileId: string, type: 'gdrive-doc' | 'gdrive-sheet') {
  return engine.getPageByIdentity(IDENTITY_KEY, fileId, { type });
}

describe('seed full walk', () => {
  test('creates one card per file and banks the start token', async () => {
    const client = fakeClient({ startToken: 'SEED_TOK', files: [doc(), doc({ id: 'DOC2', name: 'Roadmap' })] });
    const out = await runGwsSyncTick(engine, { client, now });
    expect(out).toMatchObject({ ok: true, mode: 'seed', scanned: 2, upserted: 2, tombstoned: 0 });

    const card = await identity('DOC1', 'gdrive-doc');
    expect(card?.frontmatter.gdrive_file_id).toBe('DOC1');
    expect(card?.frontmatter.drive_path).toBe('My Drive');

    const state = await readGwsState(engine);
    expect(state.changesPageToken).toBe('SEED_TOK');
    expect(state.lastFullWalkAt).not.toBeNull();
  });
});

describe('delta idempotency', () => {
  test('delta always refreshes — a moved file keeps modifiedTime but must update path', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed → path 'My Drive'
    // Same id + modifiedTime, now under a folder: a MOVE. Drive does not bump
    // modifiedTime on a move, but the changes feed fires — so delta must refresh.
    const moved = doc({ parents: ['fX'] });
    const client = {
      getStartPageToken: async () => 't0',
      listAllDocsAndSheets: async () => [],
      listChanges: async () => ({ changes: [{ fileId: 'DOC1', file: moved }], newStartPageToken: 't2' }),
      getFolder: async (id: string) => ({ id, name: 'Moved', parents: undefined }),
      getSpreadsheetSchema: async () => ({ tabs: [], dimensions: {} }),
    } as unknown as DriveClient;
    const out = await runGwsSyncTick(engine, { client, now });
    expect(out).toMatchObject({ mode: 'delta', upserted: 1 });
    const card = await identity('DOC1', 'gdrive-doc');
    expect(card?.frontmatter.drive_path).toBe('Moved'); // refreshed despite unchanged modifiedTime
  });

  test('empty changes feed writes nothing', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed
    const out = await runGwsSyncTick(engine, { client: fakeClient({ changes: { changes: [], newStartPageToken: 't9' } }), now });
    expect(out).toMatchObject({ mode: 'delta', scanned: 0, upserted: 0, skipped: 0, tombstoned: 0 });
    const state = await readGwsState(engine);
    expect(state.changesPageToken).toBe('t9');
  });
});

describe('rename reuses the canonical slug', () => {
  test('renamed doc (new title + new modifiedTime) updates in place, no second card', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed
    const before = await identity('DOC1', 'gdrive-doc');
    const originalSlug = before!.slug;

    const renamed = doc({ name: 'Q3 Strategy FINAL', modifiedTime: '2026-06-25T09:00:00.000Z' });
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'DOC1', file: renamed }], newStartPageToken: 't3' } }),
      now,
    });
    expect(out).toMatchObject({ upserted: 1 });

    const after = await identity('DOC1', 'gdrive-doc');
    expect(after!.slug).toBe(originalSlug); // same slug, not forked
    // title is promoted to a column; verify the rewrite landed via rendered body.
    const md = await readPageMarkdown(engine, after!.slug);
    expect(md!.markdown).toContain('Q3 Strategy FINAL');
  });
});

describe('tombstone', () => {
  test('removed change soft-deletes the card', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed
    expect(await identity('DOC1', 'gdrive-doc')).not.toBeNull();

    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'DOC1', removed: true }], newStartPageToken: 't4' } }),
      now,
    });
    expect(out).toMatchObject({ tombstoned: 1 });
    expect(await identity('DOC1', 'gdrive-doc')).toBeNull(); // soft-deleted, gone from default reads
  });

  test('un-trashing a file resurrects its card (no fork)', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed
    await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'DOC1', removed: true }], newStartPageToken: 't4' } }),
      now,
    }); // trash → tombstone
    expect(await identity('DOC1', 'gdrive-doc')).toBeNull();
    // un-trash: delta upsert with the file back (and renamed while trashed)
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'DOC1', file: doc({ name: 'Q3 Strategy v2', modifiedTime: '2026-06-28T00:00:00.000Z' }) }], newStartPageToken: 't5' } }),
      now,
    });
    expect(out).toMatchObject({ upserted: 1 });
    expect(await identity('DOC1', 'gdrive-doc')).not.toBeNull(); // resurrected, live again
  });
});

describe('sheet cards', () => {
  test('carry structural schema (tabs + dimensions)', async () => {
    const sheet = doc({ id: 'SHEET1', name: 'Deals', mimeType: MIME_SHEET });
    const client = fakeClient({ files: [sheet], sheetSchema: { tabs: ['Summary', 'Pipeline'], dimensions: { Summary: { rows: 120, cols: 8 } } } });
    await runGwsSyncTick(engine, { client, now });
    const card = await identity('SHEET1', 'gdrive-sheet');
    // identity lookup with type:'gdrive-sheet' matching confirms the type column;
    // slug prefix + surviving custom frontmatter confirm the sheet card shape.
    expect(card?.slug).toMatch(/^gdrive\/sheet\//);
    expect(card?.frontmatter.sheet_tabs).toEqual(['Summary', 'Pipeline']);
  });

  test('sheet schema fetch failure falls back to a metadata-only sheet card', async () => {
    const sheet = doc({ id: 'SHEET_F', name: 'Deals', mimeType: MIME_SHEET });
    const client = {
      getStartPageToken: async () => 't0',
      listAllDocsAndSheets: async () => [sheet],
      listChanges: async () => ({ changes: [], newStartPageToken: 't1' }),
      getFolder: async (id: string) => ({ id, name: 'F', parents: undefined }),
      getSpreadsheetSchema: async () => {
        throw new Error('sheets 403');
      },
    } as unknown as DriveClient;
    const out = await runGwsSyncTick(engine, { client, now });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1, errors: 0 });
    const card = await identity('SHEET_F', 'gdrive-sheet');
    expect(card).not.toBeNull();
    expect(card?.frontmatter.sheet_tabs).toBeUndefined(); // degraded to metadata-only
  });
});

describe('negative paths', () => {
  test('folder path resolves partially when an ancestor lookup fails', async () => {
    const f = doc({ id: 'DOC_P', parents: ['fA'] });
    const client = {
      getStartPageToken: async () => 't0',
      listAllDocsAndSheets: async () => [f],
      listChanges: async () => ({ changes: [], newStartPageToken: 't1' }),
      getFolder: async (id: string) => {
        if (id === 'fA') return { id: 'fA', name: 'Strategy', parents: ['fRoot'] };
        throw new Error('shared-drive root not fetchable');
      },
      getSpreadsheetSchema: async () => ({ tabs: [], dimensions: {} }),
    } as unknown as DriveClient;
    await runGwsSyncTick(engine, { client, now });
    const card = await identity('DOC_P', 'gdrive-doc');
    expect(card?.frontmatter.drive_path).toBe('Strategy'); // stops at the failed ancestor
  });

  test('a throwing client surfaces as a structured failure outcome, not a rejection', async () => {
    const client = {
      getStartPageToken: async () => {
        throw new Error('drive down');
      },
      listAllDocsAndSheets: async () => [],
      listChanges: async () => ({ changes: [], newStartPageToken: 't1' }),
      getFolder: async (id: string) => ({ id, name: 'F' }),
      getSpreadsheetSchema: async () => ({ tabs: [], dimensions: {} }),
    } as unknown as DriveClient;
    const out = await runGwsSyncTick(engine, { client, now });
    expect(out.ok).toBe(false); // cron relies on this to keep its timer alive
    expect(out.errors).toBe(1);
    expect(out.error).toContain('drive down');
  });

  test('a removed change with no fileId is a no-op (no tombstone, no error)', async () => {
    await runGwsSyncTick(engine, { client: fakeClient({ files: [doc()] }), now }); // seed
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ removed: true }], newStartPageToken: 't5' } }),
      now,
    });
    expect(out).toMatchObject({ mode: 'delta', tombstoned: 0, errors: 0 });
  });
});

describe('share-scope filter', () => {
  const shareScope = {
    selfEmails: new Set(['jason@dentthefuture.com']),
    excludePairEmails: new Set(['steve@dentthefuture.com']),
  };
  const perm = (email: string) => ({ emailAddress: email, type: 'user' });
  const jasonOwns = [{ emailAddress: 'jason@dentthefuture.com' }];

  test('seed cards shared files, excludes private + you+Steve-only', async () => {
    const priv = doc({ id: 'PRIV', name: 'Private', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com')] });
    const steveOnly = doc({ id: 'STV', name: 'Founder', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com'), perm('steve@dentthefuture.com')] });
    const shared = doc({ id: 'SHD', name: 'Team doc', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com'), perm('jeff@dentthefuture.com')] });
    const out = await runGwsSyncTick(engine, { client: fakeClient({ files: [priv, steveOnly, shared] }), now, shareScope });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1 });
    expect(await identity('SHD', 'gdrive-doc')).not.toBeNull();
    expect(await identity('PRIV', 'gdrive-doc')).toBeNull();
    expect(await identity('STV', 'gdrive-doc')).toBeNull();
  });

  test('a file that becomes private is tombstoned on the delta', async () => {
    const shared = doc({ id: 'D2', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com'), perm('jeff@dentthefuture.com')] });
    await runGwsSyncTick(engine, { client: fakeClient({ files: [shared] }), now, shareScope }); // seed → carded
    expect(await identity('D2', 'gdrive-doc')).not.toBeNull();
    const nowPrivate = doc({ id: 'D2', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com')], modifiedTime: '2026-06-29T00:00:00.000Z' });
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'D2', file: nowPrivate }], newStartPageToken: 't2' } }),
      now,
      shareScope,
    });
    expect(out).toMatchObject({ mode: 'delta', tombstoned: 1 });
    expect(await identity('D2', 'gdrive-doc')).toBeNull();
  });

  test('a re-seed prunes a card whose file is now excluded (the cleanup path)', async () => {
    const f = doc({ id: 'D3', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com')] }); // private
    await runGwsSyncTick(engine, { client: fakeClient({ files: [f] }), now }); // no filter → carded
    expect(await identity('D3', 'gdrive-doc')).not.toBeNull();
    // Clear the cursor (what GWS_SYNC_RESEED does) to force a re-seed, now with the filter.
    await engine.executeRaw('UPDATE gws_sync_state SET changes_page_token = NULL WHERE id = 1', []);
    const out = await runGwsSyncTick(engine, { client: fakeClient({ files: [f] }), now, shareScope });
    expect(out).toMatchObject({ mode: 'seed', tombstoned: 1, upserted: 0 });
    expect(await identity('D3', 'gdrive-doc')).toBeNull();
  });

  test('auto-includes the crawl identity in self, so a self-email typo cannot leak', async () => {
    const priv = doc({ id: 'AUTOSELF', owners: jasonOwns, permissions: [perm('jason@dentthefuture.com')] });
    const client = {
      getAuthedEmail: async () => 'jason@dentthefuture.com',
      getStartPageToken: async () => 't0',
      listAllDocsAndSheets: async () => [priv],
      listChanges: async () => ({ changes: [], newStartPageToken: 't1' }),
      getFolder: async (id: string) => ({ id, name: 'F', parents: undefined }),
      getSpreadsheetSchema: async () => ({ tabs: [], dimensions: {} }),
    } as unknown as DriveClient;
    // selfEmails holds only a TYPO — without auto-self the founder's own private
    // doc would leak. ensureSelfIdentity must add the real identity.
    const out = await runGwsSyncTick(engine, {
      client,
      now,
      shareScope: { selfEmails: new Set(['typo@dentthefuture.com']), excludePairEmails: new Set() },
    });
    expect(out).toMatchObject({ mode: 'seed', upserted: 0 });
    expect(await identity('AUTOSELF', 'gdrive-doc')).toBeNull(); // excluded — identity auto-added to self
  });
});

describe('relevance-scope filter', () => {
  const relevanceScope = {
    ownerDomains: new Set(['dentthefuture.com']),
    ownerEmails: new Set(['jason@jrpreston.com']),
    driveIds: new Set<string>(),
  };
  const ownedBy = (id: string, email: string, extra: Partial<DriveFile> = {}) =>
    doc({ id, owners: [{ emailAddress: email }], ...extra });

  test('seed cards our own files and excludes an outsider-owned file shared with us', async () => {
    // The regression: a friend's spreadsheet, shared with the crawl identity.
    const ours = ownedBy('OURS', 'steve@dentthefuture.com');
    const mine = ownedBy('MINE', 'jason@jrpreston.com');
    const theirs = ownedBy('THEIRS', 'stranger@gmail.com', { name: 'League Roster' });
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ files: [ours, mine, theirs] }),
      now,
      relevanceScope,
    });
    expect(out).toMatchObject({ mode: 'seed', upserted: 2 });
    expect(await identity('OURS', 'gdrive-doc')).not.toBeNull();
    expect(await identity('MINE', 'gdrive-doc')).not.toBeNull();
    expect(await identity('THEIRS', 'gdrive-doc')).toBeNull();
  });

  test('a re-seed prunes an outsider-owned card written before the gate existed', async () => {
    const theirs = ownedBy('LEAGUE', 'stranger@gmail.com');
    await runGwsSyncTick(engine, { client: fakeClient({ files: [theirs] }), now }); // no filter → carded
    expect(await identity('LEAGUE', 'gdrive-doc')).not.toBeNull();
    // Clear the cursor (what GWS_SYNC_RESEED does) to force a re-seed with the gate on.
    await engine.executeRaw('UPDATE gws_sync_state SET changes_page_token = NULL WHERE id = 1', []);
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ files: [theirs] }),
      now,
      relevanceScope,
    });
    expect(out).toMatchObject({ mode: 'seed', tombstoned: 1, upserted: 0 });
    expect(await identity('LEAGUE', 'gdrive-doc')).toBeNull();
  });

  test('a file that changes hands to an outside owner is tombstoned on the delta', async () => {
    const ours = ownedBy('XFER', 'steve@dentthefuture.com');
    await runGwsSyncTick(engine, { client: fakeClient({ files: [ours] }), now, relevanceScope });
    expect(await identity('XFER', 'gdrive-doc')).not.toBeNull();
    const transferred = ownedBy('XFER', 'stranger@gmail.com', { modifiedTime: '2026-06-29T00:00:00.000Z' });
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ changes: { changes: [{ fileId: 'XFER', file: transferred }], newStartPageToken: 't2' } }),
      now,
      relevanceScope,
    });
    expect(out).toMatchObject({ mode: 'delta', tombstoned: 1 });
    expect(await identity('XFER', 'gdrive-doc')).toBeNull();
  });

  test('shared-drive files are carded even when owned outside the domain', async () => {
    const onDrive = ownedBy('SD', 'stranger@gmail.com', { driveId: 'D1' });
    const out = await runGwsSyncTick(engine, { client: fakeClient({ files: [onDrive] }), now, relevanceScope });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1 });
    expect(await identity('SD', 'gdrive-doc')).not.toBeNull();
  });

  test('inactive by default — an outsider-owned file still cards when the gate is unset', async () => {
    const theirs = ownedBy('DEFAULT', 'stranger@gmail.com');
    const out = await runGwsSyncTick(engine, { client: fakeClient({ files: [theirs] }), now });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1 });
    expect(await identity('DEFAULT', 'gdrive-doc')).not.toBeNull();
  });

  test('the two gates compose — either one alone excludes', async () => {
    const shareScope = {
      selfEmails: new Set(['jason@dentthefuture.com']),
      excludePairEmails: new Set<string>(),
    };
    const perm = (email: string) => ({ emailAddress: email, type: 'user' });
    // Ours by ownership, but private → share-scope rejects.
    const oursPrivate = ownedBy('OURS_PRIV', 'jason@dentthefuture.com', {
      permissions: [perm('jason@dentthefuture.com')],
    });
    // Widely shared → share-scope accepts, but owned by an outsider → relevance rejects.
    const theirsShared = ownedBy('THEIRS_SHD', 'stranger@gmail.com', {
      permissions: [perm('jason@dentthefuture.com'), perm('jeff@dentthefuture.com')],
    });
    // Ours AND shared → both accept.
    const oursShared = ownedBy('OURS_SHD', 'jason@dentthefuture.com', {
      permissions: [perm('jason@dentthefuture.com'), perm('jeff@dentthefuture.com')],
    });
    const out = await runGwsSyncTick(engine, {
      client: fakeClient({ files: [oursPrivate, theirsShared, oursShared] }),
      now,
      shareScope,
      relevanceScope,
    });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1 });
    expect(await identity('OURS_PRIV', 'gdrive-doc')).toBeNull();
    expect(await identity('THEIRS_SHD', 'gdrive-doc')).toBeNull();
    expect(await identity('OURS_SHD', 'gdrive-doc')).not.toBeNull();
  });

  test('auto-includes the crawl identity as an owner, so an owner-domain-only config keeps your docs', async () => {
    const mine = ownedBy('AUTOOWN', 'jason@othercorp.com');
    const client = {
      getAuthedEmail: async () => 'jason@othercorp.com',
      getStartPageToken: async () => 't0',
      listAllDocsAndSheets: async () => [mine],
      listChanges: async () => ({ changes: [], newStartPageToken: 't1' }),
      getFolder: async (id: string) => ({ id, name: 'F', parents: undefined }),
      getSpreadsheetSchema: async () => ({ tabs: [], dimensions: {} }),
    } as unknown as DriveClient;
    const out = await runGwsSyncTick(engine, {
      client,
      now,
      // Owner rules never mention othercorp.com — only ensureSelfIdentity saves it.
      relevanceScope: {
        ownerDomains: new Set(['dentthefuture.com']),
        ownerEmails: new Set<string>(),
        driveIds: new Set<string>(),
      },
    });
    expect(out).toMatchObject({ mode: 'seed', upserted: 1 });
    expect(await identity('AUTOOWN', 'gdrive-doc')).not.toBeNull();
  });
});
