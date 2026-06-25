/**
 * Example user filter for granola-sync.
 *
 * This file is the starting point your /dent-extensions setup conversation
 * will customize. Copy it to ../user/filter.ts and edit, OR have the setup
 * skill rewrite it from scratch based on your Granola folders and the
 * org/keyword signals you care about.
 *
 * Contract: see RECIPE.md and ../types.ts. Two exports:
 *   - `includeFolders`: Granola folder NAMES the daemon pulls each run (the
 *     capture set). The sync fetches these folders server-side, so filing a
 *     meeting into one is how it reaches the brain — and filing it late still
 *     works as long as the note was *created* within the recent look-back
 *     window (the scan filters on creation time; an older note needs `--since`).
 *   - `filter(note)`: a per-note narrowing gate run on top. Returns
 *     `{ keep, reason }`; the privacy bias is "exclude unless I'm sure." Use it
 *     to drop notes WITHIN the captured folders (e.g. an attendee you never want
 *     filed). Since the daemon only fetches notes already in an include folder,
 *     the keyword/domain INCLUDE branches below are redundant with the folder
 *     capture — they're kept as a template for teammates who narrow.
 */

import type { Note, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

// ─── Customize these ────────────────────────────────────────────────────────

/** Granola folder NAMES the daemon pulls each run (the capture set). The daemon
 *  reads this to decide what to fetch; filter() below also reuses it as a
 *  redundant include signal. One list, one name — no alias. */
export const includeFolders = ['Dent'];

/** Keywords identifying your org. Whole-word matched against title and body. */
const ORG_KEYWORDS = ['dent'];

/** Email domains for your team. Matched against attendee emails. */
const ORG_DOMAINS = ['dentthefuture.com'];

/** Granola folders that ALWAYS exclude — wins over any include signal. */
const EXCLUDE_FOLDERS: string[] = [];

/** Keywords that ALWAYS exclude when present in title (whole-word). */
const EXCLUDE_KEYWORDS: string[] = [];

/** Attendee domains that ALWAYS exclude. Useful for "if my therapist is here, skip." */
const EXCLUDE_DOMAINS: string[] = [];

// ─── Implementation ─────────────────────────────────────────────────────────

function lower(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

function noteEmails(note: Note): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (e: string | undefined | null) => {
    const v = lower(e);
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const a of note.attendees ?? []) push(a.email);
  for (const i of note.calendar_event?.invitees ?? []) push(i.email);
  push(note.calendar_event?.organiser);
  return out;
}

function bodyText(note: Note): string {
  const parts: string[] = [];
  if (note.summary_text) parts.push(note.summary_text);
  if (note.summary_markdown) parts.push(note.summary_markdown);
  if (Array.isArray(note.transcript)) {
    for (const seg of note.transcript) {
      if (seg?.text) parts.push(seg.text);
    }
  }
  return parts.join(' ');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWordMatch(haystack: string, keyword: string): boolean {
  if (!haystack || !keyword) return false;
  const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
  return re.test(haystack);
}

export function filter(note: Note): FilterResult {
  const emails = noteEmails(note);
  const folders = (note.folder_membership ?? []).map((f) => f.name);
  const title = note.title ?? '';

  // Exclusions — checked first, win over any include signal.
  const excludeFolderHits = folders.filter((f) =>
    EXCLUDE_FOLDERS.some((ef) => f.toLowerCase() === ef.toLowerCase()),
  );
  if (excludeFolderHits.length > 0) {
    return { keep: false, reason: `excluded by folder: ${excludeFolderHits.join(', ')}` };
  }
  for (const kw of EXCLUDE_KEYWORDS) {
    if (wholeWordMatch(title, kw)) {
      return { keep: false, reason: `excluded by title keyword "${kw}"` };
    }
  }
  const excludeDomainHits = emails.filter((e) =>
    EXCLUDE_DOMAINS.some((d) => e.endsWith(`@${d}`)),
  );
  if (excludeDomainHits.length > 0) {
    return { keep: false, reason: `excluded by attendee domain: ${excludeDomainHits.join(', ')}` };
  }

  // Inclusions — any signal wins.
  const folderHits = folders.filter((f) =>
    includeFolders.some((of) => f.toLowerCase() === of.toLowerCase()),
  );
  if (folderHits.length > 0) {
    return { keep: true, reason: `Granola folder: ${folderHits.join(', ')}` };
  }

  for (const kw of ORG_KEYWORDS) {
    if (wholeWordMatch(title, kw)) {
      return { keep: true, reason: `title matches "${kw}"` };
    }
  }

  const body = bodyText(note);
  for (const kw of ORG_KEYWORDS) {
    if (wholeWordMatch(body, kw)) {
      return { keep: true, reason: `body mentions "${kw}"` };
    }
  }

  const domainHits = emails.filter((e) => ORG_DOMAINS.some((d) => e.endsWith(`@${d}`)));
  if (domainHits.length > 0) {
    return { keep: true, reason: `org-domain attendee(s): ${domainHits.join(', ')}` };
  }

  return {
    keep: false,
    reason: emails.length === 0
      ? 'no attendees, no org signal'
      : 'no org signal in folder, title, body, or attendees',
  };
}
