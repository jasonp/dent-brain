# email-sync recipe — `user/filter.ts` contract

This file is read by the **local Claude** the teammate runs on their laptop during `/dent-extensions setup email-sync`. It is the contract between the daemon (canonical, shipped by the plugin) and the user filter (bespoke, generated per teammate).

`RECIPE_VERSION = 1`. Bump only when this contract changes.

## The contract

`~/.dent-brain/email-sync/user/filter.ts` must export:

```typescript
import type { CollectedEmail, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

export function filter(email: CollectedEmail): FilterResult {
  // ... your logic
  return { keep: true, reason: 'why' };
  // or
  return { keep: false, reason: 'why' };
}
```

The daemon imports this module at startup. The filter is called **after** the canonical `isNoise()` and `isSignature()` classifiers — both flags are already populated on the input — and **before** grouping emails into daily digests. Only `keep: true` emails reach the digest and the shared brain.

`reason` is logged in dry-run and verbose runs so the teammate can audit decisions. Write reasons humans can read at a glance.

## Iron rules

1. **Pure function.** No network, no fs, no env reads, no side effects.
2. **Privacy bias: exclude by default.** When ambiguous, return `keep: false`. Work inboxes often carry personal threads (banking, doctor, family), and the work-email scope alone doesn't separate them.
3. **Don't re-implement noise filtering.** The canonical `noise-filter.ts` (Mailchimp, SendGrid, noreply@, etc.) runs first; `email.isNoise === true` tells you the sender already matched. Defer to it unless you have a specific reason to keep a noise-flagged sender.
4. **No third-party logging.** Don't `console.log` PII from the email. The daemon's verbose mode logs subject + from for each decision — that's enough audit trail.

## What's in `CollectedEmail`

See `../types.ts` for the full shape. Fields the filter typically uses:

- `email.fromEmail` — bare from address, e.g. `phil@example.com`.
- `email.fromName` — display name when present (often null).
- `email.recipients: string[]` — To + Cc + Bcc, bare addresses.
- `email.subject` — trimmed subject line.
- `email.snippet` — ~250-char body preview. Be cautious about matching against this (it can change between Gmail revisions).
- `email.isNoise` — canonical "this looks like bulk/automation."
- `email.isSignature` — canonical "this is a Docusign-style signature request."
- `email.isOutbound` — true when the work-email-holder sent the message (vs received).
- `email.date` — ISO timestamp.

## Two postures to choose between

The example filter ships both — pick one for your `user/filter.ts` by setting `POSTURE`.

### Excludelist (default-keep, drop specific things)

Use when most of your work-inbox traffic is genuinely work, and you want to surgically remove the few categories of personal/noise you don't want in the brain.

```typescript
const EXCLUDE_SENDER_DOMAINS = ['my-bank.com', 'therapist-office.example'];
const EXCLUDE_SENDERS = ['family-member@example.com'];
const EXCLUDE_SUBJECT_PATTERNS = [/amazon.*order/i, /\bvenmo\b/i];

export function filter(email) {
  if (email.isNoise) return { keep: false, reason: 'noise' };
  if (EXCLUDE_SENDER_DOMAINS.includes(senderDomain(email.fromEmail))) {
    return { keep: false, reason: 'excluded domain' };
  }
  // ... etc
  return { keep: true, reason: 'no excludes matched' };
}
```

### Allowlist (default-drop, keep only matching things)

Use when your work-inbox has substantial personal traffic, or when "exclude everything I might forget" matters more than "catch everything work-related." Stricter — false-negatives are possible but no personal leakage.

```typescript
const ALLOWED_SENDER_DOMAINS = ['dentthefuture.com', 'known-investor.com'];
const ALLOWED_SENDERS = ['specific-person@example.com'];

export function filter(email) {
  if (ALLOWED_SENDER_DOMAINS.includes(senderDomain(email.fromEmail))) {
    return { keep: true, reason: 'allowlisted domain' };
  }
  if (ALLOWED_SENDERS.includes(email.fromEmail.toLowerCase())) {
    return { keep: true, reason: 'allowlisted sender' };
  }
  return { keep: false, reason: 'allowlist: no match' };
}
```

The setup skill should walk the teammate through a sample of recent senders and help them decide which posture fits, then build the appropriate lists from the sample.

## Future extensions (v0.40+)

- **Gmail label gating**: today the filter sees only the fields above; v0.40 will populate `email.labels: string[]` so you can gate on `email.labels.includes('Dent')`. Out of scope for v0.39 to keep the contract minimal.

## When this contract changes

`SUPPORTED_RECIPE_VERSION` in `collect.ts` will be bumped and a migration note will land in `skills/migrations/`. The daemon WARNs on version mismatch but doesn't refuse to run — your old filter keeps working until you re-run setup.
