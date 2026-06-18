#!/usr/bin/env bun
/**
 * ingest-media-pointers.ts — Lane B: make the Dropbox media/asset corpus findable
 * WITHOUT downloading or storing any binary.
 *
 * The catalog's pointer_media (images/audio/video/design) + pointer_opaque
 * (zip/fmp12/fonts) lanes — ~7,100 assets, ~196 GB — never enter the brain as
 * content. Instead we index WHAT EXISTS and WHERE: one "media index" page per
 * containing folder (785 of them vs 7,100 individual stubs), listing every file
 * with type/size/date. Exact-filename lookup still works (names are in the table);
 * folder context ("Dent 2025 event photos") gives semantic recall too.
 *
 * Built entirely from manifest.jsonl metadata — NO file reads, NO downloads.
 * Writes staged pages to staged-media/; import + embed like the other lanes.
 *
 * Usage: bun scripts/dent/ingest-media-pointers.ts [--manifest <jsonl>] [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = join(homedir(), '.dent-brain', 'big-ingest');
const MANIFEST = opt('manifest', join(BASE, 'manifest.jsonl'))!;
const OUT = opt('out', join(BASE, 'staged-media'))!;

const SLUG_PREFIX = 'archives/dropbox';
const slugifySeg = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const slugForFolder = (rel: string) => SLUG_PREFIX + '/' + rel.split('/').map(slugifySeg).filter(Boolean).join('/');
const fmtSize = (b: number) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB';

interface Row { relPath: string; area: string; ext: string; bytes: number; mtime: string; lane: string }

const rows: Row[] = readFileSync(MANIFEST, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r: Row) => r.lane === 'pointer_media' || r.lane === 'pointer_opaque');

// group by containing folder
const byFolder = new Map<string, Row[]>();
for (const r of rows) {
  const folder = dirname(r.relPath);
  (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(r);
}
console.error(`${rows.length} assets across ${byFolder.size} folders → ${OUT}`);
mkdirSync(OUT, { recursive: true });
const log = join(BASE, 'staged-media.jsonl');
writeFileSync(log, '');

let made = 0;
const seen = new Set<string>();
for (const [folder, files] of byFolder) {
  files.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const area = files[0].area;
  const latest = files.reduce((m, f) => (f.mtime > m ? f.mtime : m), files[0].mtime);
  // type breakdown
  const types = new Map<string, number>();
  for (const f of files) types.set(f.ext, (types.get(f.ext) || 0) + 1);
  const typeStr = [...types.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(', ');

  const table = ['| File | Type | Size | Date |', '|---|---|--:|---|',
    ...files.map((f) => `| ${basename(f.relPath).replace(/\|/g, '\\|')} | ${f.ext} | ${fmtSize(f.bytes)} | ${f.mtime} |`)].join('\n');

  const title = `Media — ${basename(folder) || folder}`;
  const body = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'source: dropbox',
    'kind: media-index',
    `dropbox_folder: ${JSON.stringify(folder)}`,
    `jd_area: ${JSON.stringify(area)}`,
    `asset_count: ${files.length}`,
    `total_bytes: ${totalBytes}`,
    `file_date: ${latest}`,
    '---',
    '',
    `[Source: dropbox/${folder}/]`,
    '',
    `**Media index** — ${files.length} asset${files.length === 1 ? '' : 's'} (${fmtSize(totalBytes)}) in this Dropbox folder. The binaries are NOT stored in the brain; they live in Dropbox at the path above. This page indexes what exists and where so the assets are findable by name and folder.`,
    '',
    `**Types:** ${typeStr}`,
    '',
    table,
    '',
  ].join('\n');

  let slug = slugForFolder(folder) + '/_assets';
  if (seen.has(slug)) { let n = 2; while (seen.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  seen.add(slug);
  const outPath = join(OUT, slug + '.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);
  appendFileSync(log, JSON.stringify({ folder, slug, assets: files.length, bytes: totalBytes }) + '\n');
  made++;
}
console.error(`Done. media-index pages=${made}. Staged to ${OUT}`);
console.error(`Import: railway run -- gbrain import ${OUT} --source-id dent --no-embed`);
