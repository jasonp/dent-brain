#!/usr/bin/env bun
/**
 * v0.45 single-brain one-time reconciliation.
 *
 * Before v0.45 the brain had three copies of "the truth":
 *   - pages on source 'dent'      (the canonical store going forward)
 *   - pages on source 'default'   (split-brain leftovers from pre-v0.43)
 *   - dent-brain-data git files   (the old markdown-canonical store)
 *
 * This script converges all three onto source 'dent', newest-wins, then
 * (separately, gated) purges the 'default' rows.
 *
 * Usage (staged):
 *   # 1. Dry-run — full decision report, zero writes:
 *   DATABASE_URL=... bun run scripts/dent/migrate-v0.45-single-brain.ts \
 *     --repo /path/to/dent-brain-data --repo-ref <pinned-commit> \
 *     --report /tmp/v045-report.jsonl
 *
 *   # 2. Apply — same, plus importFromContent writes + config hygiene:
 *   DATABASE_URL=... bun run scripts/dent/migrate-v0.45-single-brain.ts \
 *     --repo ... --repo-ref <pinned-commit> --apply --report ...
 *
 *   # 3. Purge default-source rows (separate invocation, irreversible):
 *   DATABASE_URL=... bun run scripts/dent/migrate-v0.45-single-brain.ts \
 *     --purge-default --yes
 *
 * IMPORTANT: --repo-ref must be the commit the data repo was at BEFORE the
 * v0.45 deploy. Do NOT use the repo's current HEAD — the nightly exporter
 * may already have rewritten it from the (possibly incomplete) DB state.
 * All git reads go through `git show <ref>:<path>` / `git log <ref> -- …`
 * so the working tree and HEAD are never consulted.
 *
 * Winner selection per slug:
 *   - All present copies hash-equal → keep the dent row, no write.
 *   - Else newest wins: git candidate timestamp = last commit touching the
 *     file at/before the pinned ref; DB candidates = pages.updated_at.
 *   - Tie → git wins (it was the historical source of truth).
 *   - Winner is written via importFromContent (source 'dent', noEmbed)
 *     only when it differs from the current dent copy.
 *
 * Idempotent: a re-run after a successful --apply performs 0 writes (the
 * just-written dent rows are now the newest candidates).
 *
 * After --apply, re-embed: `... embed --stale` (writes here are noEmbed).
 */

import { execFileSync } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { isManagedPath } from '../../src/dent/exporter/export.ts';
import { DENT_SOURCE_ID } from '../../src/dent/db-writer/page-io.ts';

// ---------------------------------------------------------------------------
// Git helpers (pinned-ref reads only — never HEAD, never the working tree)
// ---------------------------------------------------------------------------

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** All managed *.md paths at the pinned ref → slugs. */
export function listGitSlugs(repo: string, ref: string): Map<string, string> {
  const out = git(repo, ['ls-tree', '-r', '--name-only', ref]);
  const slugToPath = new Map<string, string>();
  for (const line of out.split('\n')) {
    const path = line.trim();
    if (!path || !isManagedPath(path)) continue;
    slugToPath.set(path.slice(0, -3), path); // strip ".md"
  }
  return slugToPath;
}

export function gitFileContent(repo: string, ref: string, path: string): string {
  return git(repo, ['show', `${ref}:${path}`]);
}

/** Commit timestamp (ms) of the last commit at/before `ref` touching `path`. */
export function gitFileTimestampMs(repo: string, ref: string, path: string): number {
  const out = git(repo, ['log', '-1', '--format=%ct', ref, '--', path]).trim();
  const seconds = Number.parseInt(out, 10);
  if (!Number.isFinite(seconds)) {
    throw new Error(`could not resolve git timestamp for ${path} at ${ref} (got: ${JSON.stringify(out)})`);
  }
  return seconds * 1000;
}

// ---------------------------------------------------------------------------
// DB candidate rendering
// ---------------------------------------------------------------------------

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface Candidate {
  source: 'dent' | 'default' | 'git';
  content: string;
  hash: string;
  tsMs: number;
}

/** Render a (sourceId, slug) row to canonical markdown, or null when absent. */
export async function renderDbCandidate(
  engine: BrainEngine,
  slug: string,
  sourceId: 'dent' | 'default',
): Promise<Candidate | null> {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) return null;
  const tags = await engine.getTags(slug, { sourceId });
  const markdown = serializePageToMarkdown(page, tags);
  const updatedAt = page.updated_at instanceof Date ? page.updated_at : new Date(page.updated_at as unknown as string);
  return { source: sourceId, content: markdown, hash: hashContent(markdown), tsMs: updatedAt.getTime() };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  repo: string;
  ref: string;
  /** When false (dry-run), everything runs except importFromContent writes
   *  and config hygiene. */
  apply: boolean;
  reportPath?: string;
}

export interface SlugRecord {
  slug: string;
  decision: string;
  winner: 'dent' | 'default' | 'git' | null;
  wrote: boolean;
  dent_hash: string | null;
  default_hash: string | null;
  git_hash: string | null;
  dent_ts: string | null;
  default_ts: string | null;
  git_ts: string | null;
  error?: string;
}

export interface ReconcileSummary {
  total_slugs: number;
  kept_dent: number;
  identical: number;
  wrote_from_git: number;
  wrote_from_default: number;
  would_write: number;
  writes: number;
  errors: number;
  config_repo_path_deleted: boolean;
  exporter_unlocked: boolean;
}

export async function reconcile(
  engine: BrainEngine,
  opts: ReconcileOptions,
): Promise<{ summary: ReconcileSummary; records: SlugRecord[] }> {
  // Verify the pinned ref resolves before doing anything.
  git(opts.repo, ['rev-parse', '--verify', `${opts.ref}^{commit}`]);

  // 1. Slug universe.
  const dentSlugs = (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [DENT_SOURCE_ID],
  )).map((r) => r.slug);
  const defaultSlugs = (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
  )).map((r) => r.slug);
  const gitSlugToPath = listGitSlugs(opts.repo, opts.ref);

  const universe = new Set<string>([...dentSlugs, ...defaultSlugs, ...gitSlugToPath.keys()]);

  const summary: ReconcileSummary = {
    total_slugs: universe.size,
    kept_dent: 0,
    identical: 0,
    wrote_from_git: 0,
    wrote_from_default: 0,
    would_write: 0,
    writes: 0,
    errors: 0,
    config_repo_path_deleted: false,
    exporter_unlocked: false,
  };
  const records: SlugRecord[] = [];

  if (opts.reportPath) writeFileSync(opts.reportPath, '');

  for (const slug of [...universe].sort()) {
    const record: SlugRecord = {
      slug, decision: '', winner: null, wrote: false,
      dent_hash: null, default_hash: null, git_hash: null,
      dent_ts: null, default_ts: null, git_ts: null,
    };
    try {
      const dent = await renderDbCandidate(engine, slug, DENT_SOURCE_ID as 'dent');
      const dflt = await renderDbCandidate(engine, slug, 'default');
      let gitCand: Candidate | null = null;
      const gitPath = gitSlugToPath.get(slug);
      if (gitPath) {
        gitCand = {
          source: 'git',
          content: gitFileContent(opts.repo, opts.ref, gitPath),
          hash: '',
          tsMs: gitFileTimestampMs(opts.repo, opts.ref, gitPath),
        };
        gitCand.hash = hashContent(gitCand.content);
      }

      record.dent_hash = dent?.hash ?? null;
      record.default_hash = dflt?.hash ?? null;
      record.git_hash = gitCand?.hash ?? null;
      record.dent_ts = dent ? new Date(dent.tsMs).toISOString() : null;
      record.default_ts = dflt ? new Date(dflt.tsMs).toISOString() : null;
      record.git_ts = gitCand ? new Date(gitCand.tsMs).toISOString() : null;

      const present = [gitCand, dent, dflt].filter((c): c is Candidate => c !== null);

      // All present copies hash-equal AND dent present → keep dent.
      if (dent && present.every((c) => c.hash === dent.hash)) {
        record.decision = present.length > 1 ? 'identical_keep_dent' : 'only_dent_keep';
        record.winner = 'dent';
        summary.kept_dent++;
        if (present.length > 1) summary.identical++;
        records.push(record);
        emitRecord(opts.reportPath, record);
        continue;
      }

      // Newest wins. Tie → git wins (historical source of truth), then dent.
      const preference: Record<Candidate['source'], number> = { git: 3, dent: 2, default: 1 };
      const winner = present.reduce((best, c) => {
        if (c.tsMs > best.tsMs) return c;
        if (c.tsMs === best.tsMs && preference[c.source] > preference[best.source]) return c;
        return best;
      });
      record.winner = winner.source;

      if (winner.source === 'dent') {
        record.decision = 'keep_dent_newest';
        summary.kept_dent++;
      } else if (dent && winner.hash === dent.hash) {
        record.decision = `${winner.source}_matches_dent_no_write`;
        summary.kept_dent++;
      } else {
        record.decision = `${winner.source}_wins`;
        if (opts.apply) {
          const imported = await importFromContent(engine, slug, winner.content, {
            sourceId: DENT_SOURCE_ID,
            noEmbed: true,
          });
          if (imported.status === 'error') {
            throw new Error(`importFromContent failed: ${imported.error ?? 'unknown'}`);
          }
          record.wrote = true;
          summary.writes++;
          if (winner.source === 'git') summary.wrote_from_git++;
          else summary.wrote_from_default++;
        } else {
          summary.would_write++;
        }
      }
    } catch (e) {
      record.decision = 'error';
      record.error = e instanceof Error ? e.message : String(e);
      summary.errors++;
    }
    records.push(record);
    emitRecord(opts.reportPath, record);
  }

  // Config hygiene (apply only): kill the laptop-path sync anchor so nothing
  // ever resolves the old git repo as a sync source again.
  if (opts.apply) {
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
    summary.config_repo_path_deleted = true;
    // Unlock the nightly exporter: until this key exists, exportTick refuses
    // to run (a pre-migration export would rewrite the mirror from a stale
    // page set and prune the pages this migration is about to reconcile).
    const { MIGRATED_KEY } = await import('../../src/dent/exporter/cron.ts');
    await engine.setConfig(MIGRATED_KEY, new Date().toISOString());
    summary.exporter_unlocked = true;
  }

  return { summary, records };
}

function emitRecord(reportPath: string | undefined, record: SlugRecord): void {
  if (!reportPath) return;
  appendFileSync(reportPath, JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Purge default-source rows
// ---------------------------------------------------------------------------

/**
 * Tables holding default-source page children, counted before the delete.
 * The actual delete relies on the schema's ON DELETE CASCADE from pages(id)
 * (content_chunks, links, tags, raw_data, timeline_entries, page_versions
 * all CASCADE; files.page_id and links.origin_page_id are SET NULL) — see
 * src/core/pglite-schema.ts / src/schema.sql. Alias tables key on source_id
 * directly and are deleted explicitly. If an engine-side FK addition ever
 * blocks the pages delete, the error is rethrown loudly with the table hint.
 */
const CHILD_COUNT_QUERIES: Array<{ table: string; sql: string }> = [
  { table: 'content_chunks', sql: `SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'links', sql: `SELECT COUNT(*)::int AS n FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id = 'default') OR to_page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'tags', sql: `SELECT COUNT(*)::int AS n FROM tags WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'raw_data', sql: `SELECT COUNT(*)::int AS n FROM raw_data WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'timeline_entries', sql: `SELECT COUNT(*)::int AS n FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'page_versions', sql: `SELECT COUNT(*)::int AS n FROM page_versions WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default')` },
  { table: 'slug_aliases', sql: `SELECT COUNT(*)::int AS n FROM slug_aliases WHERE source_id = 'default'` },
  { table: 'page_aliases', sql: `SELECT COUNT(*)::int AS n FROM page_aliases WHERE source_id = 'default'` },
  { table: 'pages', sql: `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'` },
];

export async function purgeDefault(
  engine: BrainEngine,
  opts: { apply: boolean },
): Promise<{ counts: Record<string, number>; deleted: boolean }> {
  const counts: Record<string, number> = {};
  for (const { table, sql } of CHILD_COUNT_QUERIES) {
    const rows = await engine.executeRaw<{ n: number }>(sql);
    counts[table] = Number(rows[0]?.n ?? 0);
  }

  if (!opts.apply) return { counts, deleted: false };

  try {
    // Alias tables first (no FK to pages, keyed by source_id).
    await engine.executeRaw(`DELETE FROM slug_aliases WHERE source_id = 'default'`);
    await engine.executeRaw(`DELETE FROM page_aliases WHERE source_id = 'default'`);
    // Pages last — CASCADE removes content_chunks/links/tags/raw_data/
    // timeline_entries/page_versions; files.page_id + links.origin_page_id
    // are SET NULL.
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default'`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `purge-default failed mid-delete: ${msg}\n` +
      `An FK is blocking the pages delete that this script does not know about. ` +
      `Inspect the constraint named in the error against src/core/pglite-schema.ts / src/schema.sql, ` +
      `delete those child rows manually, then re-run --purge-default.`,
    );
  }
  return { counts, deleted: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  repo?: string;
  ref?: string;
  apply: boolean;
  purgeDefault: boolean;
  yes: boolean;
  report?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false, purgeDefault: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--repo': args.repo = argv[++i]; break;
      case '--repo-ref': args.ref = argv[++i]; break;
      case '--report': args.report = argv[++i]; break;
      case '--apply': args.apply = true; break;
      case '--dry-run': args.apply = false; break;
      case '--purge-default': args.purgeDefault = true; break;
      case '--yes': args.yes = true; break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is required.');
    console.error('Hint: railway variables --kv | grep DATABASE_URL');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));

  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL, poolSize: 2 });

  try {
    if (args.purgeDefault) {
      if (!args.yes) {
        const { counts } = await purgeDefault(engine, { apply: false });
        console.log('purge-default PREVIEW (no --yes). Rows that would be deleted:');
        for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(18)} ${n}`);
        console.log('\nRe-run with --purge-default --yes to delete.');
        return;
      }
      const { counts } = await purgeDefault(engine, { apply: true });
      console.log('purge-default DONE. Rows deleted (counted pre-delete):');
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(18)} ${n}`);
      return;
    }

    if (!args.repo || !args.ref) {
      console.error('FATAL: --repo <path> and --repo-ref <commit> are required.');
      console.error('Pin --repo-ref to the data-repo commit from BEFORE the v0.45 deploy — do NOT use current HEAD.');
      process.exit(2);
    }

    const mode = args.apply ? 'APPLY' : 'DRY-RUN';
    console.log(`v0.45 single-brain reconciliation [${mode}]`);
    console.log(`  repo: ${args.repo} @ ${args.ref}`);
    const { summary } = await reconcile(engine, {
      repo: args.repo,
      ref: args.ref,
      apply: args.apply,
      reportPath: args.report,
    });

    console.log('\nSummary:');
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(26)} ${v}`);
    if (args.report) console.log(`\nPer-slug report: ${args.report}`);
    if (summary.errors > 0) {
      console.error(`\n${summary.errors} slug(s) errored — inspect the report before proceeding.`);
      process.exitCode = 1;
    }
    if (args.apply) {
      console.log('\nNEXT: re-embed the migrated pages (writes here were noEmbed):');
      console.log('  railway run ... embed --stale   # or the equivalent on your deployment');
      console.log('Then, after verifying spot-checks, purge the default-source rows:');
      console.log('  bun run scripts/dent/migrate-v0.45-single-brain.ts --purge-default --yes');
    } else {
      console.log('\nDry-run only — re-run with --apply to write.');
    }
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) {
  await main();
}
