#!/usr/bin/env bun
/**
 * Email-sync collector — Layer 1 of the email pipeline.
 *
 * Runs on the teammate's laptop via launchd (default: every 6h). Pulls
 * Gmail directly via OAuth, filters noise, generates Gmail links, dedupes
 * against a cursor, builds a daily digest page, writes it to dent-brain
 * via MCP. The email body never enters an LLM context; that's why this
 * layer is pure code.
 *
 * Layer 2 — `skills/dent/process-inbox/SKILL.md` — runs as a Claude
 * /schedule routine (cloud), reads the digest pages, and updates entity
 * timelines. The brain is the queue between the two layers.
 *
 * Idempotent on `[Source: gmail/<message-id>]` — re-runs are safe. The
 * digest page for a date is rewritten (not appended) on re-run, so if
 * Gmail backfills more messages on the same date, the digest reflects
 * the merged set.
 *
 * Usage:
 *   bun collect.ts                      # use config from default location
 *   bun collect.ts --dry-run            # plan only, no MCP writes
 *   bun collect.ts --since 2026-04-01   # backfill from a specific date
 *   bun collect.ts --verbose            # log every classification decision
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { CollectedEmail, SyncConfig, SyncCursor, RunSummary } from './types.ts';
import { McpClient } from './mcp-client.ts';
import { GoogleClient, header, parseAddress, parseAddressList } from './google-client.ts';
import { isNoise, isSignature } from './noise-filter.ts';
import { gmailLink } from './link-gen.ts';
import { buildDigest, digestSlug } from './digest.ts';

const SYNC_VERSION = '0.1.0';
const DEFAULT_CONFIG_PATH = join(homedir(), '.dent-brain', 'email-sync', 'config.json');
const DEFAULT_BACKFILL_DAYS = 3;

interface Flags {
  dryRun: boolean;
  verbose: boolean;
  since: string | null;
  configPath: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { dryRun: false, verbose: false, since: null, configPath: DEFAULT_CONFIG_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') f.dryRun = true;
    else if (a === '--verbose' || a === '-v') f.verbose = true;
    else if (a === '--since') f.since = argv[++i];
    else if (a === '--config') f.configPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return f;
}

function printHelp() {
  console.error(
    `Email-sync collector — pulls Gmail via direct OAuth, writes daily digest to dent-brain.\n\nUsage: bun collect.ts [flags]\n  --dry-run                Plan only, no MCP writes.\n  --since YYYY-MM-DD       Backfill from this date (override cursor).\n  --verbose | -v           Log every classification decision.\n  --config <path>          Override config path (default: ${DEFAULT_CONFIG_PATH}).\n  --help | -h              Print this help.\n`,
  );
}

/** Auto-discover dent-brain MCP creds from ~/.claude.json (same shape granola-sync uses). */
function discoverMcp(): { serverUrl: string; bearerToken: string } | null {
  const claudeJson = join(homedir(), '.claude.json');
  if (!existsSync(claudeJson)) return null;
  try {
    const c = JSON.parse(readFileSync(claudeJson, 'utf-8'));
    const projects = c?.projects ? Object.values(c.projects) : [];
    const candidates: any[] = [c, ...projects];
    for (const cand of candidates) {
      const e = cand?.mcpServers?.['dent-brain'];
      const url = e?.url;
      const auth = e?.headers?.Authorization;
      if (typeof url === 'string' && typeof auth === 'string' && auth.startsWith('Bearer ')) {
        return { serverUrl: url, bearerToken: auth.slice('Bearer '.length) };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function loadConfig(path: string): SyncConfig {
  if (!existsSync(path)) {
    console.error(`No email-sync config at ${path}.`);
    console.error('Run the installer (`tools/email-sync/install.sh` or `/dent-extensions install email-sync`) first.');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

  const discovered = discoverMcp();
  const serverUrl = String(raw.serverUrl ?? discovered?.serverUrl ?? '');
  const bearerToken = String(raw.bearerToken ?? discovered?.bearerToken ?? '');
  if (!serverUrl || !bearerToken) {
    console.error('No dent-brain MCP server discovered. Run /dent-onboard-teammate first.');
    process.exit(1);
  }

  const required = ['googleClientId', 'googleClientSecret', 'workEmail'] as const;
  for (const k of required) {
    const v = raw[k];
    if (typeof v !== 'string' || !v || /^REPLACE_/.test(v)) {
      console.error(`Config field \`${k}\` is missing or unconfigured. Edit ${path} and re-run.`);
      process.exit(1);
    }
  }

  return {
    serverUrl,
    bearerToken,
    googleClientId: String(raw.googleClientId),
    googleClientSecret: String(raw.googleClientSecret),
    googleTokensPath: String(raw.googleTokensPath ?? join(homedir(), '.dent-brain', 'email-sync', 'google-tokens.json')),
    workEmail: String(raw.workEmail).toLowerCase(),
    authUser: String(raw.authUser ?? '0'),
    cursorPath: String(raw.cursorPath ?? join(homedir(), '.dent-brain', 'email-sync', 'cursor.json')),
    cacheDir: String(raw.cacheDir ?? join(homedir(), '.dent-brain', 'email-sync', 'cache')),
  };
}

function loadCursor(path: string): SyncCursor {
  if (!existsSync(path)) {
    return {
      lastSyncedAt: '1970-01-01T00:00:00.000Z',
      syncedMessageIds: [],
      cursorUpdatedAt: new Date().toISOString(),
      syncVersion: SYNC_VERSION,
    };
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as SyncCursor;
}

function saveCursor(path: string, cursor: SyncCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2), 'utf-8');
}

/**
 * Build the Gmail search query.
 *
 * Privacy rule: STRICT scoping to the configured work email. Users with
 * multiple addresses on the same inbox (jason@dentthefuture.com,
 * jason@jrpreston.com) get only the work-email traffic in the brain.
 * The `-from:` exclusions strip noise senders Gmail-side so they never
 * enter the response — we don't even pay token cost to fetch them.
 */
function buildGmailQuery(workEmail: string, sinceIso: string): string {
  // Gmail's `after:` takes YYYY/MM/DD or unix epoch.
  const epoch = Math.floor(new Date(sinceIso).getTime() / 1000);
  const scope = `(from:${workEmail} OR to:${workEmail} OR cc:${workEmail} OR bcc:${workEmail})`;
  const noiseExcludes = [
    '-from:noreply', '-from:no-reply', '-from:donotreply', '-from:do-not-reply',
    '-from:notifications', '-from:notification@', '-from:calendar-notification',
    '-from:mailer-daemon', '-from:postmaster', '-from:bounces', '-from:bounce@',
  ].join(' ');
  return `${scope} ${noiseExcludes} after:${epoch}`;
}

/** Translate a fetched Gmail message into our CollectedEmail shape. */
function translateMessage(msg: any, workEmail: string, authUser: string): CollectedEmail | null {
  const from = parseAddress(header(msg, 'From'));
  if (!from.email) return null;

  const recipients = [
    ...parseAddressList(header(msg, 'To')),
    ...parseAddressList(header(msg, 'Cc')),
    ...parseAddressList(header(msg, 'Bcc')),
  ].filter((e, i, a) => a.indexOf(e) === i);

  const dateHeader = header(msg, 'Date');
  // Gmail also gives us internalDate (millis since epoch as a string). Prefer it
  // because Date headers can be stale or malformed.
  const dateIso = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : (dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString());

  const subject = header(msg, 'Subject');
  const snippet = msg.snippet ?? msg.payload?.snippet ?? '';

  return {
    messageId: String(msg.id),
    threadId: String(msg.threadId ?? msg.id),
    date: dateIso,
    fromEmail: from.email,
    fromName: from.name,
    recipients,
    subject,
    snippet,
    gmailLink: gmailLink(String(msg.id), authUser),
    isNoise: isNoise(from.email),
    isSignature: isSignature(subject, from.email),
    isOutbound: from.email === workEmail,
  };
}

/**
 * Group emails by UTC date so we can write one digest page per day.
 * A run that backfills 3 days produces 3 digest pages.
 */
function groupByDate(emails: CollectedEmail[]): Map<string, CollectedEmail[]> {
  const m = new Map<string, CollectedEmail[]>();
  for (const e of emails) {
    const day = e.date.slice(0, 10); // YYYY-MM-DD
    const arr = m.get(day) ?? [];
    arr.push(e);
    m.set(day, arr);
  }
  return m;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig(flags.configPath);
  const cursor = loadCursor(config.cursorPath);

  const sinceIso = flags.since
    ? new Date(flags.since).toISOString()
    : (cursor.lastSyncedAt && cursor.lastSyncedAt > '1970-01-01T00:00:01.000Z'
        ? cursor.lastSyncedAt
        : new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString());

  console.error(`[email-sync] mode=${flags.dryRun ? 'DRY RUN' : 'APPLY'} workEmail=${config.workEmail} since=${sinceIso}`);

  const gc = new GoogleClient({
    tokensPath: config.googleTokensPath,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });

  // Health probe up front. Token expired / revoked → fail fast.
  try {
    const profile = await gc.health();
    if (flags.verbose) console.error(`[email-sync] gmail profile: ${profile.emailAddress}`);
    if (profile.emailAddress.toLowerCase() !== config.workEmail) {
      console.error(`[email-sync] FATAL: OAuth tokens are for ${profile.emailAddress} but config.workEmail is ${config.workEmail}. Re-run install.sh to re-authorize.`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`[email-sync] FATAL: Gmail health probe failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  If the access token was revoked, re-run tools/email-sync/install.sh to re-authorize.`);
    process.exit(2);
  }

  const query = buildGmailQuery(config.workEmail, sinceIso);
  if (flags.verbose) console.error(`[email-sync] gmail query: ${query}`);

  const { ids } = await gc.listMessages(query, 100);
  console.error(`[email-sync] gmail returned ${ids.length} candidate ids`);

  // Skip any we've already processed.
  const known = new Set(cursor.syncedMessageIds);
  const fresh = ids.filter((m) => !known.has(m.id));
  if (flags.verbose && ids.length !== fresh.length) {
    console.error(`[email-sync] dedup: ${ids.length - fresh.length} already-seen ids skipped`);
  }

  const collected: CollectedEmail[] = [];
  for (const { id } of fresh) {
    try {
      const msg = await gc.getMessage(id, 'metadata');
      const translated = translateMessage(msg, config.workEmail, config.authUser);
      if (!translated) {
        if (flags.verbose) console.error(`  skip ${id} — could not parse`);
        continue;
      }
      // Belt-and-suspenders: re-check the work-email scope here in case the
      // Gmail query slipped (it shouldn't, but a missing header on a forwarded
      // message could let one through). Strict drop.
      const onThisEmail = translated.fromEmail === config.workEmail
        || translated.recipients.includes(config.workEmail);
      if (!onThisEmail) {
        if (flags.verbose) console.error(`  drop ${id} — not on ${config.workEmail}`);
        continue;
      }
      collected.push(translated);
      if (flags.verbose) {
        const tag = translated.isNoise ? 'NOISE' : translated.isSignature ? 'SIG' : 'TRIAGE';
        console.error(`  ${tag} ${translated.date.slice(0, 10)} ${translated.fromEmail} → ${translated.subject.slice(0, 60)}`);
      }
    } catch (e) {
      console.error(`[email-sync] fetch ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Sort oldest-first so the cursor advances monotonically.
  collected.sort((a, b) => a.date.localeCompare(b.date));
  console.error(`[email-sync] collected ${collected.length} emails (after dedup + scope re-check)`);

  // Write one digest page per UTC day.
  const grouped = groupByDate(collected);
  const client = new McpClient({ serverUrl: config.serverUrl, bearerToken: config.bearerToken });
  if (!flags.dryRun) {
    try {
      const init = await client.initialize();
      console.error(`[email-sync] connected to ${init.serverInfo.name} v${init.serverInfo.version}`);
    } catch (e) {
      console.error(`[email-sync] FATAL: dent-brain MCP unreachable: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(3);
    }
  }

  let written = 0;
  let lastSlug: string | null = null;
  for (const [day, dayEmails] of Array.from(grouped.entries()).sort()) {
    const digest = buildDigest(config.workEmail, day, dayEmails);
    lastSlug = digest.slug;
    if (flags.dryRun) {
      console.error(`  [dry-run] would write ${digest.slug} — ${digest.counts.triage} triage / ${digest.counts.signatures} sig / ${digest.counts.noise} noise`);
    } else {
      try {
        // Inbox digests are transient machine-generated content — go to
        // db-only storage via put_page (no git commit, no push). Layer 2
        // reads them once via the brain MCP, marks `processed: true`, and
        // they age out of relevance. Using markdown_replace_page would
        // bloat dent-brain-data with daily junk.
        await client.tool('put_page', {
          slug: digest.slug,
          content: digest.content,
        });
        written++;
        console.error(`  wrote ${digest.slug} — ${digest.counts.triage} triage / ${digest.counts.signatures} sig / ${digest.counts.noise} noise`);
      } catch (e) {
        const detail = (e as { result?: { content?: Array<{ text?: string }> } })?.result?.content
          ?.map((c) => c?.text).filter(Boolean).join(' | ') ?? '';
        console.error(`  FAILED ${digest.slug}: ${e instanceof Error ? e.message : String(e)}${detail ? ` — ${detail}` : ''}`);
      }
    }
  }

  // Advance cursor — to the latest collected message's date, plus message ids
  // (cap at 1000) for dedup-or-drift safety.
  const latestIso = collected.length > 0
    ? collected[collected.length - 1].date
    : cursor.lastSyncedAt;
  const newKnown = [...cursor.syncedMessageIds, ...collected.map((e) => e.messageId)].slice(-1000);
  const newCursor: SyncCursor = {
    lastSyncedAt: latestIso,
    syncedMessageIds: newKnown,
    cursorUpdatedAt: new Date().toISOString(),
    syncVersion: SYNC_VERSION,
  };
  if (!flags.dryRun) saveCursor(config.cursorPath, newCursor);

  const summary: RunSummary = {
    startedAt: cursor.cursorUpdatedAt,
    finishedAt: new Date().toISOString(),
    candidates: ids.length,
    fetched: collected.length,
    noise: collected.filter((e) => e.isNoise).length,
    signatures: collected.filter((e) => e.isSignature).length,
    written,
    digestSlug: lastSlug,
    cursorAdvancedTo: newCursor.lastSyncedAt,
  };
  console.error(
    `\n[email-sync] done: candidates=${summary.candidates} fetched=${summary.fetched} noise=${summary.noise} signatures=${summary.signatures} written=${summary.written}\n  cursor: ${summary.cursorAdvancedTo}${flags.dryRun ? ' (NOT saved — dry run)' : ''}`,
  );
}

main().catch((e) => {
  console.error('[email-sync] FATAL', e);
  process.exit(99);
});
