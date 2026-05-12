/**
 * Org-meeting filter.
 *
 * A meeting is "org-related" (and therefore worth filing into this org's
 * brain) if ANY of these signals fire:
 *
 *   1. The note is filed in a Granola folder whose name matches one of the
 *      configured `orgFolders` (case-insensitive). Strongest signal — the
 *      user already curated it manually.
 *
 *   2. The meeting title contains one of the configured `orgKeywords` as a
 *      whole word (regex `\bkw\b`). Word-boundary matching avoids false
 *      positives like "President" / "evident" / "dental" for keyword "dent".
 *
 *   3. The body (summary_text + summary_markdown + transcript text) contains
 *      one of the `orgKeywords` as a whole word. Catches meetings where the
 *      org came up substantively but isn't in the title.
 *
 *   4. ANY attendee email is from a configured `orgDomains` entry. The
 *      presence of a teammate makes the meeting org-relevant by definition.
 *
 * Plus a `fileAll` config option: if true, every meeting passes. Off by
 * default because cross-org leakage is rarely what you want.
 */

import type { Note } from './types.ts';

export interface FilterContext {
  /** Keywords identifying the org. Lowercase. Matched as whole words via `\b`. */
  orgKeywords: string[];
  /** Email domains for the org. Matched against attendee emails. */
  orgDomains: string[];
  /** Granola folder names to treat as auto-include. Case-insensitive equality. */
  orgFolders: string[];
  /** If true, every meeting passes the filter. Default: false. */
  fileAll: boolean;
}

export type FilterResult =
  | { keep: true; reason: string; matchedAttendees: string[] }
  | { keep: false; reason: string };

function lower(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

export function noteEmails(note: Note): string[] {
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

export function isOrgRelated(note: Note, ctx: FilterContext): FilterResult {
  const emails = noteEmails(note);

  if (ctx.fileAll) {
    return { keep: true, reason: 'fileAll: true (all meetings pass)', matchedAttendees: emails };
  }

  // Signal 1: Granola folder
  const folders = (note.folder_membership ?? []).map((f) => f.name);
  const folderHits = folders.filter((f) =>
    ctx.orgFolders.some((of) => f.toLowerCase() === of.toLowerCase()),
  );
  if (folderHits.length > 0) {
    return { keep: true, reason: `Granola folder: ${folderHits.join(', ')}`, matchedAttendees: emails };
  }

  // Signal 2: title (whole-word)
  const title = note.title ?? '';
  for (const kw of ctx.orgKeywords) {
    if (wholeWordMatch(title, kw)) {
      return { keep: true, reason: `title matches "${kw}"`, matchedAttendees: emails };
    }
  }

  // Signal 3: body (whole-word)
  const body = bodyText(note);
  for (const kw of ctx.orgKeywords) {
    if (wholeWordMatch(body, kw)) {
      return { keep: true, reason: `body mentions "${kw}"`, matchedAttendees: emails };
    }
  }

  // Signal 4: org-domain attendee
  const domainHits = emails.filter((e) => ctx.orgDomains.some((d) => e.endsWith(`@${d}`)));
  if (domainHits.length > 0) {
    return { keep: true, reason: `org-domain attendee(s): ${domainHits.join(', ')}`, matchedAttendees: emails };
  }

  return {
    keep: false,
    reason: emails.length === 0 ? 'no attendees, no org signal' : 'no org signal in folder, title, body, or attendees',
  };
}
