#!/usr/bin/env bun
/**
 * Granola → Dent Brain sync daemon.
 *
 * Runs hourly (via launchd) on each teammate's laptop. Reads Granola's local
 * cache, filters to Dent-related meetings, translates each one into a brain
 * meeting page + transcript page, and dispatches MCP calls against the
 * production dent-brain server using the teammate's personal bearer token.
 *
 * Idempotent on `[Source: granola/<document-id>]` — re-runs are safe.
 *
 * Usage:
 *   bun sync.ts                     # use config from ~/.dent-brain/granola-sync/config.json
 *   bun sync.ts --dry-run           # plan only, no MCP calls
 *   bun sync.ts --limit 3           # cap how many meetings get processed
 *   bun sync.ts --since 2026-04-01  # override the cursor's lastSyncedCreatedAt
 *   bun sync.ts --doc-id <id>       # sync a single specific Granola document
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type {
  GranolaCache,
  GranolaDocument,
  GranolaTranscriptSegment,
  SyncConfig,
  SyncCursor,
} from './types.ts';
import { McpClient } from './mcp-client.ts';
import { isDentRelated } from './filter.ts';
import { translateMeeting } from './translator.ts';

const SYNC_VERSION = '0.1.0';
const DEFAULT_CONFIG_PATH = join(homedir(), '.dent-brain', 'granola-sync', 'config.json');

function parseFlags(argv: string[]) {
  const flags = {
    dryRun: false,
    limit: Infinity as number,
    since: null as string | null,
    docId: null as string | null,
    configPath: DEFAULT_CONFIG_PATH,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--verbose' || a === '-v') flags.verbose = true;
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (a === '--since') flags.since = argv[++i];
    else if (a === '--doc-id') flags.docId = argv[++i];
    else if (a === '--config') flags.configPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return flags;
}

function printHelp() {
  process.stderr.write(
    `Granola → Dent Brain sync daemon\n\nUsage: bun sync.ts [flags]\n  --dry-run                Plan only, no writes.\n  --limit <n>              Cap meetings processed (default: no cap).\n  --since YYYY-MM-DD       Override cursor (re-sync from this date).\n  --doc-id <granola-id>    Sync exactly one document.\n  --config <path>          Override config path (default: ~/.dent-brain/granola-sync/config.json).\n  --verbose | -v           Log every doc decision.\n  --help | -h              Print this help.\n`,
  );
}

/** Read the dent-brain MCP server URL + bearer token straight from
 *  `~/.claude.json` (set by `claude mcp add dent-brain ...`). Returns null
 *  if claude.json is missing, malformed, or has no dent-brain entry. */
function discoverFromClaudeJson(): { serverUrl: string; bearerToken: string } | null {
  const path = join(homedir(), '.claude.json');
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8'));
    const entry = c?.mcpServers?.['dent-brain'];
    if (!entry || typeof entry !== 'object') return null;
    const url = typeof entry.url === 'string' ? entry.url : null;
    const auth = typeof entry.headers?.Authorization === 'string' ? entry.headers.Authorization : null;
    if (!url || !auth) return null;
    const tokenMatch = /^Bearer\s+(.+)$/.exec(auth);
    if (!tokenMatch) return null;
    return { serverUrl: url, bearerToken: tokenMatch[1].trim() };
  } catch {
    return null;
  }
}

function loadConfig(path: string): SyncConfig {
  // Discover token + URL from ~/.claude.json (the same place `claude mcp add`
  // wrote them during onboarding). The config file's serverUrl/bearerToken,
  // if present, override these — but the standard setup leaves them empty so
  // the teammate has ONE source of truth.
  const discovered = discoverFromClaudeJson();

  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  }
  if (!discovered && !raw.serverUrl && !raw.bearerToken) {
    console.error(`No dent-brain MCP configured.`);
    console.error(`Run \`claude mcp add dent-brain ...\` first (per /dent-onboard-teammate),`);
    console.error(`or override with serverUrl + bearerToken in ${path}.`);
    process.exit(1);
  }

  const serverUrl = String(raw.serverUrl ?? discovered?.serverUrl ?? '');
  const bearerToken = String(raw.bearerToken ?? discovered?.bearerToken ?? '');
  if (!serverUrl) {
    console.error(`No serverUrl in ${path} and no dent-brain entry in ~/.claude.json.`);
    process.exit(1);
  }
  if (!bearerToken || /^REPLACE_/.test(bearerToken)) {
    console.error(`No bearerToken found.`);
    console.error(`Either run \`claude mcp add dent-brain ...\` so it's discovered automatically,`);
    console.error(`or set bearerToken explicitly in ${path}.`);
    process.exit(1);
  }

  const cachePath = String(raw.granolaCachePath ?? `${homedir()}/Library/Application Support/Granola/cache-v6.json`).replace('${HOME}', homedir());
  return {
    serverUrl,
    bearerToken,
    granolaCachePath: cachePath,
    cursorPath: String(raw.cursorPath ?? join(homedir(), '.dent-brain', 'granola-sync', 'cursor.json')).replace('${HOME}', homedir()),
    dentDomains: Array.isArray(raw.dentDomains) && raw.dentDomains.length > 0
      ? (raw.dentDomains as unknown[]).map((d) => String(d).toLowerCase())
      : ['dentthefuture.com'],
  };
}

function loadCursor(path: string): SyncCursor {
  if (!existsSync(path)) {
    return {
      lastSyncedCreatedAt: '1970-01-01T00:00:00.000Z',
      syncedDocumentIds: [],
      cursorUpdatedAt: new Date().toISOString(),
      syncVersion: SYNC_VERSION,
    };
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveCursor(path: string, cursor: SyncCursor) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2), 'utf-8');
}

interface DocPick {
  doc: GranolaDocument;
  transcript: GranolaTranscriptSegment[] | undefined;
}

function loadGranolaDocs(cachePath: string): { docs: GranolaDocument[]; transcripts: Record<string, GranolaTranscriptSegment[]> } {
  if (!existsSync(cachePath)) {
    console.error(`Granola cache not found at ${cachePath}.`);
    console.error('Open the Granola app at least once so it creates the cache, then re-run.');
    process.exit(1);
  }
  const cache: GranolaCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
  const docMap = cache.cache?.state?.documents ?? {};
  const sharedMap = cache.cache?.state?.sharedDocuments ?? {};
  const docs: GranolaDocument[] = [];
  for (const id of Object.keys(docMap)) docs.push(docMap[id]);
  for (const id of Object.keys(sharedMap)) {
    if (!docs.find((d) => d.id === id)) docs.push(sharedMap[id]);
  }
  const transcripts = cache.cache?.state?.transcripts ?? {};
  return { docs, transcripts };
}

async function fetchBrainEmails(_client: McpClient, _dryRun: boolean): Promise<Set<string>> {
  // Filter signal #3 (any attendee email matches an existing brain entity) is
  // disabled by default. The brain has 17k+ pages and `list_pages --limit 10000`
  // times out on the production server. Title-keyword + Dent-team-domain
  // (signals #1 and #2) catch the strong cases.
  //
  // If a teammate has lots of external-partner meetings where the partner is
  // already a tracked entity but neither the meeting title contains "Dent"
  // nor a Dent staffer is in the calendar, those will be skipped. Trade-off:
  // we'd rather miss a few than have the daemon timeout out every hour.
  //
  // Future: add a dedicated `list_entity_emails` MCP op so this is O(1) and
  // we can re-enable signal #3 at zero cost.
  return new Set();
}

interface ExistingPage {
  exists: boolean;
  /** Length of the compiled_truth body, used as a "richness" proxy. */
  bodyLength: number;
  /** True if `created_via: granola-sync` — safe to overwrite. */
  fromGranola: boolean;
}

async function fetchPage(client: McpClient, slug: string): Promise<ExistingPage> {
  try {
    const page = await client.tool<{ compiled_truth?: string; frontmatter?: Record<string, unknown> } | null>('get_page', { slug });
    if (!page || (typeof page === 'object' && Object.keys(page).length === 0)) {
      return { exists: false, bodyLength: 0, fromGranola: false };
    }
    const body = page.compiled_truth ?? '';
    const fromGranola = page.frontmatter?.['created_via'] === 'granola-sync';
    return { exists: true, bodyLength: body.length, fromGranola };
  } catch {
    return { exists: false, bodyLength: 0, fromGranola: false };
  }
}

async function ensureMeetingPage(client: McpClient, slug: string, content: string, dryRun: boolean): Promise<'created' | 'existed' | 'updated'> {
  const existing = await fetchPage(client, slug);
  if (existing.exists) {
    // Update if the existing page came from us AND the new content is materially
    // richer (e.g. the original was an empty stub, Granola has now captured notes).
    // 50-char threshold catches the bare-stub case (~120 chars) vs a real page (~500+).
    const newBody = content.split('---\n').slice(2).join('---\n');
    if (existing.fromGranola && newBody.length > existing.bodyLength + 50) {
      if (dryRun) return 'updated';
      await client.tool('markdown_replace_page', { slug, content });
      return 'updated';
    }
    return 'existed';
  }
  if (dryRun) return 'created';
  await client.tool('markdown_replace_page', { slug, content });
  return 'created';
}

async function ensureTranscriptPage(client: McpClient, slug: string, content: string, dryRun: boolean): Promise<'created' | 'existed'> {
  const existing = await fetchPage(client, slug);
  if (existing.exists) return 'existed';
  if (dryRun) return 'created';
  await client.tool('markdown_replace_page', { slug, content });
  return 'created';
}

async function ensureAttendeeStub(
  client: McpClient,
  email: string,
  displayName: string | undefined,
  isoDate: string,
  dryRun: boolean,
): Promise<{ slug: string; created: boolean }> {
  // Try email-based lookup via search/query (the brain doesn't have a
  // direct "find page by email" op exposed, but list_pages with frontmatter
  // filtering would). For now, derive a slug from name/email and check
  // whether that slug exists. Not perfect — won't find pages where the
  // person is filed under a different slug. Acceptable for v0.1 since
  // we already cached brainEmails for the filter step (we re-use that
  // set as a "known email" check up the call stack).
  const local = email.split('@')[0] ?? email;
  const base = (displayName ?? local).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const slug = `entities/people/${base || 'unknown-attendee'}`;
  const existing = await fetchPage(client, slug);
  if (existing.exists) return { slug, created: false };
  if (dryRun) return { slug, created: true };
  const fm = [
    '---',
    `title: ${displayName ?? local}`,
    `slug: ${slug}`,
    'type: person',
    'created_via: granola-sync',
    `email: ${email}`,
    `updated: ${isoDate}`,
    '---',
  ].join('\n');
  const body = `# ${displayName ?? local}\n\nStub created by the Granola sync on ${isoDate} from a calendar attendee. Run \`/dent-enrich\` after the page accumulates more observations to flesh it out.\n\n## Timeline\n\n`;
  await client.tool('markdown_replace_page', { slug, content: `${fm}\n\n${body}` });
  return { slug, created: true };
}

async function appendBulletToAttendee(
  client: McpClient,
  email: string,
  bullet: string,
  isoDate: string,
  displayName: string | undefined,
  brainEmails: Set<string>,
  dryRun: boolean,
): Promise<{ action: 'appended' | 'created-stub' | 'failed'; slug?: string }> {
  // If the email is in brainEmails, an entity page exists. We can't easily
  // resolve email → slug without a dedicated op, so we fall through to the
  // stub-creation path which idempotently checks via pageExists (and skips
  // if found). For new emails we always create a stub.
  void brainEmails; // referenced for clarity; no direct use here
  const stub = await ensureAttendeeStub(client, email, displayName, isoDate, dryRun);
  if (dryRun) return { action: stub.created ? 'created-stub' : 'appended', slug: stub.slug };
  try {
    await client.tool('markdown_append_to_page', {
      slug: stub.slug,
      section: '## Timeline',
      content: bullet,
    });
    return { action: stub.created ? 'created-stub' : 'appended', slug: stub.slug };
  } catch (e) {
    console.error(`[granola-sync] failed to append bullet to ${stub.slug}: ${e instanceof Error ? e.message : String(e)}`);
    return { action: 'failed', slug: stub.slug };
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig(flags.configPath);
  const cursor = loadCursor(config.cursorPath);
  const sinceCutoff = flags.since ? new Date(flags.since).toISOString() : cursor.lastSyncedCreatedAt;

  console.error(`[granola-sync] mode=${flags.dryRun ? 'DRY RUN' : 'APPLY'} cursor=${sinceCutoff}`);
  const { docs, transcripts } = loadGranolaDocs(config.granolaCachePath);
  console.error(`[granola-sync] Granola cache: ${docs.length} documents, ${Object.keys(transcripts).length} local transcripts`);

  const client = new McpClient({ serverUrl: config.serverUrl, bearerToken: config.bearerToken });
  if (!flags.dryRun) {
    try {
      const init = await client.initialize();
      console.error(`[granola-sync] connected to ${init.serverInfo.name} v${init.serverInfo.version}`);
    } catch (e) {
      console.error(`[granola-sync] FATAL: cannot reach MCP server at ${config.serverUrl}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }

  const brainEmails = await fetchBrainEmails(client, flags.dryRun);
  if (flags.verbose || !flags.dryRun) console.error(`[granola-sync] brain emails indexed: ${brainEmails.size}`);

  const filterCtx = {
    dentDomains: config.dentDomains,
    brainEmails,
    titleKeywords: ['dent'],
  };

  // Order documents oldest-first so we sync chronologically and the cursor
  // always advances safely (even on partial failure).
  const candidates = docs
    .filter((d) => !d.deleted_at)
    .filter((d) => d.valid_meeting !== false)
    .filter((d) => {
      if (flags.docId) return d.id === flags.docId;
      const created = new Date(d.created_at).getTime();
      const cutoff = new Date(sinceCutoff).getTime();
      return Number.isFinite(created) && created > cutoff;
    })
    .filter((d) => !cursor.syncedDocumentIds.includes(d.id))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  console.error(`[granola-sync] ${candidates.length} candidate document(s) after cursor + dedup filters`);

  let kept = 0, skipped = 0, processed = 0;
  let createdMeetings = 0, existedMeetings = 0, updatedMeetings = 0, createdTranscripts = 0;
  let bulletsAppended = 0, stubsCreated = 0, bulletsFailed = 0;
  const newSyncedIds: string[] = [];

  function hasContent(doc: GranolaDocument, transcript: GranolaTranscriptSegment[] | undefined): boolean {
    if (transcript && transcript.length > 0) return true;
    if (doc.notes_markdown && doc.notes_markdown.trim().length > 0) return true;
    if (doc.summary && doc.summary.trim().length > 0) return true;
    if (Array.isArray(doc.chapters) && doc.chapters.length > 0) return true;
    return false;
  }

  for (const doc of candidates) {
    if (processed >= flags.limit) break;
    const verdict = isDentRelated(doc, filterCtx);
    if (!verdict.keep) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${doc.title ?? '(no title)'}" — ${verdict.reason}`);
      // Still mark as seen so we don't re-evaluate every run.
      newSyncedIds.push(doc.id);
      continue;
    }
    const tr = transcripts[doc.id];
    if (!hasContent(doc, tr)) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${doc.title ?? '(no title)'}" — Dent-related but Granola captured no content (no notes, no summary, no transcript)`);
      newSyncedIds.push(doc.id);
      continue;
    }
    kept++;
    processed++;
    console.error(`\n  KEEP "${doc.title ?? '(no title)'}" — ${verdict.reason}`);

    const transcript = tr;
    const t = translateMeeting(doc, transcript);

    // Meeting page
    const meeting = await ensureMeetingPage(client, t.meetingSlug, t.meetingContent, flags.dryRun);
    if (meeting === 'created') createdMeetings++;
    else if (meeting === 'updated') updatedMeetings++;
    else existedMeetings++;
    console.error(`    meeting page: ${meeting} (${t.meetingSlug})`);

    // Transcript page (if any)
    if (t.transcriptSlug && t.transcriptContent) {
      const tr = await ensureTranscriptPage(client, t.transcriptSlug, t.transcriptContent, flags.dryRun);
      if (tr === 'created') createdTranscripts++;
      console.error(`    transcript:   ${tr} (${t.transcriptSlug}, ${transcript?.length ?? 0} segments)`);
    } else {
      console.error(`    transcript:   none in local cache`);
    }

    // Per-attendee bullets — bullet lands on every attendee's entity page,
    // including the teammate's own page. The teammate's timeline IS a
    // legitimate record of the meetings they attended; idempotency on
    // [Source: granola/<id>] prevents duplicates on re-runs.
    for (const e of t.attendeeEmails) {
      const r = await appendBulletToAttendee(client, e, t.attendeeBullet, t.isoDate, t.attendeeNames[e], brainEmails, flags.dryRun);
      if (r.action === 'appended') bulletsAppended++;
      else if (r.action === 'created-stub') { stubsCreated++; bulletsAppended++; }
      else if (r.action === 'failed') bulletsFailed++;
    }

    newSyncedIds.push(doc.id);
  }

  // Update cursor: advance to the latest doc we processed (kept or skipped).
  const allProcessed = [...cursor.syncedDocumentIds, ...newSyncedIds];
  const latestProcessedTime = candidates.length > 0
    ? new Date(candidates[candidates.length - 1].created_at).toISOString()
    : cursor.lastSyncedCreatedAt;

  const newCursor: SyncCursor = {
    lastSyncedCreatedAt: latestProcessedTime,
    syncedDocumentIds: allProcessed.slice(-500), // keep tail bounded
    cursorUpdatedAt: new Date().toISOString(),
    syncVersion: SYNC_VERSION,
  };
  if (!flags.dryRun) saveCursor(config.cursorPath, newCursor);

  console.error(
    `\n[granola-sync] done: kept=${kept} skipped=${skipped} processed=${processed}\n  meetings: ${createdMeetings} created, ${updatedMeetings} updated, ${existedMeetings} already-existed\n  transcripts: ${createdTranscripts} created\n  bullets: ${bulletsAppended} appended (${stubsCreated} new stubs), ${bulletsFailed} failed\n  cursor: ${newCursor.lastSyncedCreatedAt}${flags.dryRun ? ' (NOT saved — dry run)' : ''}`,
  );
}

main().catch((e) => {
  console.error('[granola-sync] FATAL', e);
  process.exit(1);
});
