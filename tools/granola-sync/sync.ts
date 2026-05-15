#!/usr/bin/env bun
/**
 * Granola → Dent Brain sync daemon.
 *
 * Runs hourly (via launchd) on each teammate's laptop. Pulls meeting notes
 * from the Granola public API, filters to org-related meetings, translates
 * each one into a brain meeting page + transcript page, and dispatches MCP
 * calls against the production dent-brain server using the teammate's
 * personal bearer token.
 *
 * Idempotent on `[Source: granola/<note-id>]` and slug — re-runs are safe.
 *
 * Usage:
 *   bun sync.ts                     # use config from ~/.dent-brain/granola-sync/config.json
 *   bun sync.ts --dry-run           # plan only, no MCP calls
 *   bun sync.ts --limit 3           # cap how many meetings get processed
 *   bun sync.ts --since 2026-04-01  # override the cursor's lastSyncedCreatedAt
 *   bun sync.ts --doc-id not_...    # sync a single specific Granola note
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { Note, SyncConfig, SyncCursor, UserFilterModule } from './types.ts';
import { McpClient } from './mcp-client.ts';
import { translateMeeting } from './translator.ts';
import { GranolaApi, readKeyFromKeychain, KEYCHAIN_SERVICE, keychainAccount } from './granola-api.ts';

const SYNC_VERSION = '0.3.0';
const DEFAULT_CONFIG_PATH = join(homedir(), '.dent-brain', 'granola-sync', 'config.json');
/** Recipe version the daemon understands. User filters declare their own
 *  RECIPE_VERSION; a mismatch is a warning, not a fatal — the install/setup
 *  skill handles migration. */
const SUPPORTED_RECIPE_VERSION = 1;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_USER_FILTER_PATH = join(SCRIPT_DIR, 'user', 'filter.ts');

function parseFlags(argv: string[]) {
  const flags = {
    dryRun: false,
    limit: Infinity as number,
    since: null as string | null,
    docId: null as string | null,
    configPath: DEFAULT_CONFIG_PATH,
    filterPath: DEFAULT_USER_FILTER_PATH,
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
    else if (a === '--filter') flags.filterPath = argv[++i];
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
    `Granola → Dent Brain sync daemon\n\nUsage: bun sync.ts [flags]\n  --dry-run                Plan only, no writes.\n  --limit <n>              Cap meetings processed (default: no cap).\n  --since YYYY-MM-DD       Override cursor (re-sync from this date).\n  --doc-id <not_...>       Sync exactly one note (bypasses cursor + dedup).\n  --config <path>          Override config path (default: ~/.dent-brain/granola-sync/config.json).\n  --filter <path>          Override user filter path (default: <install-dir>/user/filter.ts).\n  --verbose | -v           Log every note decision.\n  --help | -h              Print this help.\n`,
  );
}

async function loadUserFilter(path: string): Promise<UserFilterModule> {
  if (!existsSync(path)) {
    console.error(`[granola-sync] FATAL: no user filter at ${path}.`);
    console.error(`  Granola-sync is intentionally inert until you set up a filter that decides`);
    console.error(`  which meetings reach the shared brain. Run /dent-extensions setup granola-sync`);
    console.error(`  (in Claude Code) to generate one — or copy recipe/filter.example.ts to user/filter.ts`);
    console.error(`  and edit it.`);
    process.exit(1);
  }
  let mod: Partial<UserFilterModule>;
  try {
    mod = (await import(path)) as Partial<UserFilterModule>;
  } catch (e) {
    console.error(`[granola-sync] FATAL: failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (typeof mod.filter !== 'function') {
    console.error(`[granola-sync] FATAL: ${path} does not export a \`filter(note)\` function.`);
    console.error(`  See recipe/RECIPE.md for the contract.`);
    process.exit(1);
  }
  if (typeof mod.RECIPE_VERSION !== 'number') {
    console.error(`[granola-sync] WARN: ${path} does not export RECIPE_VERSION. Treating as v0.`);
  } else if (mod.RECIPE_VERSION !== SUPPORTED_RECIPE_VERSION) {
    console.error(
      `[granola-sync] WARN: filter declares RECIPE_VERSION=${mod.RECIPE_VERSION} but daemon expects ${SUPPORTED_RECIPE_VERSION}. ` +
      `Run /dent-extensions setup granola-sync to migrate.`,
    );
  }
  return mod as UserFilterModule;
}

/** Read the dent-brain MCP server URL + bearer token straight from
 *  `~/.claude.json` (set by `claude mcp add dent-brain ...`). */
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

  // v0.39: filter fields moved to user/filter.ts. Warn if a legacy config
  // still has the old keys so the teammate doesn't think their edits matter.
  const legacyKeys = ['orgKeywords', 'orgDomains', 'orgFolders', 'fileAll', 'dentDomains'].filter((k) => k in raw);
  if (legacyKeys.length > 0) {
    console.error(
      `[granola-sync] WARN: config.json contains legacy fields (${legacyKeys.join(', ')}) — these are ignored as of v0.39. All filter behavior lives in user/filter.ts. Run \`dent-extensions setup granola-sync\` to migrate.`,
    );
  }

  return {
    serverUrl,
    bearerToken,
    cursorPath: String(raw.cursorPath ?? join(homedir(), '.dent-brain', 'granola-sync', 'cursor.json')).replace('${HOME}', homedir()),
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
  const parsed: SyncCursor = JSON.parse(readFileSync(path, 'utf-8'));
  // Migration v0.1 → v0.2: old cursor stored cache UUIDs that don't match
  // the API's `not_…` IDs. Drop them — slug-level dedup in the brain still
  // prevents duplicate writes when an already-filed meeting comes through.
  const legacy = (parsed.syncedDocumentIds ?? []).filter((id) => !/^not_/.test(id));
  if (legacy.length > 0) {
    parsed.syncedDocumentIds = parsed.syncedDocumentIds.filter((id) => /^not_/.test(id));
    console.error(`[granola-sync] migration: dropped ${legacy.length} legacy cache UUIDs from cursor`);
  }
  return parsed;
}

function saveCursor(path: string, cursor: SyncCursor) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2), 'utf-8');
}

interface ExistingPage {
  exists: boolean;
  bodyLength: number;
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

interface DetectEntitiesResult {
  matches: Array<{
    slug: string;
    title: string;
    type: string;
    confidence: number;
    rule: string;
    matched_text: string;
  }>;
  unknowns: string[];
}

function meetingBodyForDetection(note: Note): string {
  const parts: string[] = [];
  if (typeof note.title === 'string' && note.title) parts.push(note.title);
  if (note.summary_text) parts.push(note.summary_text);
  if (note.summary_markdown) parts.push(note.summary_markdown);
  if (Array.isArray(note.transcript)) {
    for (const seg of note.transcript) {
      if (seg?.text) parts.push(seg.text);
    }
  }
  return parts.join('\n\n');
}

async function appendMentionedToMeeting(
  client: McpClient,
  meetingSlug: string,
  note: Note,
  attendeeNames: string[],
  dryRun: boolean,
): Promise<{ matched: number }> {
  const text = meetingBodyForDetection(note);
  if (!text || text.trim().length < 20) return { matched: 0 };

  let result: DetectEntitiesResult;
  try {
    result = await client.tool<DetectEntitiesResult>('detect_entities', { text });
  } catch (e) {
    console.error(`[granola-sync] detect_entities failed for ${meetingSlug}: ${e instanceof Error ? e.message : String(e)}`);
    return { matched: 0 };
  }

  const bySlug = new Map<string, DetectEntitiesResult['matches'][number]>();
  for (const m of result.matches ?? []) {
    const prev = bySlug.get(m.slug);
    if (!prev || m.confidence > prev.confidence) bySlug.set(m.slug, m);
  }
  const allMatches = Array.from(bySlug.values());

  const attendeeNameSet = new Set<string>();
  for (const n of attendeeNames) {
    const t = (n ?? '').trim().toLowerCase();
    if (t) attendeeNameSet.add(t);
  }

  const firstNameGroups = new Map<string, typeof allMatches>();
  for (const m of allMatches) {
    if (m.rule === 'first-name-fallback') {
      const key = (m.matched_text ?? '').trim().toLowerCase();
      if (!key) continue;
      const arr = firstNameGroups.get(key) ?? [];
      arr.push(m);
      firstNameGroups.set(key, arr);
    }
  }
  const keepFirstNameSlugs = new Set<string>();
  for (const [, arr] of firstNameGroups) {
    const inviteHits = arr.filter((m) => attendeeNameSet.has(m.title.trim().toLowerCase()));
    if (inviteHits.length > 0) {
      for (const m of inviteHits) keepFirstNameSlugs.add(m.slug);
    } else if (arr.length === 1) {
      keepFirstNameSlugs.add(arr[0].slug);
    }
  }
  const matches = allMatches
    .filter((m) => m.rule !== 'first-name-fallback' || keepFirstNameSlugs.has(m.slug))
    .sort((a, b) =>
      a.type === b.type ? a.title.localeCompare(b.title) : a.type.localeCompare(b.type),
    );

  if (matches.length === 0) return { matched: 0 };

  const lines = ['## Mentioned', '', 'People, companies, and projects mentioned in this meeting (auto-detected from notes + transcript):', ''];
  for (const m of matches) {
    lines.push(`- [[${m.slug}]] (${m.title})`);
  }
  const block = lines.join('\n') + '\n';

  if (dryRun) return { matched: matches.length };

  try {
    await client.tool('markdown_append_to_page', {
      slug: meetingSlug,
      section: '## Mentioned',
      content: block,
    });
  } catch (e) {
    console.error(`[granola-sync] markdown_append_to_page (Mentioned) failed for ${meetingSlug}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { matched: matches.length };
}

async function appendBulletToAttendee(
  client: McpClient,
  email: string,
  bullet: string,
  isoDate: string,
  displayName: string | undefined,
  dryRun: boolean,
): Promise<{ action: 'appended' | 'created-stub' | 'failed'; slug?: string }> {
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

async function loadGranolaApi(): Promise<GranolaApi> {
  const key = await readKeyFromKeychain();
  if (!key) {
    console.error(`No Granola API key in keychain (service=${KEYCHAIN_SERVICE}, account=${keychainAccount()}).`);
    console.error(`Mint a key in Granola: Settings → Connectors → API keys → Create new key.`);
    console.error(`Then re-run \`bash tools/granola-sync/install.sh\` (or store manually:`);
    console.error(`  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${keychainAccount()} -w 'grn_...').`);
    process.exit(1);
  }
  const api = new GranolaApi(key);
  try {
    await api.validate();
  } catch (e) {
    console.error(`[granola-sync] FATAL: Granola API key rejected — ${e instanceof Error ? e.message : String(e)}`);
    console.error(`Re-run install.sh to update the keychain entry, or update directly:`);
    console.error(`  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${keychainAccount()} -w 'grn_...'`);
    process.exit(2);
  }
  return api;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig(flags.configPath);
  const userFilter = await loadUserFilter(flags.filterPath);
  const cursor = loadCursor(config.cursorPath);
  const sinceCutoff = flags.since ? new Date(flags.since).toISOString() : cursor.lastSyncedCreatedAt;

  console.error(`[granola-sync] mode=${flags.dryRun ? 'DRY RUN' : 'APPLY'} cursor=${sinceCutoff}`);
  console.error(`[granola-sync] user filter: ${flags.filterPath} (RECIPE_VERSION=${userFilter.RECIPE_VERSION ?? 0})`);

  const api = await loadGranolaApi();
  console.error(`[granola-sync] Granola API: authenticated`);

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

  // Build the candidate list of note IDs to fetch in full.
  //  --doc-id: one note, bypasses cursor + dedup.
  //  default: paginated /v1/notes?created_after=<cursor>, dedup against syncedDocumentIds.
  const candidateIds: string[] = [];
  let listed = 0;
  if (flags.docId) {
    candidateIds.push(flags.docId);
  } else {
    const seen = new Set(cursor.syncedDocumentIds);
    for await (const summary of api.iterNotes({ createdAfter: sinceCutoff })) {
      listed++;
      if (seen.has(summary.id)) continue;
      candidateIds.push(summary.id);
    }
    // Order chronologically by listing's natural order from API (which is
    // typically newest-first). Sort ascending by id-discovery isn't safe;
    // we re-sort using `created_at` after fetching full notes.
  }
  console.error(`[granola-sync] Granola API: ${listed} note(s) listed, ${candidateIds.length} candidate(s) after dedup`);

  let kept = 0, skipped = 0, processed = 0;
  let createdMeetings = 0, existedMeetings = 0, updatedMeetings = 0, createdTranscripts = 0;
  let bulletsAppended = 0, stubsCreated = 0, bulletsFailed = 0;
  let mentionedMatches = 0;
  let filterErrors = 0;

  /** Run the user filter defensively. Catches throws and rejects malformed
   *  verdicts. Default on error is `keep: false` — the privacy contract
   *  is "don't file unless the filter clearly says yes." */
  function safeFilter(note: Note): { keep: boolean; reason: string } {
    let verdict: unknown;
    try {
      verdict = userFilter.filter(note);
    } catch (e) {
      filterErrors++;
      return { keep: false, reason: `filter threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!verdict || typeof verdict !== 'object' || typeof (verdict as { keep?: unknown }).keep !== 'boolean') {
      filterErrors++;
      return { keep: false, reason: 'filter returned malformed verdict (expected { keep: boolean, reason: string })' };
    }
    const v = verdict as { keep: boolean; reason?: unknown };
    return { keep: v.keep, reason: typeof v.reason === 'string' ? v.reason : '(no reason)' };
  }
  const newSyncedIds: string[] = [];
  let latestCreatedAt = sinceCutoff;

  function hasContent(note: Note): boolean {
    if (note.transcript && note.transcript.length > 0) return true;
    if (note.summary_text && note.summary_text.trim().length > 0) return true;
    if (note.summary_markdown && note.summary_markdown.trim().length > 0) return true;
    return false;
  }

  // Fetch full notes (with transcript) and process in created_at ascending
  // order so the cursor advances safely even on partial failure.
  const fullNotes: Note[] = [];
  for (const id of candidateIds) {
    if (processed >= flags.limit && !flags.docId) break;
    try {
      const note = await api.getNote(id, { includeTranscript: true });
      fullNotes.push(note);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 = note exists but doesn't yet have summary + transcript — Granola
      // is still processing. It'll show up again on a future run.
      if (/\s404\s/.test(msg)) {
        if (flags.verbose) console.error(`  WAIT note ${id} — not yet processed (404), will retry next run`);
        continue;
      }
      console.error(`[granola-sync] getNote ${id} failed: ${msg}`);
    }
  }
  fullNotes.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  for (const note of fullNotes) {
    if (processed >= flags.limit) break;
    const verdict = safeFilter(note);
    if (!verdict.keep) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${note.title ?? '(no title)'}" — ${verdict.reason}`);
      newSyncedIds.push(note.id);
      latestCreatedAt = note.created_at > latestCreatedAt ? note.created_at : latestCreatedAt;
      continue;
    }
    if (!hasContent(note)) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${note.title ?? '(no title)'}" — Dent-related but Granola returned no content`);
      newSyncedIds.push(note.id);
      latestCreatedAt = note.created_at > latestCreatedAt ? note.created_at : latestCreatedAt;
      continue;
    }
    kept++;
    processed++;
    console.error(`\n  KEEP "${note.title ?? '(no title)'}" — ${verdict.reason}`);

    const t = translateMeeting(note);

    const meeting = await ensureMeetingPage(client, t.meetingSlug, t.meetingContent, flags.dryRun);
    if (meeting === 'created') createdMeetings++;
    else if (meeting === 'updated') updatedMeetings++;
    else existedMeetings++;
    console.error(`    meeting page: ${meeting} (${t.meetingSlug})`);

    if (t.transcriptSlug && t.transcriptContent) {
      const tr = await ensureTranscriptPage(client, t.transcriptSlug, t.transcriptContent, flags.dryRun);
      if (tr === 'created') createdTranscripts++;
      console.error(`    transcript:   ${tr} (${t.transcriptSlug}, ${note.transcript?.length ?? 0} segments)`);
    } else {
      console.error(`    transcript:   none on the note`);
    }

    if (meeting === 'created' || meeting === 'updated') {
      const attendeeNamesArr = Object.values(t.attendeeNames ?? {}).filter((n): n is string => typeof n === 'string' && n.length > 0);
      const m = await appendMentionedToMeeting(client, t.meetingSlug, note, attendeeNamesArr, flags.dryRun);
      mentionedMatches += m.matched;
      if (m.matched > 0) {
        console.error(`    mentioned:    ${m.matched} entities`);
      }
    }

    for (const e of t.attendeeEmails) {
      const r = await appendBulletToAttendee(client, e, t.attendeeBullet, t.isoDate, t.attendeeNames[e], flags.dryRun);
      if (r.action === 'appended') bulletsAppended++;
      else if (r.action === 'created-stub') { stubsCreated++; bulletsAppended++; }
      else if (r.action === 'failed') bulletsFailed++;
    }

    newSyncedIds.push(note.id);
    latestCreatedAt = note.created_at > latestCreatedAt ? note.created_at : latestCreatedAt;
  }

  const allProcessed = [...cursor.syncedDocumentIds, ...newSyncedIds];
  const newCursor: SyncCursor = {
    // --doc-id is a force-run; don't advance the cursor (it might be an old
    // note synced by an operator out of band).
    lastSyncedCreatedAt: flags.docId ? cursor.lastSyncedCreatedAt : latestCreatedAt,
    syncedDocumentIds: allProcessed.slice(-500),
    cursorUpdatedAt: new Date().toISOString(),
    syncVersion: SYNC_VERSION,
  };
  if (!flags.dryRun) saveCursor(config.cursorPath, newCursor);

  console.error(
    `\n[granola-sync] done: kept=${kept} skipped=${skipped} processed=${processed}\n  meetings: ${createdMeetings} created, ${updatedMeetings} updated, ${existedMeetings} already-existed\n  transcripts: ${createdTranscripts} created\n  bullets: ${bulletsAppended} appended (${stubsCreated} new stubs), ${bulletsFailed} failed\n  mentioned: ${mentionedMatches} entities${filterErrors > 0 ? `\n  filter errors: ${filterErrors} (notes treated as keep:false — check user/filter.ts)` : ''}\n  cursor: ${newCursor.lastSyncedCreatedAt}${flags.dryRun ? ' (NOT saved — dry run)' : ''}`,
  );
}

main().catch((e) => {
  console.error('[granola-sync] FATAL', e);
  process.exit(1);
});
