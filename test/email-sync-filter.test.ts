import { describe, expect, test } from 'bun:test';
import { filter } from '../tools/email-sync/recipe/filter.example.ts';
import type { CollectedEmail } from '../tools/email-sync/types.ts';

/**
 * Pins the v0.39 email-sync example user filter's behavior.
 *
 * The example defaults to excludelist posture with `DROP_NOISE=true` and
 * `DROP_SIGNATURES=false`, no excludes populated. So:
 *   - isNoise emails → dropped
 *   - isSignature emails → kept
 *   - everything else → kept
 *
 * Real teammates customize ~/.dent-brain/email-sync/user/filter.ts.
 */

function makeEmail(overrides: Partial<CollectedEmail> = {}): CollectedEmail {
  return {
    messageId: 'msg1',
    threadId: 'thr1',
    date: '2026-05-01T10:00:00Z',
    fromEmail: 'someone@example.com',
    fromName: 'Someone',
    recipients: ['me@dentthefuture.com'],
    subject: 'Hello',
    snippet: 'Hi there',
    gmailLink: 'https://mail.google.com/x',
    isNoise: false,
    isSignature: false,
    isOutbound: false,
    ...overrides,
  };
}

describe('email-sync example filter — v0.39 default (excludelist, drop noise)', () => {
  test('drops noise-flagged emails', () => {
    const r = filter(makeEmail({ fromEmail: 'noreply@mailchimp.com', isNoise: true }));
    expect(r.keep).toBe(false);
    if (!r.keep) expect(r.reason).toContain('noise');
  });

  test('keeps signature requests (DROP_SIGNATURES=false by default)', () => {
    const r = filter(makeEmail({ isSignature: true, subject: 'Please sign attached' }));
    expect(r.keep).toBe(true);
  });

  test('keeps generic human email when nothing is excluded', () => {
    const r = filter(makeEmail({ fromEmail: 'jeff@dentthefuture.com', subject: 'Q3 status' }));
    expect(r.keep).toBe(true);
  });

  test('returns a reason string for every verdict', () => {
    expect(typeof filter(makeEmail()).reason).toBe('string');
    expect(typeof filter(makeEmail({ isNoise: true })).reason).toBe('string');
  });
});
