/**
 * Minimal RFC-4180 CSV parser specialized for Mailchimp audience exports.
 *
 * Mailchimp produces well-formed CSV: comma-separated, double-quote-wrapped
 * fields with `""` to escape embedded quotes. We don't pull in a CSV library
 * because the format is narrow and the data volume is bounded (a few thousand
 * rows per file). The parser does not handle every edge case of RFC-4180 —
 * it handles what Mailchimp actually emits.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import type { MailchimpMember, MailchimpStatus } from './types.ts';

/** Parse one CSV row out of a buffer starting at `pos`. Returns the
 *  list of cells and the index of the first character of the next row
 *  (past the row terminator). */
function parseRow(src: string, pos: number): { cells: string[]; next: number } {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  while (pos < src.length) {
    const c = src[pos];
    if (inQuotes) {
      if (c === '"') {
        if (src[pos + 1] === '"') {
          cell += '"';
          pos += 2;
          continue;
        }
        inQuotes = false;
        pos++;
        continue;
      }
      cell += c;
      pos++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      pos++;
      continue;
    }
    if (c === ',') {
      cells.push(cell);
      cell = '';
      pos++;
      continue;
    }
    if (c === '\r') {
      if (src[pos + 1] === '\n') {
        cells.push(cell);
        return { cells, next: pos + 2 };
      }
      cells.push(cell);
      return { cells, next: pos + 1 };
    }
    if (c === '\n') {
      cells.push(cell);
      return { cells, next: pos + 1 };
    }
    cell += c;
    pos++;
  }
  cells.push(cell);
  return { cells, next: pos };
}

export function parseCsv(src: string): { headers: string[]; rows: Record<string, string>[] } {
  if (src.length === 0) return { headers: [], rows: [] };
  // Strip BOM if present.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const headerResult = parseRow(src, 0);
  const headers = headerResult.cells.map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  let pos = headerResult.next;
  while (pos < src.length) {
    const { cells, next } = parseRow(src, pos);
    pos = next;
    if (cells.length === 1 && cells[0] === '') continue; // empty line
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Mailchimp's TAGS column contains a comma-separated list of double-quote
 * wrapped tags within an outer pair of quotes. Example raw cell:
 *
 *   "\"2025_SF_Approveds\",\"DentAI_SEA_24_Attended\""
 *
 * After our CSV parser strips the outer quotes, what we have left is:
 *
 *   "2025_SF_Approveds","DentAI_SEA_24_Attended"
 *
 * We split on `","` and trim leading/trailing `"`. Empty / whitespace-only
 * tags are dropped. Tags are returned in original order, deduplicated.
 */
export function parseMailchimpTags(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const pushIfNew = (tag: string) => {
    const t = tag.trim();
    if (t.length === 0 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  // Preferred shape: zero or more "..." quoted tags. Walk all matches.
  const matches = [...trimmed.matchAll(/"([^"]*)"/g)];
  if (matches.length > 0) {
    for (const m of matches) pushIfNew(m[1]);
    return out;
  }
  // Fallback: plain comma-separated.
  for (const p of trimmed.split(',')) pushIfNew(p);
  return out;
}

/** Mailchimp date columns come in `YYYY-MM-DD HH:MM:SS` format. We only keep
 *  the date for our timeline bullets. Returns null on empty / unparseable. */
export function isoDateOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (m) return m[1];
  // Some exports use `YYYY/MM/DD`.
  const m2 = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(trimmed);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return undefined;
}

function pickStatus(filename: string): MailchimpStatus {
  const lower = filename.toLowerCase();
  if (lower.includes('unsubscribed')) return 'unsubscribed';
  if (lower.includes('nonsubscribed')) return 'nonsubscribed';
  if (lower.includes('cleaned')) return 'cleaned';
  return 'subscribed';
}

function trim(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a Mailchimp CSV row to MailchimpMember.
 *
 * Status is inferred from the filename — Mailchimp doesn't put it in a column.
 * Returns null if the row is unusable (missing email or EUID).
 */
function rowToMember(
  row: Record<string, string>,
  rowIndex: number,
  sourceFile: string,
  defaultStatus: MailchimpStatus,
): MailchimpMember | null {
  const email = trim(row['Email Address'])?.toLowerCase();
  const euid = trim(row['EUID']);
  if (!email || !euid) return null;

  const member: MailchimpMember = {
    email,
    euid,
    status: defaultStatus,
    leid: trim(row['LEID']),
    optinDate: isoDateOf(row['OPTIN_TIME'] ?? row['CONFIRM_TIME']),
    unsubDate: isoDateOf(row['UNSUB_TIME']),
    cleanDate: isoDateOf(row['CLEAN_TIME']),
    lastChanged: isoDateOf(row['LAST_CHANGED']),
    firstName: trim(row['First Name']),
    lastName: trim(row['Last Name']),
    organization: trim(row['Organization']),
    title: trim(row['Title']) ?? trim(row['Job_Title']),
    city: trim(row['City']),
    state: trim(row['State']),
    country: trim(row['Country']),
    phone: trim(row['Phone']),
    linkedinUrl: trim(row['LinkedInURL']),
    memberRating: num(row['MEMBER_RATING']),
    tags: parseMailchimpTags(row['TAGS'] ?? ''),
    unsubReason: trim(row['UNSUB_REASON']) ?? trim(row['UNSUB_REASON_OTHER']),
    unsubCampaignTitle: trim(row['UNSUB_CAMPAIGN_TITLE']),
    cleanCampaignTitle: trim(row['CLEAN_CAMPAIGN_TITLE']),
    rowIndex,
    sourceFile,
  };
  return member;
}

export interface ReadCsvResult {
  members: MailchimpMember[];
  /** Rows that lacked email or EUID. */
  dropped: number;
  /** Filename for provenance. */
  sourceFile: string;
}

export function readMailchimpCsv(absPath: string): ReadCsvResult {
  const filename = basename(absPath);
  const status = pickStatus(filename);
  const src = readFileSync(absPath, 'utf-8');
  const { rows } = parseCsv(src);
  const members: MailchimpMember[] = [];
  let dropped = 0;
  rows.forEach((row, idx) => {
    const m = rowToMember(row, idx, filename, status);
    if (m) members.push(m);
    else dropped++;
  });
  return { members, dropped, sourceFile: filename };
}
