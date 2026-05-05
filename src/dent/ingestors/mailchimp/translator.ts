/**
 * Pure translator: MailchimpMember → ingestion plan.
 *
 * No side effects. The orchestrator (csv-bootstrap.ts and, eventually, an
 * api-poll cron) takes the plan and decides what to actually write —
 * append to existing entity, create new stub, or send to pending review.
 *
 * The same translator serves the historical CSV bootstrap and (Phase 5.2-later)
 * the live Mailchimp Marketing API poller. Both produce MailchimpMember;
 * both feed this function; both end up writing the same bullet shape with
 * the same `[Source: mailchimp/<EUID>]` idempotency tag.
 *
 * Filing rule: Mailchimp-only people live in `entities/audience/`, NOT
 * `entities/people/`. Reason: people in `entities/people/` are people who
 * have actually engaged with Dent (registered for an event, attended a
 * meeting, etc). Mailchimp members who never registered are "email
 * audience" — distinct category, distinct directory. If one of them later
 * registers, the regfox ingestor's email-match logic finds the audience
 * page and appends to it; a follow-up `/dent-promote-to-people` (or
 * manual move) can relocate the page to `entities/people/` once that
 * happens. The orchestrator decides which directory based on whether an
 * existing page is found in either location.
 */

export const MAILCHIMP_STUB_DIR = 'entities/audience';

import { kebabize } from '../regfox/translator.ts';
import type { MailchimpMember } from './types.ts';

export interface TranslatedMember {
  /** Lowercased + trimmed email — entity-resolution key. */
  email: string;
  /** Trimmed full name for slug derivation + name-match dedup. May be null
   * if Mailchimp had no first/last on the member. */
  fullName: string | null;
  /** Kebab-case slug derived from full name (preferred) or email local part. */
  proposedSlug: string;
  /** ISO date used in the primary status bullet (optin/unsub/clean date,
   * fallback to last_changed, fallback to today). */
  isoDate: string;
  /** Stable provenance ref appearing in every bullet. */
  sourceRef: string;
  /** Bullets to append under `## Timeline`, oldest-first. Always at least
   * one (the status bullet). May include a tags bullet and a profile bullet. */
  bullets: string[];
  /** Frontmatter for the new-stub case. */
  stubFrontmatter: Record<string, string | number | boolean>;
  /** Stub body (after frontmatter fence) — includes the bullets baked into
   * a `## Timeline` section. */
  stubBody: string;
}

export interface TranslatorOptions {
  /** When false, the profile-fields bullet is suppressed. Default true. */
  emitProfileBullet?: boolean;
  /** When false, the tags bullet is suppressed. Default true. */
  emitTagsBullet?: boolean;
}

export function translateMember(
  m: MailchimpMember,
  opts: TranslatorOptions = {},
): TranslatedMember {
  const emitProfileBullet = opts.emitProfileBullet !== false;
  const emitTagsBullet = opts.emitTagsBullet !== false;

  const fullName = deriveFullName(m);
  const proposedSlug = deriveSlug(fullName, m.email);
  const isoDate = pickPrimaryDate(m);
  const sourceRef = `mailchimp/${m.euid}`;

  const bullets: string[] = [];
  bullets.push(buildStatusBullet(m, isoDate, sourceRef));
  if (emitTagsBullet && m.tags.length > 0) {
    bullets.push(buildTagsBullet(m, isoDate, sourceRef));
  }
  if (emitProfileBullet) {
    const profile = buildProfileBullet(m, isoDate, sourceRef);
    if (profile) bullets.push(profile);
  }

  const stubFrontmatter: Record<string, string | number | boolean> = {
    title: fullName ?? m.email,
    slug: `${MAILCHIMP_STUB_DIR}/${proposedSlug}`,
    type: 'audience-member',
    created_via: 'mailchimp-ingestor',
    audience_only: true,
    mailchimp_euid: m.euid,
    mailchimp_status: m.status,
    email: m.email,
    updated: isoDate,
  };
  if (m.organization) stubFrontmatter.organization = m.organization;
  if (m.title) stubFrontmatter.role_title = m.title;

  const headerName = fullName ?? m.email;
  const stubBody =
    `# ${headerName}\n\n` +
    `Stub created by the Mailchimp ingestor on ${isoDate}. ` +
    'Run `/dent-enrich` after the page accumulates more observations to flesh it out.\n\n' +
    '## Timeline\n\n' +
    bullets.join('\n');

  return { email: m.email, fullName, proposedSlug, isoDate, sourceRef, bullets, stubFrontmatter, stubBody };
}

function deriveFullName(m: MailchimpMember): string | null {
  const first = (m.firstName ?? '').trim();
  const last = (m.lastName ?? '').trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  return null;
}

function deriveSlug(fullName: string | null, email: string): string {
  if (fullName) {
    const slug = kebabize(fullName);
    if (slug.length > 0) return slug;
  }
  const local = email.split('@')[0] ?? '';
  const slug = kebabize(local);
  if (slug.length > 0) return slug;
  return 'unknown-mailchimp-member';
}

function pickPrimaryDate(m: MailchimpMember): string {
  if (m.status === 'unsubscribed' && m.unsubDate) return m.unsubDate;
  if (m.status === 'cleaned' && m.cleanDate) return m.cleanDate;
  if (m.optinDate) return m.optinDate;
  if (m.lastChanged) return m.lastChanged;
  return new Date().toISOString().slice(0, 10);
}

function buildStatusBullet(m: MailchimpMember, isoDate: string, sourceRef: string): string {
  const parts: string[] = [];
  switch (m.status) {
    case 'subscribed': {
      parts.push('Subscribed to Mailchimp list');
      if (m.optinDate && m.optinDate !== isoDate) parts.push(`(opted in ${m.optinDate})`);
      if (m.memberRating != null) parts.push(`[member rating ${m.memberRating}/5]`);
      break;
    }
    case 'unsubscribed': {
      parts.push('Unsubscribed from Mailchimp list');
      if (m.unsubCampaignTitle) parts.push(`via campaign "${m.unsubCampaignTitle}"`);
      if (m.unsubReason) parts.push(`(reason: ${m.unsubReason})`);
      break;
    }
    case 'cleaned': {
      parts.push('Mailchimp list-cleaned (bounced/invalid)');
      if (m.cleanCampaignTitle) parts.push(`during campaign "${m.cleanCampaignTitle}"`);
      break;
    }
    case 'nonsubscribed': {
      parts.push('Mailchimp non-subscribed contact (never opted in)');
      break;
    }
  }
  return `- **${isoDate}** | ${parts.join(' ')}. [Source: ${sourceRef}]`;
}

function buildTagsBullet(m: MailchimpMember, isoDate: string, sourceRef: string): string {
  return `- **${isoDate}** | Mailchimp tags: ${m.tags.join(', ')}. [Source: ${sourceRef}]`;
}

function buildProfileBullet(m: MailchimpMember, isoDate: string, sourceRef: string): string | null {
  const fields: string[] = [];
  if (m.organization) fields.push(`Organization: ${m.organization}`);
  if (m.title) fields.push(`Title: ${m.title}`);
  const location = [m.city, m.state, m.country].filter(Boolean).join(', ');
  if (location) fields.push(`Location: ${location}`);
  if (m.phone) fields.push(`Phone: ${m.phone}`);
  if (m.linkedinUrl) fields.push(`LinkedIn: ${m.linkedinUrl}`);
  if (fields.length === 0) return null;
  return `- **${isoDate}** | Mailchimp profile — ${fields.join('; ')}. [Source: ${sourceRef}]`;
}
