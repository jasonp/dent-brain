#!/usr/bin/env bun
/**
 * ingest-dropbox.ts — Phase 0 STAGING pass for "the big ingest".
 *
 * Reads the catalog manifest, converts the ingest lanes (text + tabular) of ONE
 * Johnny-Decimal area to markdown, and writes staged `.md` files to disk.
 *
 *   *** This script writes NOTHING to the brain. *** It only stages markdown so
 *   the conversion quality can be reviewed before Phase 1 wires importFromContent.
 *
 * Reading a Dropbox online-only file downloads it (that is intended and approved).
 * Safety rails so a bug can't pull all 200 GB:
 *   - only rows whose lane is `ingest_text` / `ingest_tabular` are ever read;
 *   - every run is scoped to a required --area;
 *   - cumulative materialized bytes are capped by --max-download (hard abort).
 *
 * Usage:
 *   bun scripts/dent/ingest-dropbox.ts --area "A20 - A29 Passport" [opts]
 * Options:
 *   --area <substr>     REQUIRED. Matches the manifest `area` field (first path segment).
 *   --manifest <path>   default ~/.dent-brain/big-ingest/manifest.jsonl
 *   --src <dir>         default = source recorded in summary.json
 *   --out <dir>         default ~/.dent-brain/big-ingest/staged
 *   --markitdown <bin>  default ~/.dent-brain/big-ingest/venv/bin/markitdown
 *   --max-download <GB> default 8  (hard ceiling on bytes read this run)
 *   --limit <N>         stop after N ingest rows (smoke testing)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BASE = join(homedir(), '.dent-brain', 'big-ingest');
const AREA = opt('area');
const ALL = argv.includes('--all'); // process every area's ingest lanes in one pass
const MANIFEST = opt('manifest', join(BASE, 'manifest.jsonl'))!;
const OUT = opt('out', join(BASE, 'staged'))!;
const MARKITDOWN = opt('markitdown', join(BASE, 'venv', 'bin', 'markitdown'))!;
const MAX_DOWNLOAD_BYTES = parseFloat(opt('max-download', '8')!) * 1073741824;
const LIMIT = parseInt(opt('limit', '0')!, 10);

if (!AREA && !ALL) { console.error('ERROR: pass --area "<JD area>" or --all'); process.exit(2); }
if (!existsSync(MARKITDOWN)) { console.error(`ERROR: markitdown not found at ${MARKITDOWN}`); process.exit(2); }

const SRC = (() => {
  const s = opt('src');
  if (s) return s;
  try { return JSON.parse(readFileSync(join(BASE, 'summary.json'), 'utf8')).source as string; }
  catch { console.error('ERROR: --src not given and summary.json unreadable'); process.exit(2); }
})()!;

// --- handler routing --------------------------------------------------------
// iWork + scanned-PDF policy (locked): key/pages → pointer; empty extraction → pointer.
const POINTER_EXTS = new Set(['key', 'pages', 'numbers']);
const PASSTHROUGH_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv']);
const MARKITDOWN_EXTS = new Set(['pdf', 'docx', 'doc', 'rtf', 'odt', 'pptx', 'ppt', 'xlsx', 'xls', 'html', 'htm']);
const MIN_CHARS = 50; // below this, treat as failed/scanned → pointer
const MAX_CHARS = 800_000; // above this, flag for review (likely bad extraction, not prose)

// Count RTF/markup control tokens. Clean prose has ~0; a dumped RTF source has thousands.
const controlTokens = (t: string) => (t.match(/\\[a-z]+\b/g) || []).length;
const looksLikeMarkupDump = (t: string) => t.trimStart().startsWith('{\\rtf') || controlTokens(t) > 300;

// Recovery: some files carry RTF bytes under a .pdf/.doc name. markitdown dumps the
// raw RTF; textutil renders it properly if we hand it a .rtf-named copy.
function recoverRtf(absPath: string, idx: number): string {
  const tmp = join(tmpdir(), `dent-ingest-${idx}.rtf`);
  try {
    writeFileSync(tmp, readFileSync(absPath));
    return execFileSync('textutil', ['-convert', 'txt', '-stdout', tmp], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch { return ''; }
  finally { try { rmSync(tmp); } catch {} }
}

interface Row { relPath: string; area: string; ext: string; bytes: number; mtime: string; lane: string; reason: string; local: boolean }

// NOTE: must be 'archives/...' (plural), NOT 'archive/'. The brain reserves the
// singular 'archive/' slug prefix as a demoted/hard-excluded search namespace
// (src/core/search/source-boost.ts), so pages under 'archive/' are invisible to
// default recall. 'archives/dropbox/' matches the existing 'archives/dropbox-profiles/'
// convention and gets neutral (1.0) search ranking.
const SLUG_PREFIX = 'archives/dropbox'; // → source 'dent' at archives/dropbox/<jd-tree>/...
const slugifySeg = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const slugForPath = (relPath: string) => {
  const noExt = relPath.replace(/\.[^./]+$/, '');
  return SLUG_PREFIX + '/' + noExt.split('/').map(slugifySeg).filter(Boolean).join('/');
};
// Same basename + different type (foo.pdf, foo.docx) slugify identically. Keep both
// by appending the extension, then a counter, so no page silently overwrites another.
const seenSlugs = new Set<string>();
const uniqueSlug = (base: string, ext: string): string => {
  if (!seenSlugs.has(base)) { seenSlugs.add(base); return base; }
  let cand = `${base}-${ext}`;
  for (let n = 2; seenSlugs.has(cand); n++) cand = `${base}-${ext}-${n}`;
  seenSlugs.add(cand); return cand;
};

// markitdown's PDF extraction can emit NUL (0x00) and other C0 control bytes.
// Postgres TEXT columns reject NUL ("invalid byte sequence for encoding UTF8: 0x00"),
// so strip all C0 controls except tab / newline / carriage-return before staging.
const stripControlChars = (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

function extractText(absPath: string, ext: string): string {
  let raw = '';
  if (PASSTHROUGH_EXTS.has(ext)) raw = readFileSync(absPath, 'utf8');
  else if (ext === 'webloc') {
    // plist (binary or xml) — plutil reads both
    try { raw = '# ' + basename(absPath) + '\n\n' + execFileSync('plutil', ['-extract', 'URL', 'raw', '-o', '-', absPath], { encoding: 'utf8' }).trim() + '\n'; }
    catch { raw = ''; }
  } else if (MARKITDOWN_EXTS.has(ext)) {
    raw = execFileSync(MARKITDOWN, [absPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  }
  return stripControlChars(raw);
}

function frontmatter(r: Row, title: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'source: dropbox',
    `dropbox_path: ${JSON.stringify(r.relPath)}`,
    `original_type: ${r.ext}`,
    `bytes: ${r.bytes}`,
    `file_date: ${r.mtime}`,
    `jd_area: ${JSON.stringify(r.area)}`,
    `online_only_at_catalog: ${!r.local}`,
    '---',
    '',
    `[Source: dropbox/${r.relPath}]`,
    '',
  ].join('\n');
}

// --- run --------------------------------------------------------------------
const rows: Row[] = readFileSync(MANIFEST, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const todo = rows.filter((r) => (ALL || r.area === AREA) && (r.lane === 'ingest_text' || r.lane === 'ingest_tabular'));
const scopeLabel = ALL ? 'ALL areas' : `Area "${AREA}"`;
console.error(`${scopeLabel}: ${todo.length} ingest-lane files. Staging to ${OUT}`);
if (todo.length === 0) { console.error('Nothing to do. Check --area against the report.md area column.'); process.exit(0); }

mkdirSync(OUT, { recursive: true });
const logTag = ALL ? 'all' : slugifySeg(AREA);
const stagedLog = join(BASE, `staged-${logTag}.jsonl`);
writeFileSync(stagedLog, '');
const pointersLog = join(BASE, `pointers-${logTag}.jsonl`);
writeFileSync(pointersLog, '');
const reviewLog = join(BASE, `review-${logTag}.jsonl`);
writeFileSync(reviewLog, '');

let staged = 0, pointers = 0, failed = 0, review = 0, downloaded = 0;
const limit = LIMIT > 0 ? Math.min(LIMIT, todo.length) : todo.length;

for (let i = 0; i < limit; i++) {
  const r = todo[i];
  const abs = join(SRC, r.relPath);
  process.stderr.write(`  [${i + 1}/${limit}] ${r.relPath.slice(0, 90)} `);

  if (downloaded + r.bytes > MAX_DOWNLOAD_BYTES) {
    console.error(`\nABORT: next file would exceed --max-download (${(MAX_DOWNLOAD_BYTES / 1073741824).toFixed(1)} GB). Staged ${staged}, raise the ceiling to continue.`);
    break;
  }

  // pointer-only types never get read
  if (POINTER_EXTS.has(r.ext)) {
    appendFileSync(pointersLog, JSON.stringify({ ...r, pointerReason: 'iwork-no-cli' }) + '\n');
    pointers++; process.stderr.write('→ pointer (iwork)\n'); continue;
  }

  let text = '';
  try { text = extractText(abs, r.ext); downloaded += r.bytes; }
  catch (e: any) {
    appendFileSync(pointersLog, JSON.stringify({ ...r, pointerReason: 'extract_failed', err: String(e?.message || e).slice(0, 200) }) + '\n');
    failed++; process.stderr.write('→ FAILED (pointer)\n'); continue;
  }

  if (text.replace(/\s/g, '').length < MIN_CHARS) {
    appendFileSync(pointersLog, JSON.stringify({ ...r, pointerReason: 'empty_extraction' }) + '\n');
    pointers++; process.stderr.write('→ pointer (empty/scanned)\n'); continue;
  }

  // Markup-dump guard: markitdown sometimes emits raw RTF source. Try textutil recovery.
  if (looksLikeMarkupDump(text)) {
    const recovered = recoverRtf(abs, i);
    if (recovered && !looksLikeMarkupDump(recovered) && recovered.replace(/\s/g, '').length >= MIN_CHARS) {
      text = recovered; process.stderr.write('(rtf-recovered) ');
    } else {
      appendFileSync(reviewLog, JSON.stringify({ ...r, reviewReason: 'markup_dump', controlTokens: controlTokens(text), chars: text.length }) + '\n');
      review++; process.stderr.write('→ REVIEW (markup dump)\n'); continue;
    }
  }

  // Oversized guard: a clean doc this big is unlikely; flag rather than pollute the brain.
  if (text.length > MAX_CHARS) {
    appendFileSync(reviewLog, JSON.stringify({ ...r, reviewReason: 'oversized', chars: text.length }) + '\n');
    review++; process.stderr.write(`→ REVIEW (oversized ${text.length})\n`); continue;
  }

  const title = basename(r.relPath, extname(r.relPath));
  const slug = uniqueSlug(slugForPath(r.relPath), r.ext);
  const outPath = join(OUT, slug + '.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, frontmatter(r, title) + text.trim() + '\n');
  appendFileSync(stagedLog, JSON.stringify({ relPath: r.relPath, slug, outPath, ext: r.ext, chars: text.length }) + '\n');
  staged++; process.stderr.write(`→ staged (${text.length} chars)\n`);
}

console.error('');
console.error(`Done. staged=${staged}  pointer=${pointers}  review=${review}  failed=${failed}  downloaded≈${(downloaded / 1048576).toFixed(0)} MB`);
console.error(`  staged md:   ${OUT}/<jd-tree>/...`);
console.error(`  staged log:  ${stagedLog}`);
console.error(`  pointer log: ${pointersLog}`);
console.error(`  review log:  ${reviewLog}`);
