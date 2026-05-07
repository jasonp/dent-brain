/**
 * Org-meeting filter.
 *
 * A meeting is "org-related" (and therefore worth filing into this org's
 * brain) if ANY of these signals fire:
 *
 *   1. The doc is filed in a Granola folder whose name matches one of the
 *      configured `orgFolders` (case-insensitive). This is the strongest
 *      signal because the user already curated it manually.
 *
 *   2. The meeting title contains one of the configured `orgKeywords` as a
 *      whole word (regex `\bkw\b`). Word-boundary matching avoids false
 *      positives like "President" / "evident" / "dental" for keyword "dent".
 *
 *   3. The meeting body — `notes_markdown` + `summary` + chapter text +
 *      transcript text — contains one of the `orgKeywords` as a whole word.
 *      Catches meetings where the org came up substantively but isn't in
 *      the title.
 *
 *   4. ANY attendee email is from a configured `orgDomains` entry. The
 *      presence of a teammate makes the meeting org-relevant by definition.
 *
 * Plus a `fileAll` config option: if true, every meeting passes. Off by
 * default because cross-org leakage (e.g. a Dent teammate's TK or Reclaim
 * Curiosity meetings landing in the Dent brain) is rarely what you want.
 *
 * Skipped meetings: anything where NONE of the signals fire AND fileAll is
 * false. The filter logs a brief reason for skip so we can audit
 * false-negatives later.
 */

import type { GranolaDocument, GranolaTranscriptSegment } from './types.ts';

export interface FilterContext {
  /** Keywords identifying the org. Lowercase. Matched as whole words via `\b`. */
  orgKeywords: string[];
  /** Email domains for the org (e.g. `acme.com`). Matched against attendee emails. */
  orgDomains: string[];
  /** Granola folder names to treat as auto-include. Case-insensitive equality. */
  orgFolders: string[];
  /** If true, every meeting passes the filter. Default: false. */
  fileAll: boolean;
  /** Map from Granola document ID → folder names containing it. */
  docToFolders: Map<string, string[]>;
}

export type FilterResult =
  | { keep: true; reason: string; matchedAttendees: string[] }
  | { keep: false; reason: string };

function lower(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

function attendeeEmails(doc: GranolaDocument): string[] {
  const ev = doc.google_calendar_event;
  const out: string[] = [];
  for (const a of ev?.attendees ?? []) {
    const e = lower(a.email);
    if (e) out.push(e);
  }
  // Creator + organizer are sometimes only on those fields, not in attendees.
  const c = lower(ev?.creator?.email);
  if (c && !out.includes(c)) out.push(c);
  const o = lower(ev?.organizer?.email);
  if (o && !out.includes(o)) out.push(o);
  return out;
}

function bodyText(doc: GranolaDocument, transcript: GranolaTranscriptSegment[] | undefined): string {
  const parts: string[] = [];
  if (typeof doc.notes_markdown === 'string') parts.push(doc.notes_markdown);
  if (typeof doc.summary === 'string') parts.push(doc.summary);
  if (typeof doc.overview === 'string' && doc.overview) parts.push(doc.overview);
  if (Array.isArray(doc.chapters)) {
    for (const ch of doc.chapters) {
      if (ch?.title) parts.push(ch.title);
      if (ch?.summary) parts.push(ch.summary);
    }
  }
  if (transcript) {
    for (const seg of transcript) {
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

export function isOrgRelated(
  doc: GranolaDocument,
  transcript: GranolaTranscriptSegment[] | undefined,
  ctx: FilterContext,
): FilterResult {
  const emails = attendeeEmails(doc);

  if (ctx.fileAll) {
    return { keep: true, reason: 'fileAll: true (all meetings pass)', matchedAttendees: emails };
  }

  // Signal 1: Granola folder
  const folders = ctx.docToFolders.get(doc.id) ?? [];
  const folderHits = folders.filter((f) =>
    ctx.orgFolders.some((of) => f.toLowerCase() === of.toLowerCase()),
  );
  if (folderHits.length > 0) {
    return { keep: true, reason: `Granola folder: ${folderHits.join(', ')}`, matchedAttendees: emails };
  }

  // Signal 2: title (whole-word)
  const title = doc.title ?? '';
  for (const kw of ctx.orgKeywords) {
    if (wholeWordMatch(title, kw)) {
      return { keep: true, reason: `title matches "${kw}"`, matchedAttendees: emails };
    }
  }

  // Signal 3: body / transcript (whole-word)
  const body = bodyText(doc, transcript);
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
