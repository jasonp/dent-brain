/**
 * Identity matching for the RegFox ingestor's name-collision step.
 *
 * Background (incident 2026-06-27): the ingestor used to email-match ONLY.
 * A returning attendee who registered with a new email (changed jobs, used a
 * personal address, etc.) failed the exact-email check, hit the name-slug
 * collision guard, and got dumped into `_ingest/pending_regfox` for human
 * review. That file grew to 550 rows — almost all the SAME ~150 people.
 *
 * This module adds a high-precision classifier for the collision case: given
 * a registrant whose email didn't match but whose name-slug already exists,
 * decide whether to confidently APPEND to that person (and record the new
 * email so the NEXT registration matches directly) or leave it PENDING.
 *
 * Precision over recall, by design: a wrong auto-merge attaches a stranger's
 * registration to someone's page, which is worse than a pending row a human
 * clears. So only strong, individuating signals trigger an append; anything
 * fuzzy stays pending.
 *
 * Pure + side-effect-free (except the string helpers) so it is fully unit
 * testable without an engine or network.
 */

import matter from 'gray-matter';

// Generic mailbox providers — a shared domain here means nothing.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.net',
  'proton.me', 'protonmail.com', 'pm.me', 'hey.com', 'fastmail.com',
  'mail.com', 'zoho.com', 'yandex.com', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net',
  'ymail.co', 'rocketmail.com', 'mailinator.com', 'lycos.com',
]);

// RFC 2606 reserved + obvious placeholders — never a real personal identity.
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'example']);
const RESERVED_TLDS = new Set(['test', 'invalid', 'localhost', 'example', 'local']);

// Role / shared mailboxes — a matching local-part across domains isn't a person.
const ROLE_LOCALS = new Set([
  'info', 'admin', 'contact', 'hello', 'office', 'support', 'team', 'sales',
  'mail', 'events', 'hi', 'no-reply', 'noreply', 'do-not-reply', 'donotreply',
  'billing', 'accounts', 'help', 'inbox', 'webmaster', 'postmaster', 'enquiries',
]);

const TWO_LEVEL_TLDS = new Set(['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'org.uk', 'ac.uk']);

export interface EmailParts { local: string; domain: string }

/** Split + normalize an email. Returns null for anything malformed. */
export function splitEmail(email: string | null | undefined): EmailParts | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at >= e.length - 1) return null;
  const domain = e.slice(at + 1);
  if (!domain.includes('.')) return null;
  return { local: e.slice(0, at), domain };
}

function domainIsIdentifying(domain: string): boolean {
  if (!domain) return false;
  if (FREEMAIL.has(domain)) return false;
  if (RESERVED_DOMAINS.has(domain)) return false;
  const tld = domain.split('.').pop() ?? '';
  if (RESERVED_TLDS.has(tld)) return false;
  return true;
}

/** The registrable label of a domain: `mauvais` for mauvais.com, `acme` for acme.co.uk. */
export function domainRootLabel(domain: string): string {
  const parts = domain.split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo) && parts.length >= 3) return parts[parts.length - 3];
  return parts[parts.length - 2];
}

export interface NameMatchInput {
  /** Registrant's email (raw; normalized internally). */
  registrantEmail: string | null;
  /** Registrant's billing first / last name. */
  firstName: string | null;
  lastName: string | null;
  /** All emails on the existing same-name page (frontmatter `email` + `emails[]`). */
  candidateEmails: string[];
  /** True iff other `<name>-N` person pages already exist (a known collision). */
  hasVariants: boolean;
}

export type NameMatchVerdict =
  | { decision: 'append'; signal: string }
  | { decision: 'pending'; signal: string };

/**
 * Decide whether a name-collision registrant is the SAME person as the
 * existing page. See module header for the precision-first rationale.
 */
export function classifyNameMatch(input: NameMatchInput): NameMatchVerdict {
  const re = splitEmail(input.registrantEmail);
  if (!re) return { decision: 'pending', signal: 'no_email' };

  const first = (input.firstName ?? '').toLowerCase().trim();
  const last = (input.lastName ?? '').toLowerCase().trim();

  // ── Tier A: the new email is tied to THIS page's existing identity. Safe
  // even when same-name variants exist, because it matches a specific
  // candidate address, not just the name.
  for (const cand of input.candidateEmails) {
    const ce = splitEmail(cand);
    if (!ce) continue;
    if (ce.domain === re.domain && domainIsIdentifying(re.domain)) {
      return { decision: 'append', signal: `shared_custom_domain:${re.domain}` };
    }
    if (ce.local === re.local && re.local.length >= 4 && !ROLE_LOCALS.has(re.local)) {
      return { decision: 'append', signal: `shared_local_part:${re.local}` };
    }
  }

  // ── Tier B: the new email is tied to the NAME (not a specific existing
  // address). Only trust it when there is no known same-name collision.
  const nameSignal = nameEmailSignal(re, first, last);
  if (nameSignal) {
    if (input.hasVariants) return { decision: 'pending', signal: `${nameSignal}_but_variants` };
    return { decision: 'append', signal: nameSignal };
  }

  return { decision: 'pending', signal: 'weak_signal' };
}

function nameEmailSignal(re: EmailParts, first: string, last: string): string | null {
  // Personal domain named after the surname: scott@mauvais.com.
  if (last.length >= 4 && domainIsIdentifying(re.domain)) {
    const root = domainRootLabel(re.domain);
    if (root === last || (root.length >= 5 && (root.includes(last) || last.includes(root)))) {
      return `surname_domain:${re.domain}`;
    }
  }

  const local = re.local;
  if (ROLE_LOCALS.has(local) || last.length < 4) return null;

  const hasLast = local.includes(last);
  if (!hasLast) return null;

  // Surname + first name both present: david.jones, davidjones, davej(ones).
  const firstPrefix = first.slice(0, Math.min(first.length, 4));
  if (first.length >= 3 && (local.includes(first) || (firstPrefix.length >= 3 && local.includes(firstPrefix)))) {
    return 'full_name_in_email';
  }
  // Surname + first initial adjacent: jdoe / doej / j.doe.
  if (first.length >= 1 && (local.startsWith(first[0]) || local.endsWith(first[0]))) {
    return 'surname_with_initial';
  }
  return null;
}

// ── Frontmatter helpers (string-pure; used by the ingestor write path) ──

/** Lowercased set of every email on a page (frontmatter `email` + `emails[]`). */
export function emailsFromFrontmatter(fm: Record<string, unknown> | null | undefined): string[] {
  if (!fm) return [];
  const out: string[] = [];
  if (typeof fm.email === 'string' && fm.email.trim()) out.push(fm.email.trim().toLowerCase());
  if (Array.isArray(fm.emails)) for (const e of fm.emails) if (typeof e === 'string' && e.trim()) out.push(e.trim().toLowerCase());
  return [...new Set(out)];
}

/** Candidate emails parsed from a page's full markdown. */
export function emailsFromMarkdown(markdown: string): string[] {
  try {
    return emailsFromFrontmatter(matter(markdown).data as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Record `email` in the page's frontmatter `emails[]` (idempotent) so the next
 * registration from this address matches directly via the email path — this is
 * how the ingestor "learns" an attendee's alternate addresses. Returns the
 * markdown unchanged when the email is already known or input is malformed.
 */
export function mergeEmailIntoFrontmatter(markdown: string, email: string): string {
  const norm = (email ?? '').trim().toLowerCase();
  if (!norm) return markdown;
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(markdown);
  } catch {
    return markdown;
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  if (new Set(emailsFromFrontmatter(data)).has(norm)) return markdown;
  const existing = Array.isArray(data.emails) ? (data.emails as unknown[]).map(String) : [];
  data.emails = [...existing, email.trim()];
  return matter.stringify(parsed.content, data);
}
