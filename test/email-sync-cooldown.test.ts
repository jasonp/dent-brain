/**
 * Pins the Gmail 429 cool-down + identity memo (`tools/email-sync/gmail-state.ts`).
 *
 * The failure this exists to prevent: the collector fires on a fixed scheduler
 * interval, and Gmail's per-user 429 window is extended by every call made
 * against it. Without a banked window, each fire probes, gets 429'd, and pushes
 * the retry-after out by another interval — observed in the field as streaks of
 * 3-5 rate-limited fires and 18-30h of stalled ingestion. See
 * `docs/issues/email-sync-429-and-reauth-ux.md`.
 *
 * All pure / temp-dir. No network, no daemon.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
  clearCooldown,
  cooldownRemainingMs,
  emptyGmailState,
  formatDuration,
  loadGmailState,
  needsIdentityProbe,
  recordVerifiedAccount,
  saveGmailState,
  startCooldown,
  tokenFingerprint,
} from '../tools/email-sync/gmail-state.ts';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

describe('cooldownRemainingMs', () => {
  test('no cool-down → 0', () => {
    expect(cooldownRemainingMs(emptyGmailState(), NOW)).toBe(0);
  });
  test('future cool-down → milliseconds left', () => {
    const s = { ...emptyGmailState(), cooldownUntil: '2026-08-11T13:00:00.000Z' };
    expect(cooldownRemainingMs(s, NOW)).toBe(3_600_000);
  });
  test('past cool-down → 0, never negative', () => {
    const s = { ...emptyGmailState(), cooldownUntil: '2026-08-11T11:00:00.000Z' };
    expect(cooldownRemainingMs(s, NOW)).toBe(0);
  });
  test('unparseable timestamp fails OPEN (0), so a corrupt file cannot wedge the daemon', () => {
    const s = { ...emptyGmailState(), cooldownUntil: 'not-a-date' };
    expect(cooldownRemainingMs(s, NOW)).toBe(0);
  });
});

describe('startCooldown', () => {
  test("honors Gmail's own retry-after when it sits inside the clamp", () => {
    const s = startCooldown(emptyGmailState(), '2026-08-11T18:00:00.000Z', NOW, 'the identity probe');
    expect(s.cooldownUntil).toBe('2026-08-11T18:00:00.000Z');
    expect(s.cooldownReason).toBe('the identity probe');
    expect(cooldownRemainingMs(s, NOW)).toBe(6 * 3_600_000);
  });

  test('floors an over-eager retry-after to MIN_COOLDOWN_MS', () => {
    // Gmail occasionally hands back a window seconds away. Honoring that is how
    // you poke a live window and re-extend it — the exact bug.
    const s = startCooldown(emptyGmailState(), '2026-08-11T12:00:30.000Z', NOW, 'a message fetch');
    expect(cooldownRemainingMs(s, NOW)).toBe(MIN_COOLDOWN_MS);
  });

  test('caps an absurd retry-after at MAX_COOLDOWN_MS', () => {
    const s = startCooldown(emptyGmailState(), '2029-01-01T00:00:00.000Z', NOW, 'the message list');
    expect(cooldownRemainingMs(s, NOW)).toBe(MAX_COOLDOWN_MS);
  });

  test('falls back to the default window when Gmail gives no parseable retry-after', () => {
    expect(cooldownRemainingMs(startCooldown(emptyGmailState(), null, NOW, 'x'), NOW))
      .toBe(DEFAULT_COOLDOWN_MS);
    expect(cooldownRemainingMs(startCooldown(emptyGmailState(), 'garbage', NOW, 'x'), NOW))
      .toBe(DEFAULT_COOLDOWN_MS);
  });

  test('preserves the identity memo — a rate-limit is not an auth event', () => {
    const verified = recordVerifiedAccount(emptyGmailState(), 'someone@example.com', 'fp1');
    const s = startCooldown(verified, null, NOW, 'x');
    expect(s.verifiedAccount).toEqual({ email: 'someone@example.com', tokenFingerprint: 'fp1' });
  });
});

describe('clearCooldown', () => {
  test('drops the window but keeps the identity memo', () => {
    const s = clearCooldown(
      startCooldown(recordVerifiedAccount(emptyGmailState(), 'someone@example.com', 'fp1'), null, NOW, 'x'),
    );
    expect(s.cooldownUntil).toBeNull();
    expect(s.cooldownReason).toBeNull();
    expect(s.verifiedAccount?.email).toBe('someone@example.com');
    expect(cooldownRemainingMs(s, NOW)).toBe(0);
  });
});

describe('identity memo (the §A5 probe collapse)', () => {
  test('no memo → must probe', () => {
    expect(needsIdentityProbe(emptyGmailState(), 'fp1')).toBe(true);
  });
  test('memo matching the current tokens → skip the probe', () => {
    const s = recordVerifiedAccount(emptyGmailState(), 'someone@example.com', 'fp1');
    expect(needsIdentityProbe(s, 'fp1')).toBe(false);
  });
  test('tokens changed since the memo (re-auth / account switch) → probe again', () => {
    const s = recordVerifiedAccount(emptyGmailState(), 'someone@example.com', 'fp1');
    expect(needsIdentityProbe(s, 'fp2')).toBe(true);
  });
});

describe('tokenFingerprint', () => {
  test('stable for the same token, different for a different one', () => {
    expect(tokenFingerprint('refresh-abc')).toBe(tokenFingerprint('refresh-abc'));
    expect(tokenFingerprint('refresh-abc')).not.toBe(tokenFingerprint('refresh-xyz'));
  });
  test('never contains the credential itself', () => {
    const secret = 'super-secret-refresh-token';
    expect(tokenFingerprint(secret)).not.toContain(secret);
    expect(tokenFingerprint(secret)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'email-sync-cooldown-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips a full state', () => {
    const path = join(dir, 'gmail-state.json');
    const s = startCooldown(
      recordVerifiedAccount(emptyGmailState(), 'someone@example.com', 'fp1'),
      '2026-08-11T18:00:00.000Z',
      NOW,
      'the identity probe',
    );
    saveGmailState(path, s);
    expect(loadGmailState(path)).toEqual(s);
  });

  test('written owner-only — it carries an account address', () => {
    const path = join(dir, 'gmail-state.json');
    saveGmailState(path, emptyGmailState());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('creates the parent directory when it does not exist', () => {
    const path = join(dir, 'nested', 'deeper', 'gmail-state.json');
    saveGmailState(path, emptyGmailState());
    expect(loadGmailState(path)).toEqual(emptyGmailState());
  });

  test('missing file → empty state, not a throw', () => {
    expect(loadGmailState(join(dir, 'nope.json'))).toEqual(emptyGmailState());
  });

  test('malformed / partial files degrade to empty rather than failing the run', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'not json at all');
    expect(loadGmailState(bad)).toEqual(emptyGmailState());

    const wrongTypes = join(dir, 'wrong.json');
    writeFileSync(wrongTypes, JSON.stringify({ cooldownUntil: 42, verifiedAccount: { email: 1 } }));
    expect(loadGmailState(wrongTypes)).toEqual(emptyGmailState());

    const notObject = join(dir, 'array.json');
    writeFileSync(notObject, '[1,2,3]');
    expect(loadGmailState(notObject)).toEqual(emptyGmailState());
  });

  test('a partial state keeps the fields it does have', () => {
    const path = join(dir, 'partial.json');
    writeFileSync(path, JSON.stringify({ cooldownUntil: '2026-08-11T18:00:00.000Z' }));
    const s = loadGmailState(path);
    expect(s.cooldownUntil).toBe('2026-08-11T18:00:00.000Z');
    expect(s.verifiedAccount).toBeNull();
  });
});

describe('formatDuration', () => {
  test('renders the shapes that show up in the log line', () => {
    expect(formatDuration(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m');
    expect(formatDuration(42 * 60_000)).toBe('42m');
    expect(formatDuration(38_000)).toBe('38s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-1000)).toBe('0s');
  });
});
