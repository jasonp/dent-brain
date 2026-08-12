/**
 * Example user filter for email-sync.
 *
 * This file is the starting point your /dent-extensions setup conversation
 * will customize. Copy it to ../user/filter.ts and edit, OR have the setup
 * skill rewrite it from scratch based on a sample of your recent senders.
 *
 * Contract: see RECIPE.md and ../types.ts. Runs AFTER canonical noise +
 * signature classification — by default this example drops `isNoise` mail,
 * keeps everything else, and excludes a few personal-domain examples.
 *
 * Two postures shown side by side. Pick one for ../user/filter.ts:
 *   - EXCLUDELIST: default-keep, drop specific senders/subjects/domains.
 *   - ALLOWLIST:   default-drop, keep only specific senders/domains.
 */

import type { CollectedEmail, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

// ─── Customize: pick one posture ────────────────────────────────────────────

const POSTURE: 'excludelist' | 'allowlist' = 'excludelist';

// Excludelist posture (default-keep, drop specific things):
const EXCLUDE_SENDER_DOMAINS: string[] = [
  // 'personal-bank.com',
  // 'therapist-office.example',
];
const EXCLUDE_SENDERS: string[] = [
  // 'family-member@example.com',
];
const EXCLUDE_SUBJECT_PATTERNS: RegExp[] = [
  // /amazon.*order/i,
  // /\bvenmo\b/i,
];

// Allowlist posture (default-drop, keep only matching things):
const ALLOWED_SENDER_DOMAINS: string[] = [
  // 'dentthefuture.com',
  // 'known-investor.com',
];
const ALLOWED_SENDERS: string[] = [
  // 'specific-person@example.com',
];

// Shared: drop bulk-noise emails by default. The canonical noise-filter has
// already flagged these (e.g. mailchimp.com, noreply@…). You can override
// per-sender by removing this line and listing the noisy senders you actually
// want in the brain.
const DROP_NOISE = true;

// Drop bulk mail identified by its RFC headers (List-Unsubscribe, List-Id,
// Precedence: bulk) rather than by sender address. This is what catches
// newsletters sent from human-looking addresses — `seattle@axios.com`,
// `welcome@vendor.example` — that address patterns cannot distinguish from a
// person. Leave true unless you actively want newsletters in the brain; set
// false to keep them (they still land in the digest's Noise section for audit,
// never in Triage).
const DROP_BULK = true;

// Drop e-signature requests (Docusign, Dropbox Sign, etc). Some teams want
// these surfaced; flip to false to send them through.
const DROP_SIGNATURES = false;

// ─── Implementation ─────────────────────────────────────────────────────────

function senderDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function filter(email: CollectedEmail): FilterResult {
  if (DROP_NOISE && email.isNoise) {
    return { keep: false, reason: 'noise sender (bulk/transactional)' };
  }
  if (DROP_BULK && email.isBulk) {
    return { keep: false, reason: 'bulk mail (List-Unsubscribe / Precedence: bulk)' };
  }
  if (DROP_SIGNATURES && email.isSignature) {
    return { keep: false, reason: 'e-signature request' };
  }

  if (POSTURE === 'excludelist') {
    const dom = senderDomain(email.fromEmail);
    if (EXCLUDE_SENDER_DOMAINS.some(d => dom === d.toLowerCase())) {
      return { keep: false, reason: `excluded sender domain: ${dom}` };
    }
    if (EXCLUDE_SENDERS.some(s => email.fromEmail.toLowerCase() === s.toLowerCase())) {
      return { keep: false, reason: `excluded sender: ${email.fromEmail}` };
    }
    for (const rx of EXCLUDE_SUBJECT_PATTERNS) {
      if (rx.test(email.subject)) {
        return { keep: false, reason: `excluded subject pattern: ${rx.source}` };
      }
    }
    return { keep: true, reason: 'no excludes matched' };
  }

  // ALLOWLIST
  const dom = senderDomain(email.fromEmail);
  if (ALLOWED_SENDER_DOMAINS.some(d => dom === d.toLowerCase())) {
    return { keep: true, reason: `allowlisted domain: ${dom}` };
  }
  if (ALLOWED_SENDERS.some(s => email.fromEmail.toLowerCase() === s.toLowerCase())) {
    return { keep: true, reason: `allowlisted sender: ${email.fromEmail}` };
  }
  return { keep: false, reason: 'allowlist: no match' };
}
