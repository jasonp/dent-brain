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
 * Dedup is keyed on the stable `granola_document_id` (identity, via the brain's
 * get_page_by_identity op), NOT a title-derived slug — so re-runs AND Granola
 * renames are both safe (a rename updates the page in place instead of forking
 * a second one). Enrichment is idempotent too.
 *
 * Usage:
 *   bun sync.ts                     # use config from ~/.dent-brain/granola-sync/config.json
 *   bun sync.ts --dry-run           # plan only, no MCP calls
 *   bun sync.ts --limit 3           # cap how many meetings get processed
 *   bun sync.ts --since 2026-04-01  # widen the reconcile window back to this date (backfill)
 *   bun sync.ts --doc-id not_...    # sync a single specific Granola note
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { Note, NoteSummary, SyncConfig, UserFilterModule } from './types.ts';
import { McpClient } from './mcp-client.ts';
import { translateMeeting } from './translator.ts';
import { GranolaApi, readKeyFromKeychain, KEYCHAIN_SERVICE, keychainAccount } from './granola-api.ts';

/** Reconcile window: each run re-scans the include folders' notes CREATED in the
 *  last N hours (the scan filters on note creation time, server-side) and ingests
 *  any the brain doesn't already have. Late filing self-heals as long as the note
 *  was *created* within the window — file a recently-recorded meeting into an
 *  include folder and the next run picks it up. A note created BEFORE the window
 *  (an old meeting filed into the folder today) is NOT auto-caught; use `--since`
 *  to backfill it. Wider window = more slack at ~no cost (the identity existence
 *  check skips already-ingested notes). Env override: GRANOLA_SYNC_LOOKBACK_HOURS. */
const LOOKBACK_HOURS = (() => {
  const raw = parseFloat(process.env.GRANOLA_SYNC_LOOKBACK_HOURS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 48;
})();
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
    `Granola → Dent Brain sync daemon\n\nReconciles the include folders' recent notes (last ${LOOKBACK_HOURS}h) against the\nbrain each run, ingesting any not already present. Late filing self-heals.\n\nUsage: bun sync.ts [flags]\n  --dry-run                Plan only, no writes.\n  --limit <n>              Cap meetings ingested per run (default: no cap).\n  --since YYYY-MM-DD       Widen the reconcile window back to this date (backfill).\n  --doc-id <not_...>       Sync exactly one note (bypasses the folder/window scan).\n  --config <path>          Override config path (default: ~/.dent-brain/granola-sync/config.json).\n  --filter <path>          Override user filter path (default: <install-dir>/user/filter.ts).\n  --verbose | -v           Log every note decision.\n  --help | -h              Print this help.\n`,
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
  if (!Array.isArray(mod.includeFolders) || mod.includeFolders.length === 0 || !mod.includeFolders.every((f) => typeof f === 'string' && f.trim())) {
    console.error(`[granola-sync] FATAL: ${path} must export \`includeFolders: string[]\` — the Granola folder name(s) to sync.`);
    console.error(`  The daemon pulls only these folders' notes each run. Example: export const includeFolders = ['Dent'];`);
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

  return { serverUrl, bearerToken };
}

interface ExistingPage {
  exists: boolean;
  bodyLength: number;
  fromGranola: boolean;
  /** Page body — used by the attendee-bullet idempotency guard. */
  body: string;
}

async function fetchPage(client: McpClient, slug: string): Promise<ExistingPage> {
  try {
    const page = await client.tool<{ compiled_truth?: string; frontmatter?: Record<string, unknown> } | null>('get_page', { slug });
    if (!page || (typeof page === 'object' && Object.keys(page).length === 0)) {
      return { exists: false, bodyLength: 0, fromGranola: false, body: '' };
    }
    const body = page.compiled_truth ?? '';
    const fromGranola = page.frontmatter?.['created_via'] === 'granola-sync';
    return { exists: true, bodyLength: body.length, fromGranola, body };
  } catch {
    return { exists: false, bodyLength: 0, fromGranola: false, body: '' };
  }
}

/** The meeting page's `## Mentioned` block is the LAST write of the ingest pass.
 *  We can't use the heading itself as the completion marker: `## Mentioned` is a
 *  human-plausible heading that a meeting's own Granola notes might contain, which
 *  would falsely mark the note enriched and skip our entity detection forever.
 *  Instead the block ENDS with a granola-private HTML-comment sentinel; its
 *  presence (and only its presence) means our enrichment finished. Writer
 *  (appendMentionedToMeeting) and reader (fetchByGranolaId) share this one
 *  constant, so they can't drift. */
const MENTIONED_SECTION = '## Mentioned';
const ENRICHED_SENTINEL = '<!-- granola-sync:enriched -->';

interface IdentityHit {
  exists: boolean;
  /** Canonical slug of the existing page — the write target to reuse so a
   *  Granola rename updates in place instead of forking a new page. */
  slug?: string;
  /** True when the page already carries the ENRICHED_SENTINEL completion marker. */
  enriched?: boolean;
  /** The identity lookup itself failed (network/transport). The caller must NOT
   *  treat this as "absent" and create a new page — that would fork a renamed
   *  note. Skip and retry next run instead. */
  error?: boolean;
}

/** Existence + identity lookup keyed on the stable granola_document_id (NOT a
 *  title-derived slug), constrained to the MEETING page (the transcript page
 *  shares the same granola_document_id, so without the type filter the lookup
 *  could return the transcript's slug). Only granola-sync stamps that field, so
 *  any hit is ours — no `created_via` cross-check needed. */
async function fetchByGranolaId(client: McpClient, docId: string): Promise<IdentityHit> {
  try {
    const res = await client.tool<{ exists?: boolean; slug?: string; compiled_truth?: string } | null>(
      'get_page_by_identity',
      { key: 'granola_document_id', value: docId, type: 'meeting' },
    );
    if (!res || res.exists !== true || !res.slug) return { exists: false };
    return { exists: true, slug: res.slug, enriched: (res.compiled_truth ?? '').includes(ENRICHED_SENTINEL) };
  } catch (e) {
    // A read failure must NOT masquerade as "absent" — that path creates a new
    // page, forking any note renamed since its last sync. Signal error so the
    // caller skips this note and retries next run; a missed ingest is cheap, a
    // fork needs manual cleanup.
    console.error(`[granola-sync] identity lookup failed for ${docId}: ${e instanceof Error ? e.message : String(e)}`);
    return { exists: false, error: true };
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
): Promise<{ slug: string; created: boolean; body: string }> {
  const local = email.split('@')[0] ?? email;
  const base = (displayName ?? local).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    // Re-strip trailing hyphens *after* the 80-char slice: truncation can cut on
    // a hyphen boundary and re-introduce one, which slugifySegment drops →
    // SLUG_MISMATCH that blocks sync. See translator.ts kebab() for the same fix.
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  const slug = `entities/people/${base || 'unknown-attendee'}`;
  const existing = await fetchPage(client, slug);
  if (existing.exists) return { slug, created: false, body: existing.body };
  if (dryRun) return { slug, created: true, body: '' };
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
  return { slug, created: true, body: '' };
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

/**
 * Append the meeting's `## Mentioned` section. This is the LAST write of the
 * ingest pass; the block ends with the granola-private ENRICHED_SENTINEL, whose
 * presence is the completion marker fetchByGranolaId reads. It is written once
 * (atomically, in a single append) even when no entities are detected (a
 * placeholder), guaranteeing the sentinel lands.
 *
 * Idempotent two ways: when the page already carries the sentinel
 * (`alreadyHasMentioned`) we skip the detection + write entirely; and the write
 * itself uses `replace_section` so it collapses ANY pre-existing `## Mentioned`
 * (including a duplicate left by an older daemon) into one clean block. The
 * `## Mentioned` heading is created by the `section:` splice param, so the block
 * body carries NO heading of its own.
 *
 * Robustness exception: a TRANSIENT detect_entities failure returns `error`
 * WITHOUT writing the marker, so the next run re-fetches and retries detection
 * instead of permanently filing the meeting with no entities. A genuine
 * zero-match result DOES write the placeholder marker (nothing to retry).
 */
async function appendMentionedToMeeting(
  client: McpClient,
  meetingSlug: string,
  note: Note,
  attendeeNames: string[],
  alreadyHasMentioned: boolean,
  dryRun: boolean,
): Promise<{ matched: number; skipped?: boolean; error?: boolean }> {
  if (alreadyHasMentioned) return { matched: 0, skipped: true };

  let matches: DetectEntitiesResult['matches'] = [];
  const text = meetingBodyForDetection(note);
  if (text && text.trim().length >= 20) {
    let result: DetectEntitiesResult;
    try {
      result = await client.tool<DetectEntitiesResult>('detect_entities', { text });
    } catch (e) {
      // Transient — leave the page UNMARKED so a later run retries detection.
      console.error(`[granola-sync] detect_entities failed for ${meetingSlug}: ${e instanceof Error ? e.message : String(e)}`);
      return { matched: 0, error: true };
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
    matches = allMatches
      .filter((m) => m.rule !== 'first-name-fallback' || keepFirstNameSlugs.has(m.slug))
      .sort((a, b) =>
        a.type === b.type ? a.title.localeCompare(b.title) : a.type.localeCompare(b.type),
      );
  }

  // Block body WITHOUT a heading — the section splice param creates `## Mentioned`.
  // The block ENDS with ENRICHED_SENTINEL: that granola-private marker (not the
  // human-plausible heading) is what signals "our enrichment finished."
  const lines = matches.length > 0
    ? ['People, companies, and projects mentioned in this meeting (auto-detected from notes + transcript):', '',
       // Collapse any whitespace in the title so a title can never inject a
       // newline + `## …` heading into the section (replace_section assumes the
       // fragment carries no headings of its own).
       ...matches.map((m) => `- [[${m.slug}]] (${m.title.replace(/\s+/g, ' ').trim()})`)]
    : ['_No entities auto-detected._'];
  lines.push('', ENRICHED_SENTINEL);
  const block = lines.join('\n') + '\n';

  if (dryRun) return { matched: matches.length };

  try {
    await client.tool('markdown_append_to_page', {
      slug: meetingSlug,
      section: MENTIONED_SECTION,
      content: block,
      // Replace, don't append: collapses any pre-existing/duplicate `## Mentioned`
      // (e.g. left by an older daemon) into one clean block. Idempotent.
      replace_section: true,
    });
  } catch (e) {
    // Marker write failed — report error so the caller doesn't count it as done.
    console.error(`[granola-sync] markdown_append_to_page (Mentioned) failed for ${meetingSlug}: ${e instanceof Error ? e.message : String(e)}`);
    return { matched: matches.length, error: true };
  }
  return { matched: matches.length };
}

async function appendBulletToAttendee(
  client: McpClient,
  email: string,
  bullet: string,
  sourceRef: string,
  isoDate: string,
  displayName: string | undefined,
  dryRun: boolean,
): Promise<{ action: 'appended' | 'created-stub' | 'existed' | 'failed'; slug?: string }> {
  const stub = await ensureAttendeeStub(client, email, displayName, isoDate, dryRun);
  if (dryRun) return { action: stub.created ? 'created-stub' : 'appended', slug: stub.slug };
  // Idempotent: a bullet for THIS meeting is keyed on its per-note sourceRef
  // (`granola/<doc-id>`, embedded in the bullet). If the attendee's timeline
  // already carries it, don't append a duplicate — this closes the re-run /
  // partial-failure double-bullet hole.
  if (!stub.created && stub.body.includes(sourceRef)) {
    return { action: 'existed', slug: stub.slug };
  }
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
  // Reconcile window: now - LOOKBACK_HOURS, or --since for a wider backfill.
  const windowStart = flags.since
    ? new Date(flags.since).toISOString()
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  console.error(`[granola-sync] mode=${flags.dryRun ? 'DRY RUN' : 'APPLY'} window=since ${windowStart}`);
  console.error(`[granola-sync] user filter: ${flags.filterPath} (RECIPE_VERSION=${userFilter.RECIPE_VERSION ?? 0}) folders=[${userFilter.includeFolders.join(', ')}]`);

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

  // Resolve include-folder NAMES → `fol_…` ids for the server-side folder filter.
  // --doc-id skips this (operator force-import of one note, any folder).
  const folderIdsByName = new Map<string, string>();
  if (!flags.docId) {
    let folders;
    try {
      folders = await api.listFolders();
    } catch (e) {
      console.error(`[granola-sync] FATAL: could not list Granola folders: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    const byLowerName = new Map(folders.map((f) => [f.name.toLowerCase(), f]));
    for (const name of userFilter.includeFolders) {
      const f = byLowerName.get(name.toLowerCase());
      if (f) folderIdsByName.set(name, f.id);
      else console.error(`[granola-sync] WARN: include folder "${name}" not found in Granola — skipping it`);
    }
    if (folderIdsByName.size === 0) {
      console.error(`[granola-sync] FATAL: none of the include folders [${userFilter.includeFolders.join(', ')}] exist in Granola. Nothing to sync.`);
      process.exit(2);
    }
  }

  // Candidate summaries: every note in the include folders within the window
  // (deduped — a note can be in two folders). --doc-id → just that note.
  const candidates = new Map<string, NoteSummary>();
  if (flags.docId) {
    candidates.set(flags.docId, { id: flags.docId } as NoteSummary);
  } else {
    for (const [name, folderId] of folderIdsByName) {
      let n = 0;
      for await (const summary of api.iterNotes({ createdAfter: windowStart, folderId })) {
        candidates.set(summary.id, summary);
        n++;
      }
      console.error(`[granola-sync] folder "${name}": ${n} note(s) since ${windowStart}`);
    }
  }
  console.error(`[granola-sync] ${candidates.size} candidate note(s) to reconcile against the brain`);

  // `alreadyFiled` = notes skipped whole because the brain already has them
  // enriched (the steady-state path). Distinct from `existedMeetings`, which
  // counts meeting PAGES that existed at write time within a processed note.
  let kept = 0, alreadyFiled = 0, skipped = 0, processed = 0;
  let createdMeetings = 0, existedMeetings = 0, updatedMeetings = 0, createdTranscripts = 0;
  let bulletsAppended = 0, stubsCreated = 0, bulletsExisted = 0, bulletsFailed = 0;
  let mentionedMatches = 0;
  let filterErrors = 0;
  let lookupErrors = 0;

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

  function hasContent(note: Note): boolean {
    if (note.transcript && note.transcript.length > 0) return true;
    if (note.summary_text && note.summary_text.trim().length > 0) return true;
    if (note.summary_markdown && note.summary_markdown.trim().length > 0) return true;
    return false;
  }

  // Process oldest-first so --limit drains the earliest backlog first.
  const ordered = [...candidates.values()].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
  );

  for (const summary of ordered) {
    if (processed >= flags.limit) break;

    // Identity dedup — this IS the dedup. Keyed on the stable granola_document_id
    // (NOT a title-derived slug), so a Granola rename can never fork a second
    // page: the lookup still matches and returns the canonical slug to reuse as
    // the write target. Steady state: an already-enriched page short-circuits
    // without a full getNote. A page that exists but isn't enriched yet (run
    // killed mid-enrichment) falls through and finishes — closing the
    // partial-failure hole. --doc-id never skips (operator recovery) but still
    // reuses the canonical slug so a forced re-import updates in place.
    let canonicalSlug: string | undefined;
    const hit = await fetchByGranolaId(client, summary.id);
    if (hit.error) {
      // Lookup failed — don't risk forking a renamed note by treating it as new.
      // Skip and retry next run (a missed ingest is cheap; a fork is not).
      lookupErrors++;
      if (flags.verbose) console.error(`  SKIP "${summary.title ?? '(no title)'}" — identity lookup failed; retry next run`);
      continue;
    }
    if (hit.exists) {
      canonicalSlug = hit.slug;
      if (!flags.docId && hit.enriched) {
        alreadyFiled++;
        if (flags.verbose) console.error(`  HAVE "${summary.title ?? '(no title)'}" — already in brain`);
        continue;
      }
      if (!flags.docId && flags.verbose) {
        console.error(`  RESUME "${summary.title ?? '(no title)'}" — page exists but enrichment incomplete; finishing`);
      }
    }

    // Gap, partial page, or --doc-id force: fetch in full and decide.
    let note: Note;
    try {
      note = await api.getNote(summary.id, { includeTranscript: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 = exists but no summary+transcript yet (Granola still processing) —
      // a future run picks it up once ready.
      if (/\s404\s/.test(msg)) {
        if (flags.verbose) console.error(`  WAIT note ${summary.id} — not yet processed (404)`);
        continue;
      }
      console.error(`[granola-sync] getNote ${summary.id} failed: ${msg}`);
      continue;
    }

    const verdict = safeFilter(note);
    if (!verdict.keep) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${note.title ?? '(no title)'}" — ${verdict.reason}`);
      continue;
    }
    if (!hasContent(note)) {
      skipped++;
      if (flags.verbose) console.error(`  SKIP "${note.title ?? '(no title)'}" — kept but Granola returned no content`);
      continue;
    }
    kept++;
    processed++;
    console.error(`\n  KEEP "${note.title ?? '(no title)'}" — ${verdict.reason}`);

    // Reuse the existing page's slug when we have one, so a Granola rename
    // updates in place instead of creating a second page at the new title.
    const t = translateMeeting(note, { canonicalSlug });

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

    // Enrichment, ordered so the completion marker lands LAST. Attendee bullets
    // first (each idempotent on the per-note sourceRef), then the meeting's
    // `## Mentioned` block — which is the marker the identity pre-check reads.
    // A run killed between the two leaves the page un-marked, so the next run
    // re-fetches and finishes both (idempotently). Both run on EVERY processed
    // note, not just created/updated, so a resumed partial page completes.
    for (const e of t.attendeeEmails) {
      const r = await appendBulletToAttendee(client, e, t.attendeeBullet, t.sourceRef, t.isoDate, t.attendeeNames[e], flags.dryRun);
      if (r.action === 'appended') bulletsAppended++;
      else if (r.action === 'created-stub') { stubsCreated++; bulletsAppended++; }
      else if (r.action === 'existed') bulletsExisted++;
      else if (r.action === 'failed') bulletsFailed++;
    }

    // alreadyHasMentioned guard reads the PRE-write hit, so it's only valid when
    // ensureMeetingPage left the body untouched ('existed'). A 'created'/'updated'
    // meeting was rewritten from fresh translated content — the sentinel is gone,
    // so we must re-append regardless of what the hit said.
    const attendeeNamesArr = Object.values(t.attendeeNames ?? {}).filter((n): n is string => typeof n === 'string' && n.length > 0);
    const alreadyHasMentioned = meeting === 'existed' && hit.enriched === true;
    const m = await appendMentionedToMeeting(client, t.meetingSlug, note, attendeeNamesArr, alreadyHasMentioned, flags.dryRun);
    mentionedMatches += m.matched;
    if (m.matched > 0) {
      console.error(`    mentioned:    ${m.matched} entities`);
    } else if (m.error) {
      console.error(`    mentioned:    detection failed — will retry next run`);
    }
  }

  console.error(
    `\n[granola-sync] done: kept=${kept} already-filed=${alreadyFiled} skipped=${skipped} processed=${processed}\n  meetings: ${createdMeetings} created, ${updatedMeetings} updated, ${existedMeetings} already-existed\n  transcripts: ${createdTranscripts} created\n  bullets: ${bulletsAppended} appended (${stubsCreated} new stubs), ${bulletsExisted} already-present, ${bulletsFailed} failed\n  mentioned: ${mentionedMatches} entities${filterErrors > 0 ? `\n  filter errors: ${filterErrors} (notes treated as keep:false — check user/filter.ts)` : ''}${lookupErrors > 0 ? `\n  lookup errors: ${lookupErrors} (notes skipped — identity lookup failed, will retry next run)` : ''}${flags.dryRun ? '\n  (DRY RUN — no writes)' : ''}`,
  );
}

main().catch((e) => {
  console.error('[granola-sync] FATAL', e);
  process.exit(1);
});
