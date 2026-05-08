/**
 * Deterministic noise + signature classification.
 *
 * Originally ported from gbrain's `recipes/email-to-brain.md`, extended in
 * v0.36 with marketing-subdomain detection after a real-data smoke test
 * surfaced false-triages from `e.stripe.com`, `e.mailchimp.com`, and
 * `*.luma-mail.com`.
 *
 * Keep these rules simple — substring matches + a few regex. Every false
 * negative leaks noise into Layer 2's context (token cost); every false
 * positive drops a real message (correctness cost). Both are felt directly.
 *
 * Iron rule: if you find yourself adding subtle logic to catch one specific
 * sender, that judgment call belongs one layer up. Layer 2 has the LLM and
 * richer context (subject, snippet, full address). Layer 1 is for the
 * patterns code can decide PERFECTLY.
 */

/** Noise sender substrings. Match against the lowercased from address. */
const NOISE_SENDERS: ReadonlyArray<string> = [
  'noreply@',
  'no-reply@',
  'no.reply@',
  'donotreply@',
  'do-not-reply@',
  'notifications@',
  'notification@',
  'calendar-notification@',
  'mailer-daemon@',
  'postmaster@',
  'bounce@',
  'bounces@',
  'auto-confirm@',
  'mailing@',
  'newsletter@',
];

/**
 * Marketing-subdomain regexes. Match against the full lowercased address.
 *
 * The pattern `@<marketing-prefix>.<brand>.<tld>` is industry-standard for
 * bulk-email senders — a brand routes promotions through a sub-domain so
 * the apex domain's deliverability isn't tarnished. These shapes are
 * essentially never used for human-to-human correspondence.
 *
 * Examples this catches:
 *   updates@e.stripe.com         (e.*)
 *   hello@e.mailchimp.com         (e.*)
 *   support@email.uber.com        (email.*)
 *   reply@em.airbnb.com           (em.*)
 *   noreply@news.medium.com       (news.*)
 *   notifications@notify.lyft.com (notify.*)
 *   billing@updates.paypal.com    (updates.*)
 *   marketing@marketing.shopify.com
 *
 * What this does NOT catch by design (apex-domain marketing):
 *   seattle@axios.com — could be a person, the news org IS the apex
 *   googlecloud@google.com — transactional from a real apex
 * Those are user-specific calls; Layer 2 makes them.
 */
const MARKETING_SUBDOMAIN_RX = /@(?:e|em|email|mail|news|notify|notifications|updates|marketing|promo|promos|broadcast)\.[^.@]+\.[a-z.]{2,}$/i;

/**
 * Email-service apex domains. Substring match against the from address.
 *
 * These domains are dedicated to bulk/transactional sending — anyone using
 * them is sending machine-generated content. Substring rather than exact
 * suffix so subdomains like `user.luma-mail.com` and `em.luma-mail.com`
 * also match.
 */
const NOISE_DOMAINS: ReadonlyArray<string> = [
  '@sendgrid.net',
  '@mailgun.org',
  '@amazonses.com',
  '@mailchimp.com',
  '@mailerlite.com',
  '@constantcontact.com',
  '@customer.io',
  '@klaviyo.com',
  '@loops.so',
  '@convertkit.com',
  '@substack.com',
  // Event/community-tool senders. Real human is in the display name; the
  // mail itself is a templated reminder.
  'luma-mail.com',
  '@meetup.com',
  '@eventbrite.com',
  // Social-platform digests / notifications.
  '@linkedin.com',
  '@e.linkedin.com',
  '@notifications.linkedin.com',
  '@em.linkedin.com',
  '@x.com',
  '@notifications.x.com',
  '@e.x.com',
  '@youtube.com',
  '@youtube-noreply.com',
  '@medium.com',
  '@reply.medium.com',
];

/** Signature-service patterns. Regex match against subject OR from. */
const SIGNATURE_PATTERNS: ReadonlyArray<RegExp> = [
  /docusign/i,
  /dropbox\s*sign/i,
  /hellosign/i,
  /pandadoc/i,
  /adobe\s*sign/i,
  /please\s+sign/i,
  /signature\s+needed/i,
  /signature\s+requested/i,
  /ready\s+for\s+your\s+signature/i,
  /everyone\s+has\s+signed/i,
  /you\s+just\s+signed/i,
  /completed:\s+please\s+(?:sign|review)/i,
];

/** Lowercased substring + regex match against the from address. */
export function isNoise(fromEmail: string): boolean {
  const f = (fromEmail || '').trim().toLowerCase();
  if (!f) return true; // an email with no from is unusable, treat as noise
  if (NOISE_SENDERS.some((p) => f.includes(p))) return true;
  if (NOISE_DOMAINS.some((d) => f.includes(d))) return true;
  if (MARKETING_SUBDOMAIN_RX.test(f)) return true;
  return false;
}

/** Test BOTH subject AND from. Signature requests come from services that
 *  put "docusign" in the sender address, but also from humans whose
 *  subject says "Please sign attached." */
export function isSignature(subject: string, fromEmail: string): boolean {
  const s = subject ?? '';
  const f = fromEmail ?? '';
  return SIGNATURE_PATTERNS.some((p) => p.test(s) || p.test(f));
}
