/**
 * gws-sync orchestrator. One tick = either the one-time SEED full walk (when no
 * changes token has been banked yet) or a DELTA pass over the Drive changes
 * feed. Server-side + in-process: it talks to the engine directly (no MCP), the
 * way the nightly maintenance + regfox ingestors do.
 *
 * Idempotency:
 *   - dedup on the `gdrive_file_id` frontmatter identity (engine.getPageByIdentity),
 *     so a doc renamed in Drive reuses its original card slug instead of forking.
 *   - skip the rewrite when the stored modified_time already matches Drive's, so a
 *     delta tick with no real change writes nothing.
 *
 * Metadata-only: cards are built by card-builder from Drive/Sheets METADATA only.
 * Embedding is deferred to the nightly `embed --stale` tick (replacePageDb writes
 * with noEmbed), which is how every other dent write behaves.
 */

import { safeDump } from 'js-yaml';
import type { BrainEngine } from '../../../core/engine.ts';
import { replacePageDb } from '../../db-writer/replace.ts';
import { DENT_SOURCE_ID } from '../../db-writer/page-io.ts';
import { DriveClient } from './drive-client.ts';
import { buildCard } from './card-builder.ts';
import { resolvePath } from './path-resolver.ts';
import { classifyChange } from './delta-classifier.ts';
import { readGwsState, writeChangesToken, writeFullWalkDone } from './state.ts';
import { shareScopeActive, shouldIncludeByShareScope, type ShareScopeConfig } from './share-scope.ts';
import {
  relevanceScopeActive,
  shouldIncludeByRelevanceScope,
  type RelevanceScopeConfig,
} from './relevance-scope.ts';
import {
  IDENTITY_KEY,
  cardTypeForMime,
  isTrackedMime,
  MIME_SHEET,
  type DriveFile,
  type FolderNode,
  type PointerCard,
} from './types.ts';

/** Yield the event loop every N files in the seed walk (see seedFullWalk). */
const SEED_YIELD_EVERY = 64;

export interface GwsSyncOptions {
  client: DriveClient;
  /** Injected ISO-8601 clock for deterministic tests. */
  now: () => string;
  /** Cap on folder-metadata fetches per tick for path resolution (default 500). */
  maxFolderLookups?: number;
  /** Share-scope filter. When absent/empty, every file is carded (default). */
  shareScope?: ShareScopeConfig;
  /** Relevance-scope filter. When absent/empty, every file is carded (default). */
  relevanceScope?: RelevanceScopeConfig;
}

/**
 * Card a file only if it clears BOTH gates. They are orthogonal and each is
 * independently optional: share-scope answers "is this confidential?" and
 * relevance-scope answers "is this ours?". A file shared with you by an outside
 * owner passes the first and fails the second — that asymmetry is the point.
 */
function included(file: DriveFile, opts: GwsSyncOptions): boolean {
  if (shareScopeActive(opts.shareScope) && !shouldIncludeByShareScope(file, opts.shareScope, Date.parse(opts.now()))) {
    return false;
  }
  if (relevanceScopeActive(opts.relevanceScope) && !shouldIncludeByRelevanceScope(file, opts.relevanceScope)) {
    return false;
  }
  return true;
}

/**
 * Always treat the crawl identity itself as "self", regardless of config. A typo
 * in GWS_SYNC_SELF_EMAILS would otherwise leave the founder's own email
 * unsubtracted, turning share-scope into include-everything — and would drop
 * every doc you own from relevance-scope. Seeds both sets for that reason.
 * Best-effort: if we can't resolve our own identity, the configured sets apply.
 */
async function ensureSelfIdentity(opts: GwsSyncOptions): Promise<void> {
  const wantShare = shareScopeActive(opts.shareScope);
  const wantRelevance = relevanceScopeActive(opts.relevanceScope);
  if (!wantShare && !wantRelevance) return;
  const getAuthed = (opts.client as { getAuthedEmail?: () => Promise<string | undefined> }).getAuthedEmail;
  if (typeof getAuthed !== 'function') return;
  try {
    const email = await getAuthed.call(opts.client);
    if (!email) return;
    const lower = email.toLowerCase();
    if (wantShare) opts.shareScope!.selfEmails.add(lower);
    if (wantRelevance) opts.relevanceScope!.ownerEmails.add(lower);
  } catch {
    /* best-effort */
  }
}

export interface GwsSyncOutcome {
  ok: boolean;
  mode: 'seed' | 'delta';
  scanned: number;
  upserted: number;
  skipped: number;
  tombstoned: number;
  errors: number;
  error?: string;
}

export async function runGwsSyncTick(engine: BrainEngine, opts: GwsSyncOptions): Promise<GwsSyncOutcome> {
  try {
    await ensureSelfIdentity(opts);
    const state = await readGwsState(engine);
    if (state.changesPageToken == null) {
      return await seedFullWalk(engine, opts);
    }
    return await processDeltas(engine, opts, state.changesPageToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, mode: 'delta', scanned: 0, upserted: 0, skipped: 0, tombstoned: 0, errors: 1, error: msg };
  }
}

async function seedFullWalk(engine: BrainEngine, opts: GwsSyncOptions): Promise<GwsSyncOutcome> {
  // Grab the changes cursor BEFORE listing, so edits made during the (possibly
  // long) walk are re-seen on the first delta tick rather than lost.
  const startToken = await opts.client.getStartPageToken();
  const files = await opts.client.listAllDocsAndSheets();
  logCorpusReport(files);

  const folders = new FolderCache(opts.client, opts.maxFolderLookups);
  let upserted = 0;
  let skipped = 0;
  let tombstoned = 0;
  let errors = 0;
  let i = 0;
  for (const file of files) {
    try {
      if (included(file, opts)) {
        const action = await writeCard(engine, opts, file, folders, true /* allowSkip: cheap re-walk after a crash */);
        if (action === 'upserted') upserted++;
        else skipped++;
      } else if (await tombstone(engine, file.id)) {
        // A filter excludes this file. The seed sees the FULL list, so it also
        // removes a card written before the filter existed (or before the file
        // was un-shared) — this is what makes a re-seed self-pruning.
        tombstoned++;
      }
    } catch {
      errors++;
    }
    // The seed walk can touch thousands of files in one in-process burst on a
    // small container. Yield the event loop periodically (the same defense the
    // sync path uses via GBRAIN_SYNC_YIELD_EVERY) so the engine pool and HTTP
    // handlers aren't starved during the one-time full walk.
    if (++i % SEED_YIELD_EVERY === 0) await new Promise((r) => setTimeout(r, 0));
  }

  await writeFullWalkDone(engine, startToken);
  return { ok: true, mode: 'seed', scanned: files.length, upserted, skipped, tombstoned, errors };
}

async function processDeltas(engine: BrainEngine, opts: GwsSyncOptions, token: string): Promise<GwsSyncOutcome> {
  const { changes, newStartPageToken } = await opts.client.listChanges(token);
  const folders = new FolderCache(opts.client, opts.maxFolderLookups);
  let upserted = 0;
  let skipped = 0;
  let tombstoned = 0;
  let errors = 0;

  for (const change of changes) {
    const action = classifyChange(change);
    try {
      if (action === 'tombstone') {
        const fileId = change.fileId ?? change.file?.id;
        if (fileId && (await tombstone(engine, fileId))) tombstoned++;
      } else if (action === 'upsert' && change.file) {
        if (!included(change.file, opts)) {
          // A file that became private / you+excluded-only / restricted, or that
          // changed hands to an owner outside the relevance scope, loses its card
          // on the delta that reports the change.
          if (await tombstone(engine, change.file.id)) tombstoned++;
        } else {
          // Never skip on delta: the changes feed only fires on a REAL change
          // (incl. a folder move, which leaves modifiedTime untouched), so a
          // modifiedTime-skip here would strand drive_path. Always refresh.
          const result = await writeCard(engine, opts, change.file, folders, false);
          if (result === 'upserted') upserted++;
          else skipped++;
        }
      }
    } catch {
      errors++;
    }
  }

  await writeChangesToken(engine, newStartPageToken);
  return { ok: true, mode: 'delta', scanned: changes.length, upserted, skipped, tombstoned, errors };
}

/**
 * Build + write (or skip) one card. Returns the action taken.
 * Source isolation: identity/write/restore are all scoped to DENT_SOURCE_ID so
 * a Drive event can never read or mutate a same-slug page in another source.
 */
async function writeCard(
  engine: BrainEngine,
  opts: GwsSyncOptions,
  file: DriveFile,
  folders: FolderCache,
  allowSkip: boolean,
): Promise<'upserted' | 'skipped'> {
  const type = cardTypeForMime(file.mimeType);
  // includeDeleted so an un-trashed file resurrects its tombstoned card instead
  // of forking a new one when the title changed while it was trashed.
  const existing = await engine.getPageByIdentity(IDENTITY_KEY, file.id, {
    type,
    includeDeleted: true,
    sourceId: DENT_SOURCE_ID,
  });

  // Seed re-walk only: skip an unchanged, live card (cheap crash recovery).
  if (allowSkip && existing && !existing.deleted_at && existing.frontmatter?.modified_time === file.modifiedTime) {
    return 'skipped';
  }

  const path = await folders.pathFor(file);
  let sheetSchema;
  if (file.mimeType === MIME_SHEET) {
    try {
      sheetSchema = await opts.client.getSpreadsheetSchema(file.id);
    } catch {
      // Schema fetch is best-effort — fall back to a metadata-only sheet card.
      sheetSchema = undefined;
    }
  }

  const card = buildCard({ file, path, crawledAt: opts.now(), sheetSchema });
  // Reuse the canonical slug on rename (identity lookup found the old page).
  const slug = existing?.slug ?? card.slug;
  const result = await replacePageDb(engine, { slug, content: serializeCard(card) });
  if (result.status === 'error') throw new Error(result.error);
  // Bring the card back to life if its Drive file was un-trashed since we tombstoned it.
  if (existing?.deleted_at) await engine.restorePage(slug, { sourceId: DENT_SOURCE_ID });
  return 'upserted';
}

async function tombstone(engine: BrainEngine, fileId: string): Promise<boolean> {
  // identity is unique on fileId across both card types, so a single untyped
  // lookup finds the card whether it's a doc or a sheet. Scoped to our source.
  const existing = await engine.getPageByIdentity(IDENTITY_KEY, fileId, { sourceId: DENT_SOURCE_ID });
  if (!existing) return false;
  await engine.softDeletePage(existing.slug, { sourceId: DENT_SOURCE_ID });
  return true;
}

export function serializeCard(card: PointerCard): string {
  const fm = safeDump(card.frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false });
  return `---\n${fm}---\n\n${card.body}`;
}

/**
 * One-time corpus sizing signal: total Docs/Sheets reachable + how many carry
 * "Dent" in the TITLE (free, no content read). Lets us decide later whether to
 * narrow the crawl. Logged, not persisted.
 */
function logCorpusReport(files: DriveFile[]): void {
  let docs = 0;
  let sheets = 0;
  let dentTitled = 0;
  for (const f of files) {
    if (!isTrackedMime(f.mimeType)) continue;
    if (f.mimeType === MIME_SHEET) sheets++;
    else docs++;
    if ((f.name ?? '').toLowerCase().includes('dent')) dentTitled++;
  }
  console.error(
    `[gws-sync] corpus report: docs=${docs} sheets=${sheets} total=${docs + sheets} title_contains_dent=${dentTitled}`,
  );
}

/**
 * Lazily fetches + caches folder nodes so path resolution costs at most one
 * Drive call per distinct ancestor across the whole tick. Bounded by
 * maxFolderLookups; missing/erroring ancestors degrade to a shorter path.
 */
class FolderCache {
  private cache = new Map<string, FolderNode>();
  private lookups = 0;
  constructor(private client: DriveClient, private maxLookups = 500) {}

  async pathFor(file: DriveFile): Promise<string> {
    let cursor = file.parents?.[0];
    const seen = new Set<string>();
    while (cursor && !this.cache.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      if (this.lookups >= this.maxLookups) break;
      this.lookups++;
      try {
        const node = await this.client.getFolder(cursor);
        this.cache.set(node.id, node);
        cursor = node.parents?.[0];
      } catch {
        // Unknown/inaccessible ancestor (e.g. shared-drive root) — stop walking.
        break;
      }
    }
    return resolvePath(file, this.cache);
  }
}
