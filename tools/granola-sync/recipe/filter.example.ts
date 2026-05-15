/**
 * Example user filter for granola-sync.
 *
 * This file is the starting point your /dent-extensions setup conversation
 * will customize. Copy it to ../user/filter.ts and edit, OR have the setup
 * skill rewrite it from scratch based on your Granola folders and the
 * org/keyword signals you care about.
 *
 * Contract: see RECIPE.md and ../types.ts. In short, `filter(note)` must
 * return `{ keep, reason }`. `keep: true` means the meeting will be filed
 * into the shared brain. Anything ambiguous should `keep: false` — the
 * privacy bias is "exclude unless I'm sure."
 *
 * This example reproduces the v0.38-and-earlier hardcoded Dent defaults:
 * folder-membership / title-keyword / body-keyword / attendee-domain signals.
 * Customize by adding excludes (excludeFolders, excludeDomains,
 * excludeKeywords) — exclusion wins over inclusion.
 */

import type { Note, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

// ─── Customize these ────────────────────────────────────────────────────────

/** Keywords identifying your org. Whole-word matched against title and body. */
const ORG_KEYWORDS = ['dent'];

/** Email domains for your team. Matched against attendee emails. */
const ORG_DOMAINS = ['dentthefuture.com'];

/** Granola folder names treated as auto-include (case-insensitive). */
const ORG_FOLDERS = ['Dent'];

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
    ORG_FOLDERS.some((of) => f.toLowerCase() === of.toLowerCase()),
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
