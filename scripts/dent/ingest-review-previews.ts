#!/usr/bin/env bun
/**
 * ingest-review-previews.ts — resolve the review-log quarantine into the brain.
 *
 * The main stager (ingest-dropbox.ts) quarantines two kinds of file to
 * review-<tag>.jsonl rather than ingesting them whole:
 *   - oversized (>800K chars): big CSV/XLSX/XLS/TXT/PDF. Dumping the full file
 *     as one page is high embedding cost / low recall value.
 *   - markup_dump: RTF whose source markup couldn't be cleaned to prose.
 *
 * Decision (locked): large tabular/text → **pointer + preview snippet** — a small,
 * findable page carrying provenance + headers + first rows + row/byte counts, so
 * the file is recallable by what it contains without bloating embeddings. RTF
 * markup-dumps → pointer-only stub (no usable content to preview).
 *
 * Writes staged preview pages to staged-review/ (same archives/dropbox/ slug tree);
 * import + embed exactly like the main pipeline. Writes nothing to the brain itself.
 *
 * Usage: bun scripts/dent/ingest-review-previews.ts [--review <jsonl>] [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = join(homedir(), '.dent-brain', 'big-ingest');
const REVIEW = opt('review', join(BASE, 'review-all.jsonl'))!;
const OUT = opt('out', join(BASE, 'staged-review'))!;
const MARKITDOWN = opt('markitdown', join(BASE, 'venv', 'bin', 'markitdown'))!;
const SRC = JSON.parse(readFileSync(join(BASE, 'summary.json'), 'utf8')).source as string;

const SLUG_PREFIX = 'archives/dropbox';
const stripControlChars = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const slugifySeg = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const slugForPath = (rel: string) => SLUG_PREFIX + '/' + rel.replace(/\.[^./]+$/, '').split('/').map(slugifySeg).filter(Boolean).join('/');

const PREVIEW_ROWS = 20;       // CSV/spreadsheet sample rows
const PREVIEW_SHEET_LINES = 60; // markitdown-table lines for spreadsheets
const PREVIEW_TXT_CHARS = 3000;
const PREVIEW_PDF_CHARS = 4000;

function markitdown(abs: string): string {
  try { return stripControlChars(execFileSync(MARKITDOWN, [abs], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })); }
  catch { return ''; }
}

// Returns { body, kind } or null to skip.
function buildPreview(abs: string, ext: string, reason: string, bytes: number): { body: string; kind: string } | null {
  if (ext === 'csv' || ext === 'tsv') {
    const sep = ext === 'tsv' ? '\t' : ',';
    const text = stripControlChars(readFileSync(abs, 'utf8'));
    const lines = text.split(/\r?\n/);
    const cols = (lines[0] || '').split(sep).length;
    const dataRows = lines.filter((l) => l.trim()).length - 1;
    const sample = lines.slice(0, PREVIEW_ROWS + 1).join('\n');
    return { kind: 'tabular', body: `**Tabular preview** — ${dataRows.toLocaleString()} data rows × ${cols} columns. The full file lives in Dropbox (see source path); only the header + first ${PREVIEW_ROWS} rows are indexed here.\n\n\`\`\`${ext}\n${sample}\n\`\`\`\n` };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const md = markitdown(abs);
    if (!md.trim()) return { kind: 'pointer', body: `**Spreadsheet — preview unavailable.** Could not extract a clean preview; the full file lives in Dropbox (see source path). ~${(bytes / 1024).toFixed(0)} KB.\n` };
    const lines = md.split('\n');
    const preview = lines.slice(0, PREVIEW_SHEET_LINES).join('\n');
    const more = lines.length > PREVIEW_SHEET_LINES ? `\n\n…[preview truncated — full spreadsheet is ~${(bytes / 1024).toFixed(0)} KB in Dropbox]` : '';
    return { kind: 'tabular', body: `**Spreadsheet preview** (first rows only; full file in Dropbox).\n\n${preview}${more}\n` };
  }
  if (ext === 'txt') {
    const text = stripControlChars(readFileSync(abs, 'utf8'));
    return { kind: 'text', body: `**Large text file preview** — ${text.length.toLocaleString()} chars total. Full file in Dropbox; first ${PREVIEW_TXT_CHARS} chars indexed here.\n\n${text.slice(0, PREVIEW_TXT_CHARS)}\n\n…[truncated]\n` };
  }
  if (ext === 'pdf') {
    const md = markitdown(abs);
    if (!md.trim()) return { kind: 'pointer', body: `**Large PDF — preview unavailable.** Full file in Dropbox. ~${(bytes / 1024 / 1024).toFixed(1)} MB.\n` };
    return { kind: 'text', body: `**Large PDF preview** (first ${PREVIEW_PDF_CHARS} chars; full document in Dropbox).\n\n${md.slice(0, PREVIEW_PDF_CHARS)}\n\n…[truncated]\n` };
  }
  if (reason === 'markup_dump') {
    // RTF (or xlsx) markup that wouldn't clean up. Pointer-only stub.
    return { kind: 'pointer', body: `**Pointer only.** This file's content could not be extracted cleanly (markup dump). The original lives in Dropbox at the source path below. ~${(bytes / 1024).toFixed(0)} KB.\n` };
  }
  return null;
}

function frontmatter(r: any, title: string, kind: string): string {
  return ['---', `title: ${JSON.stringify(title)}`, 'source: dropbox', 'preview: true', `preview_kind: ${kind}`,
    `dropbox_path: ${JSON.stringify(r.relPath)}`, `original_type: ${r.ext}`, `full_bytes: ${r.bytes}`,
    `file_date: ${r.mtime}`, `jd_area: ${JSON.stringify(r.area)}`, '---', '', `[Source: dropbox/${r.relPath}]`, ''].join('\n');
}

// --- run --------------------------------------------------------------------
const rows = readFileSync(REVIEW, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.error(`Review entries: ${rows.length}. Building previews → ${OUT}`);
mkdirSync(OUT, { recursive: true });
const log = join(BASE, 'staged-review.jsonl');
writeFileSync(log, '');

let made = 0, skipped = 0;
const seen = new Set<string>();
for (const r of rows) {
  const abs = join(SRC, r.relPath);
  let res: { body: string; kind: string } | null = null;
  try { res = buildPreview(abs, r.ext, r.reviewReason, r.bytes); }
  catch (e: any) { process.stderr.write(`  skip ${r.relPath.slice(-50)}: ${String(e?.message || e).slice(0, 60)}\n`); }
  if (!res) { skipped++; continue; }
  const title = basename(r.relPath, extname(r.relPath));
  let slug = slugForPath(r.relPath);
  if (seen.has(slug)) { let n = 2; while (seen.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  seen.add(slug);
  const outPath = join(OUT, slug + '.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, frontmatter(r, title, res.kind) + res.body.trim() + '\n');
  appendFileSync(log, JSON.stringify({ relPath: r.relPath, slug, kind: res.kind, ext: r.ext }) + '\n');
  made++; process.stderr.write(`  [${made}] ${res.kind.padEnd(8)} ${slug.slice(-60)}\n`);
}
console.error(`\nDone. previews=${made} skipped=${skipped}. Staged to ${OUT}`);
console.error(`Import: railway run -- gbrain import ${OUT} --source-id dent --no-embed`);
