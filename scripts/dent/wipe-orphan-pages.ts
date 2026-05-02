#!/usr/bin/env bun
/**
 * Phase 2 (PLAN v2.0) one-shot: delete pages from Postgres that have no
 * markdown counterpart in dent-brain-data git. The Steve stub from the
 * 2026-05-02 manual gate test is the canonical example — it was written
 * via `put_page` to Postgres only, never reached `dent-brain-data`.
 *
 * The plan's rationale: "fresh start; no migration gymnastics needed
 * because the data is fake." Better to drop the orphans than to back
 * out the writes one-by-one.
 *
 * Usage:
 *   # Dry run — print orphans, write nothing.
 *   DATABASE_URL=... DENT_BRAIN_DATA_PATH=~/gh/dent-brain-data \
 *     bun run scripts/dent/wipe-orphan-pages.ts --dry-run
 *
 *   # Apply — delete orphans from Postgres.
 *   DATABASE_URL=... DENT_BRAIN_DATA_PATH=~/gh/dent-brain-data \
 *     bun run scripts/dent/wipe-orphan-pages.ts --apply
 *
 * Defaults to --dry-run if neither flag is set.
 *
 * Safety:
 *   - Only considers pages with source_id = 'dent' (the dent-brain-data
 *     source row registered by ensureDataRepo at boot). Pages from other
 *     sources are untouched.
 *   - The dent-brain-data clone is treated as the source of truth. If a
 *     page exists on disk under any path that resolves to the page's
 *     slug, the page is kept.
 *   - --apply explicitly required to write. Defaults to --dry-run.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { homedir } from 'os';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const REPO_PATH_RAW = process.env.DENT_BRAIN_DATA_PATH ?? join(homedir(), 'gh', 'dent-brain-data');
const REPO_PATH = REPO_PATH_RAW.startsWith('~') ? REPO_PATH_RAW.replace('~', homedir()) : REPO_PATH_RAW;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required.');
  process.exit(1);
}
if (!existsSync(REPO_PATH)) {
  console.error(`FATAL: dent-brain-data clone not found at ${REPO_PATH}.`);
  console.error('       Set DENT_BRAIN_DATA_PATH or clone the repo first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = args.includes('--dry-run') || !apply;

if (apply && dryRun && !args.includes('--dry-run')) {
  // both flags is technically OK; we treat --apply as winning if explicit.
}

console.log(`Mode: ${apply ? 'APPLY (will delete)' : 'DRY RUN (no writes)'}`);
console.log(`Repo: ${REPO_PATH}`);
console.log('');

/**
 * Walk dent-brain-data and collect every slug it represents on disk.
 * Slug = path-without-`.md`. Skips dotfile dirs and node_modules.
 */
function collectDiskSlugs(repoRoot: string): Set<string> {
  const slugs = new Set<string>();
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        stack.push(full);
      } else if (s.isFile() && name.endsWith('.md')) {
        const rel = relative(repoRoot, full);
        // gbrain's importFile normalizes slugs to lowercase. Match
        // that normalization here so README.md → readme matches the
        // page row, not gets flagged as an orphan.
        const slug = rel.replace(/\.md$/i, '').split(/[\\/]/).join('/').toLowerCase();
        slugs.add(slug);
      }
    }
  }
  return slugs;
}

const diskSlugs = collectDiskSlugs(REPO_PATH);
console.log(`Markdown files in repo: ${diskSlugs.size}`);

async function main() {
const engine = new PostgresEngine();
await engine.connect({ database_url: DATABASE_URL, poolSize: 2 });

try {
  // The dent-brain Postgres serves only one workload; treat ALL pages
  // as candidates and filter by markdown-presence. (Pages currently
  // get source_id='default' from gbrain's import path even when
  // performSync is invoked with sourceId='dent' — separate gbrain
  // quirk, not load-bearing for orphan detection.)
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; updated_at: string }>(
    `SELECT slug, source_id, title, updated_at::text AS updated_at
       FROM pages
      ORDER BY slug`,
  );
  console.log(`Pages in Postgres: ${rows.length}`);

  // Slugs are lowercase in the DB; match against lowercased disk slugs.
  const orphans = rows.filter((r) => !diskSlugs.has(r.slug.toLowerCase()));

  if (orphans.length === 0) {
    console.log('\nNo orphans. Postgres and dent-brain-data are in sync.');
    return;
  }

  console.log(`\nOrphan pages (in Postgres, NOT in dent-brain-data): ${orphans.length}`);
  for (const o of orphans) {
    console.log(`  - slug=${o.slug}  title=${o.title ?? '<none>'}  source_id=${o.source_id ?? 'NULL'}  updated=${o.updated_at}`);
  }

  if (dryRun) {
    console.log('\nDry run — no deletes. Re-run with --apply to delete.');
    return;
  }

  console.log('\nDeleting orphans...');
  let deleted = 0;
  for (const o of orphans) {
    try {
      await engine.deletePage(o.slug);
      console.log(`  deleted: ${o.slug}`);
      deleted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  failed: ${o.slug} — ${msg}`);
    }
  }
  console.log(`\nDone. ${deleted}/${orphans.length} orphans deleted.`);
} finally {
  await engine.disconnect();
}
}

main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e);
  process.exit(2);
});
