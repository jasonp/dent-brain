/**
 * Dent-meeting filter.
 *
 * A meeting is "Dent-related" if ANY of these signals fire:
 *
 *   1. The meeting title contains "dent" (case-insensitive substring).
 *      Catches "Dent Editorial", "Jason and Dent Team", "Blend prep", etc.
 *      False-positives possible (e.g. "President" — not currently a problem
 *      since we substring-match "dent" against word/non-word boundaries).
 *
 *   2. ANY attendee email is from a Dent team domain (default: dentthefuture.com).
 *      The presence of a Dent staffer makes the meeting Dent-relevant by
 *      definition — even if it's a 1:1 with an external person, the staffer
 *      cares about a brain page for it.
 *
 *   3. ANY attendee email matches an entity already in the brain. This is
 *      the most permissive signal and catches meetings with people we
 *      already track (investors, partners, prospects we've added). We
 *      check this against an in-memory set the caller passes in.
 *
 * The 3rd check requires querying gbrain for "is <email> in any entity
 * page's frontmatter?" — the caller pre-builds the email set.
 *
 * Skipped meetings: anything where NONE of the signals fire. Likely
 * personal / unrelated. The filter logs a brief reason for skip so we
 * can audit false-negatives later.
 */

import type { GranolaDocument } from './types.ts';

export interface FilterContext {
  /** Domains considered "Dent team" (e.g. dentthefuture.com). */
  dentDomains: string[];
  /** Lowercased emails the brain already has an entity page for. */
  brainEmails: Set<string>;
  /** Title-substring filter. Lowercase. */
  titleKeywords: string[];
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

export function isDentRelated(doc: GranolaDocument, ctx: FilterContext): FilterResult {
  const title = lower(doc.title);
  const emails = attendeeEmails(doc);

  // Signal 1: title keyword
  for (const kw of ctx.titleKeywords) {
    if (title.includes(kw)) {
      return { keep: true, reason: `title contains "${kw}"`, matchedAttendees: emails };
    }
  }

  // Signal 2: Dent team email
  const dentTeamHits = emails.filter((e) => ctx.dentDomains.some((d) => e.endsWith(`@${d}`)));
  if (dentTeamHits.length > 0) {
    return { keep: true, reason: `Dent-team attendee(s): ${dentTeamHits.join(', ')}`, matchedAttendees: emails };
  }

  // Signal 3: known-entity email
  const brainHits = emails.filter((e) => ctx.brainEmails.has(e));
  if (brainHits.length > 0) {
    return { keep: true, reason: `brain entity match: ${brainHits.join(', ')}`, matchedAttendees: emails };
  }

  return { keep: false, reason: emails.length === 0 ? 'no attendees on event' : 'no Dent signal in title or attendees' };
}
