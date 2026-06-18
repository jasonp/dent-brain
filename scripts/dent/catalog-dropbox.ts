#!/usr/bin/env bun
/**
 * catalog-dropbox.ts — "the big ingest" discovery pass.
 *
 * Walks the Dropbox DENT corpus, classifies every file into an ingest lane,
 * and emits:
 *   - manifest.jsonl   one row per file: {path, relPath, area, ext, bytes, mtime, lane, reason}
 *   - report.md        human-readable summary (per-extension, per-area, skip-dirs)
 *   - summary.json     machine totals for the planning step
 *
 * Read-only. Touches nothing in the brain and nothing in Dropbox.
 *
 * Lanes:
 *   ingest_text     document whose TEXT belongs in the brain (convert → markdown → importFromContent)
 *   ingest_tabular  structured data (csv/xlsx) → markdown table or CSV text
 *   pointer_media   asset (image/audio/video/design) → stub page w/ Dropbox path; images optionally multimodal
 *   pointer_opaque  large/opaque binary (zip/fmp12/indd) → pointer page only, never parsed
 *   skip_noise      OS cruft, contacts archive, bookmarks, caches
 *   skip_software   vendored code trees (WordPress/woocommerce/CRM) — software, not Dent content
 *
 * Usage:
 *   bun scripts/dent/catalog-dropbox.ts [SOURCE_DIR] [OUT_DIR]
 * Defaults:
 *   SOURCE_DIR = /Users/jasonpreston/Library/CloudStorage/Dropbox/A00 Dent/DENT
 *   OUT_DIR    = ~/.dent-brain/big-ingest
 */

import { readdirSync, statSync, mkdirSync, writeSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { homedir } from 'node:os';

const SOURCE =
  process.argv[2] ||
  '/Users/jasonpreston/Library/CloudStorage/Dropbox/A00 Dent/DENT';
const OUT = process.argv[3] || join(homedir(), '.dent-brain', 'big-ingest');

type Lane =
  | 'ingest_text'
  | 'ingest_tabular'
  | 'pointer_media'
  | 'pointer_opaque'
  | 'skip_noise'
  | 'skip_software';

// --- Extension → lane -------------------------------------------------------
const EXT_LANE: Record<string, Lane> = {
  // documents whose text we want in the brain
  pdf: 'ingest_text', docx: 'ingest_text', doc: 'ingest_text',
  txt: 'ingest_text', md: 'ingest_text', markdown: 'ingest_text',
  rtf: 'ingest_text', rtfd: 'ingest_text', odt: 'ingest_text',
  pptx: 'ingest_text', ppt: 'ingest_text', key: 'ingest_text',
  pages: 'ingest_text', html: 'ingest_text', htm: 'ingest_text',
  webloc: 'ingest_text', // bookmark → URL pointer line
  // structured data
  csv: 'ingest_tabular', tsv: 'ingest_tabular',
  xlsx: 'ingest_tabular', xls: 'ingest_tabular', numbers: 'ingest_tabular',
  // media → pointer (images may later be multimodal-embedded)
  jpg: 'pointer_media', jpeg: 'pointer_media', png: 'pointer_media',
  gif: 'pointer_media', webp: 'pointer_media', bmp: 'pointer_media',
  tif: 'pointer_media', tiff: 'pointer_media', heic: 'pointer_media',
  dng: 'pointer_media', cr2: 'pointer_media', raw: 'pointer_media',
  svg: 'pointer_media', psd: 'pointer_media', ai: 'pointer_media',
  eps: 'pointer_media', indd: 'pointer_opaque', sketch: 'pointer_opaque',
  mp4: 'pointer_media', mov: 'pointer_media', m4v: 'pointer_media',
  avi: 'pointer_media', mkv: 'pointer_media',
  mp3: 'pointer_media', wav: 'pointer_media', m4a: 'pointer_media',
  aiff: 'pointer_media', aif: 'pointer_media', flac: 'pointer_media',
  // opaque / large binaries → pointer only
  zip: 'pointer_opaque', gz: 'pointer_opaque', tar: 'pointer_opaque',
  dmg: 'pointer_opaque', fmp12: 'pointer_opaque', fp7: 'pointer_opaque',
  otf: 'pointer_opaque', ttf: 'pointer_opaque', woff: 'pointer_opaque',
  // software artifacts — never content
  pyc: 'skip_software', pyo: 'skip_software', py: 'skip_software',
  php: 'skip_software', js: 'skip_software', css: 'skip_software',
  scss: 'skip_software', less: 'skip_software', map: 'skip_software',
  json: 'skip_software', lock: 'skip_software', so: 'skip_software',
  o: 'skip_software', class: 'skip_software', jar: 'skip_software',
  mo: 'skip_software', po: 'skip_software', pot: 'skip_software',
  // address-book / OS cruft
  abcdp: 'skip_noise', abcdg: 'skip_noise', abcdmr: 'skip_noise',
};

// Directory substrings that are skipped wholesale (relative path match).
// Software installs + the contacts archive: thousands of files, zero Dent prose.
const SKIP_DIR_PATTERNS: { pattern: string; lane: Lane; why: string }[] = [
  { pattern: 'A55 Claude CRM', lane: 'skip_software', why: 'CRM app source tree' },
  { pattern: 'Web Site/woocommerce', lane: 'skip_software', why: 'WooCommerce plugin source' },
  { pattern: 'Web Site/WordPress Purchased', lane: 'skip_software', why: 'purchased WP themes/plugins' },
  { pattern: 'Web Site/Genesis', lane: 'skip_software', why: 'WP Genesis framework' },
  { pattern: 'node_modules', lane: 'skip_software', why: 'node deps' },
  { pattern: '.git/', lane: 'skip_noise', why: 'git internals' },
];

// exact basenames that are always noise
const NOISE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', 'Icon\r', '.localized', '.gitignore',
]);

function classify(relPath: string, ext: string, bytes: number, base: string): { lane: Lane; reason: string } {
  if (NOISE_NAMES.has(base) || base.startsWith('._')) return { lane: 'skip_noise', reason: 'os-cruft' };
  for (const d of SKIP_DIR_PATTERNS) {
    if (relPath.includes(d.pattern)) return { lane: d.lane, reason: d.why };
  }
  const lane = EXT_LANE[ext];
  if (lane) {
    // Tiny "text" files (< 8 bytes) are usually empty placeholders.
    if (lane === 'ingest_text' && bytes < 8) return { lane: 'skip_noise', reason: 'empty-text-file' };
    return { lane, reason: `ext:${ext || '(none)'}` };
  }
  if (!ext) return { lane: 'skip_noise', reason: 'no-extension' };
  return { lane: 'pointer_opaque', reason: `unknown-ext:${ext}` };
}

// Johnny Decimal area = first path component (e.g. "A30 - A39 Conference 2013-2022").
function areaOf(relPath: string): string {
  const top = relPath.split(sep)[0];
  return top || '(root)';
}

// --- Walk -------------------------------------------------------------------
interface Row { relPath: string; area: string; ext: string; bytes: number; mtime: string; lane: Lane; reason: string; local: boolean }

const rows: Row[] = [];
let walked = 0;
function walk(dir: string) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { walk(full); continue; }
    if (!st.isFile()) continue;
    walked++;
    const relPath = relative(SOURCE, full);
    const ext = extname(name).slice(1).toLowerCase();
    const { lane, reason } = classify(relPath, ext, st.size, name);
    // Dropbox/iCloud online-only ("dataless") files report full size but have
    // zero blocks allocated on disk. stat does NOT trigger a download; reading
    // the bytes would. local === false means "not on disk — would download".
    const local = st.size === 0 || st.blocks > 0;
    rows.push({
      relPath, area: areaOf(relPath), ext: ext || '(none)',
      bytes: st.size, mtime: st.mtime.toISOString().slice(0, 10), lane, reason, local,
    });
  }
}

console.error(`Crawling ${SOURCE} ...`);
walk(SOURCE);
console.error(`Walked ${walked} files. Writing catalog to ${OUT} ...`);
mkdirSync(OUT, { recursive: true });

// --- manifest.jsonl ---------------------------------------------------------
const fd = openSync(join(OUT, 'manifest.jsonl'), 'w');
for (const r of rows) writeSync(fd, JSON.stringify(r) + '\n');
closeSync(fd);

// --- aggregations -----------------------------------------------------------
const fmtMB = (b: number) => (b / 1048576).toFixed(1) + ' MB';
const fmtGB = (b: number) => (b / 1073741824).toFixed(2) + ' GB';

const byLane: Record<string, { count: number; bytes: number; localCount: number; localBytes: number; onlineCount: number; onlineBytes: number }> = {};
const byExt: Record<string, { count: number; bytes: number; lane: Lane }> = {};
const byArea: Record<string, Record<string, number>> = {};
const areaBytes: Record<string, number> = {};

for (const r of rows) {
  const bl = (byLane[r.lane] ??= { count: 0, bytes: 0, localCount: 0, localBytes: 0, onlineCount: 0, onlineBytes: 0 });
  bl.count++; bl.bytes += r.bytes;
  if (r.local) { bl.localCount++; bl.localBytes += r.bytes; } else { bl.onlineCount++; bl.onlineBytes += r.bytes; }
  const e = (byExt[r.ext] ??= { count: 0, bytes: 0, lane: r.lane });
  e.count++; e.bytes += r.bytes;
  (byArea[r.area] ??= {})[r.lane] = ((byArea[r.area] ??= {})[r.lane] || 0) + 1;
  areaBytes[r.area] = (areaBytes[r.area] || 0) + r.bytes;
}

// --- report.md --------------------------------------------------------------
const L = (s = '') => s;
const lines: string[] = [];
lines.push(`# Dent Dropbox catalog — big-ingest discovery`);
lines.push('');
lines.push(`Source: \`${SOURCE}\``);
lines.push(`Files: **${walked.toLocaleString()}**  ·  Size: **${fmtGB(rows.reduce((a, r) => a + r.bytes, 0))}**`);
lines.push('');
lines.push(`## By lane`);
lines.push('');
lines.push(`| Lane | Files | Size | Disposition |`);
lines.push(`|---|--:|--:|---|`);
const laneDisp: Record<Lane, string> = {
  ingest_text: 'Convert → markdown → ingest (full text)',
  ingest_tabular: 'Convert table → markdown/CSV → ingest',
  pointer_media: 'Stub page + Dropbox path; images optional multimodal',
  pointer_opaque: 'Stub page + Dropbox path only (never parsed)',
  skip_noise: 'Skip entirely',
  skip_software: 'Skip entirely (vendored code)',
};
for (const lane of Object.keys(laneDisp) as Lane[]) {
  const v = byLane[lane]; if (!v) continue;
  lines.push(`| \`${lane}\` | ${v.count.toLocaleString()} | ${fmtMB(v.bytes)} | ${laneDisp[lane]} |`);
}
lines.push('');
lines.push(`## Local availability (Dropbox online-only vs on-disk)`);
lines.push('');
lines.push(`Online-only files would be **downloaded the moment they are read**. \`stat\` (used by this catalog) does not trigger a download. Pointer/skip lanes only need metadata, so they never download. The download cost of the ingest is only the on-demand reads of the two \`ingest_*\` lanes.`);
lines.push('');
lines.push(`| Lane | On disk | Online-only (would download) | Download size if ingested |`);
lines.push(`|---|--:|--:|--:|`);
for (const lane of Object.keys(laneDisp) as Lane[]) {
  const v = byLane[lane]; if (!v) continue;
  const dl = lane.startsWith('ingest') ? fmtMB(v.onlineBytes) : '— (metadata only)';
  lines.push(`| \`${lane}\` | ${v.localCount.toLocaleString()} (${fmtMB(v.localBytes)}) | ${v.onlineCount.toLocaleString()} (${fmtMB(v.onlineBytes)}) | ${dl} |`);
}
const ingestOnline = (byLane['ingest_text']?.onlineBytes || 0) + (byLane['ingest_tabular']?.onlineBytes || 0);
const ingestLocal = (byLane['ingest_text']?.localBytes || 0) + (byLane['ingest_tabular']?.localBytes || 0);
lines.push('');
lines.push(`**Bottom line:** ingest lanes total **${fmtGB((byLane['ingest_text']?.bytes || 0) + (byLane['ingest_tabular']?.bytes || 0))}** — of which **${fmtGB(ingestLocal)}** is already on disk and **${fmtGB(ingestOnline)}** is online-only. The 191 GB media + 5 GB opaque lanes are pointer-only and download **nothing**. With a materialize→extract→evict loop, peak extra disk stays in the MBs regardless.`);
lines.push('');
lines.push(`## By extension (top 40)`);
lines.push('');
lines.push(`| Ext | Lane | Files | Size |`);
lines.push(`|---|---|--:|--:|`);
for (const [ext, v] of Object.entries(byExt).sort((a, b) => b[1].count - a[1].count).slice(0, 40)) {
  lines.push(`| ${ext} | \`${v.lane}\` | ${v.count.toLocaleString()} | ${fmtMB(v.bytes)} |`);
}
lines.push('');
lines.push(`## By Johnny Decimal area`);
lines.push('');
lines.push(`| Area | Size | ingest_text | ingest_tabular | pointer_media | pointer_opaque | skip |`);
lines.push(`|---|--:|--:|--:|--:|--:|--:|`);
for (const [area, lanes] of Object.entries(byArea).sort((a, b) => (areaBytes[b[0]] || 0) - (areaBytes[a[0]] || 0))) {
  const g = (k: string) => (lanes[k] || 0).toLocaleString();
  const skip = (lanes['skip_noise'] || 0) + (lanes['skip_software'] || 0);
  lines.push(`| ${area} | ${fmtMB(areaBytes[area] || 0)} | ${g('ingest_text')} | ${g('ingest_tabular')} | ${g('pointer_media')} | ${g('pointer_opaque')} | ${skip.toLocaleString()} |`);
}
lines.push('');
lines.push(`## Ingestable text files by size band`);
lines.push('');
const textRows = rows.filter(r => r.lane === 'ingest_text');
const bands = [[0, 50e3, '< 50 KB'], [50e3, 500e3, '50 KB–500 KB'], [500e3, 5e6, '500 KB–5 MB'], [5e6, Infinity, '> 5 MB']] as const;
lines.push(`| Band | Files |`);
lines.push(`|---|--:|`);
for (const [lo, hi, label] of bands) {
  lines.push(`| ${label} | ${textRows.filter(r => r.bytes >= lo && r.bytes < hi).length.toLocaleString()} |`);
}
writeFileSync(join(OUT, 'report.md'), lines.join('\n') + '\n');

// --- summary.json -----------------------------------------------------------
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
  source: SOURCE, files: walked, totalBytes: rows.reduce((a, r) => a + r.bytes, 0),
  byLane, ingestTextCount: textRows.length,
}, null, 2));

console.error(`Done. ${rows.length} rows.`);
console.error(`  ${OUT}/manifest.jsonl  (one row per file)`);
console.error(`  ${OUT}/report.md       (human summary)`);
console.error(`  ${OUT}/summary.json`);
