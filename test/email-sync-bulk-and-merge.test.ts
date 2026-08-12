/**
 * Pins the two digest-quality fixes:
 *
 * 1. **RFC bulk detection** (`isBulkMail`). The address-pattern rules in
 *    `isNoise` structurally cannot tell a newsletter from `seattle@axios.com`
 *    or `welcome@vendor.example` from a human — the noise-filter's own doc
 *    comment says so. `List-Unsubscribe` / `List-Id` / `Precedence` decide it
 *    from evidence the sender supplied.
 *
 * 2. **Mail-merge collapse.** A same-subject outbound blast to N different
 *    people produced N near-identical digest entries. It now renders as one,
 *    with every Gmail link preserved.
 *
 * Sender shapes below are drawn from a real two-day sample where 5 of 41
 * messages were bulk that reached Triage, and 8 were one mail-merge.
 */

import { describe, expect, test } from 'bun:test';
import { isBulkMail, isNoise } from '../tools/email-sync/noise-filter.ts';
import { buildDigest } from '../tools/email-sync/digest.ts';
import type { CollectedEmail } from '../tools/email-sync/types.ts';

function makeEmail(overrides: Partial<CollectedEmail> = {}): CollectedEmail {
  return {
    messageId: 'msg1',
    threadId: 'thr1',
    date: '2026-08-10T10:00:00.000Z',
    fromEmail: 'someone@example.com',
    fromName: 'Someone',
    recipients: ['me@example.com'],
    subject: 'Hello',
    snippet: 'Hi there',
    gmailLink: 'https://mail.google.com/x',
    isNoise: false,
    isBulk: false,
    isSignature: false,
    isOutbound: false,
    ...overrides,
  };
}

describe('isBulkMail — decides from headers, not address shape', () => {
  test('List-Unsubscribe marks bulk', () => {
    expect(isBulkMail({ listUnsubscribe: '<https://vendor.example/u/1>' })).toBe(true);
  });
  test('List-Id marks bulk (older mailing lists)', () => {
    expect(isBulkMail({ listId: 'Announcements <ann.list.example>' })).toBe(true);
  });
  test('Precedence bulk/list/junk marks bulk, case-insensitively', () => {
    expect(isBulkMail({ precedence: 'bulk' })).toBe(true);
    expect(isBulkMail({ precedence: 'List' })).toBe(true);
    expect(isBulkMail({ precedence: ' JUNK ' })).toBe(true);
  });
  test('no bulk headers → not bulk', () => {
    expect(isBulkMail({})).toBe(false);
    expect(isBulkMail({ listUnsubscribe: '', listId: '   ', precedence: '' })).toBe(false);
  });
  test('Precedence: first-class / normal is not bulk', () => {
    expect(isBulkMail({ precedence: 'first-class' })).toBe(false);
    expect(isBulkMail({ precedence: 'normal' })).toBe(false);
  });

  test('catches the apex-domain newsletters isNoise is documented to miss', () => {
    // These are the exact shapes the noise-filter's doc comment calls out as
    // undecidable from the address — and they were reaching Triage in the field.
    for (const addr of ['seattle@axios.com', 'welcome@vendor.example', 'ken@events.example', 'admin@university.example']) {
      expect(isNoise(addr)).toBe(false); // address alone: looks like a person
      expect(isBulkMail({ listUnsubscribe: '<mailto:unsub@x.example>' })).toBe(true); // headers: obviously bulk
    }
  });

  test('a human reply carries none of these headers', () => {
    expect(isBulkMail({})).toBe(false);
  });
});

describe('digest routing — bulk joins noise, never Triage', () => {
  test('bulk mail is filed under Noise', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      makeEmail({ messageId: 'a', subject: 'Real thread' }),
      makeEmail({ messageId: 'b', subject: 'Monthly Update', isBulk: true }),
    ]);
    expect(d.counts.triage).toBe(1);
    expect(d.counts.noise).toBe(1);
    const [, noiseSection] = d.content.split('## Noise');
    expect(noiseSection).toContain('Monthly Update');
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).toContain('Real thread');
    expect(triageSection).not.toContain('Monthly Update');
  });

  test('a message flagged both noise and bulk is counted once', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      makeEmail({ messageId: 'a', isNoise: true, isBulk: true }),
    ]);
    expect(d.counts.noise).toBe(1);
    expect(d.counts.triage).toBe(0);
  });
});

describe('mail-merge collapse', () => {
  const invite = (id: string, to: string, minute: string) =>
    makeEmail({
      messageId: id,
      subject: 'Hey, see you in Santa Fe?',
      isOutbound: true,
      recipients: [to, 'colleague@example.com'],
      date: `2026-08-10T21:${minute}:00.000Z`,
      gmailLink: `https://mail.google.com/${id}`,
    });

  test('3+ same-subject outbound sends to different people collapse to one entry', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      invite('m1', 'a@example.com', '01'),
      invite('m2', 'b@example.com', '02'),
      invite('m3', 'c@example.com', '03'),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).toContain('3× same send');
    // One rendered entry, not three.
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(1);
    // Every original message stays reachable.
    for (const id of ['m1', 'm2', 'm3']) {
      expect(triageSection).toContain(`gmail/${id}`);
      expect(triageSection).toContain(`https://mail.google.com/${id}`);
    }
    // Recipients are unioned and deduped.
    expect(triageSection).toContain('a@example.com');
    expect(triageSection).toContain('c@example.com');
    expect(triageSection.match(/colleague@example\.com/g)).toHaveLength(1);
  });

  test('the raw message count is preserved, with the collapse recorded', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      invite('m1', 'a@example.com', '01'),
      invite('m2', 'b@example.com', '02'),
      invite('m3', 'c@example.com', '03'),
    ]);
    expect(d.counts.triage).toBe(3); // counts stay message-based for Layer 2
    expect(d.content).toContain('merged_sends: 3');
    expect(d.content).toContain('collapsed into 1 entry');
  });

  test('two sends is ordinary conversation — NOT collapsed', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      invite('m1', 'a@example.com', '01'),
      invite('m2', 'b@example.com', '02'),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).not.toContain('same send');
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(2);
  });

  test('replying 3× to the SAME group is a thread, not a merge — stays expanded', () => {
    const reply = (id: string, minute: string) =>
      makeEmail({
        messageId: id,
        subject: 'Re: Izanami reservation',
        isOutbound: true,
        recipients: ['x@example.com', 'y@example.com'],
        date: `2026-08-10T18:${minute}:00.000Z`,
      });
    const d = buildDigest('me@example.com', '2026-08-10', [
      reply('r1', '01'), reply('r2', '02'), reply('r3', '03'),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).not.toContain('same send');
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(3);
    expect(d.content).toContain('merged_sends: 0');
  });

  test('inbound mail is never collapsed, however repetitive', () => {
    const inbound = (id: string, from: string) =>
      makeEmail({ messageId: id, subject: 'Same subject', fromEmail: from, isOutbound: false });
    const d = buildDigest('me@example.com', '2026-08-10', [
      inbound('i1', 'a@example.com'), inbound('i2', 'b@example.com'), inbound('i3', 'c@example.com'),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).not.toContain('same send');
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(3);
  });

  test('unrelated outbound subjects are not merged with each other', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      invite('m1', 'a@example.com', '01'),
      invite('m2', 'b@example.com', '02'),
      invite('m3', 'c@example.com', '03'),
      makeEmail({ messageId: 'solo', subject: 'Approved', isOutbound: true, date: '2026-08-10T22:00:00.000Z' }),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).toContain('3× same send');
    expect(triageSection).toContain('Approved');
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(2);
  });

  test('empty-subject outbound sends never group with each other', () => {
    // Without a subject there is nothing tying these together — three unrelated
    // no-subject sends are three things, not a blast.
    const blank = (id: string, to: string, minute: string) =>
      makeEmail({
        messageId: id,
        subject: '',
        isOutbound: true,
        recipients: [to],
        date: `2026-08-10T20:${minute}:00.000Z`,
      });
    const d = buildDigest('me@example.com', '2026-08-10', [
      blank('b1', 'a@example.com', '01'),
      blank('b2', 'b@example.com', '02'),
      blank('b3', 'c@example.com', '03'),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection).not.toContain('same send');
    expect(triageSection.match(/- \*\*\d{2}:\d{2}Z\*\*/g)).toHaveLength(3);
    expect(d.content).toContain('merged_sends: 0');
  });

  test('whitespace-only subjects are treated the same as empty', () => {
    const blank = (id: string, to: string, minute: string) =>
      makeEmail({
        messageId: id,
        subject: '   ',
        isOutbound: true,
        recipients: [to],
        date: `2026-08-10T19:${minute}:00.000Z`,
      });
    const d = buildDigest('me@example.com', '2026-08-10', [
      blank('w1', 'a@example.com', '01'),
      blank('w2', 'b@example.com', '02'),
      blank('w3', 'c@example.com', '03'),
    ]);
    expect(d.content).toContain('merged_sends: 0');
  });

  test('entries stay in chronological order after collapsing', () => {
    const d = buildDigest('me@example.com', '2026-08-10', [
      makeEmail({ messageId: 'early', subject: 'Morning note', date: '2026-08-10T09:00:00.000Z' }),
      invite('m1', 'a@example.com', '01'),
      invite('m2', 'b@example.com', '02'),
      invite('m3', 'c@example.com', '03'),
      makeEmail({ messageId: 'late', subject: 'Evening note', date: '2026-08-10T23:00:00.000Z' }),
    ]);
    const triageSection = d.content.split('## Triage')[1].split('## Noise')[0];
    expect(triageSection.indexOf('Morning note')).toBeLessThan(triageSection.indexOf('same send'));
    expect(triageSection.indexOf('same send')).toBeLessThan(triageSection.indexOf('Evening note'));
  });
});
