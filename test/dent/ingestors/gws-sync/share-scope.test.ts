/**
 * Pure share-scope filter tests: who gets a pointer-card vs who's excluded.
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldIncludeByShareScope,
  shareScopeActive,
  parseEmailSet,
  type ShareScopeConfig,
} from '../../../../src/dent/ingestors/gws-sync/share-scope.ts';
import { MIME_DOC, type DriveFile } from '../../../../src/dent/ingestors/gws-sync/types.ts';

const cfg: ShareScopeConfig = {
  selfEmails: new Set(['jason@dentthefuture.com', 'jason@jrpreston.com']),
  excludePairEmails: new Set(['steve@dentthefuture.com']),
};

type Perm = { emailAddress?: string; type?: string; deleted?: boolean; expirationTime?: string };
const perm = (email: string, type = 'user'): Perm => ({ emailAddress: email, type });
const file = (perms: Perm[], extra: Partial<DriveFile> = {}): DriveFile => ({
  id: 'F',
  name: 'Doc',
  mimeType: MIME_DOC,
  owners: [{ emailAddress: 'jason@dentthefuture.com' }],
  permissions: perms,
  ...extra,
});

describe('shareScopeActive', () => {
  test('off when no self emails configured', () => {
    expect(shareScopeActive(undefined)).toBe(false);
    expect(shareScopeActive({ selfEmails: new Set(), excludePairEmails: new Set() })).toBe(false);
    expect(shareScopeActive(cfg)).toBe(true);
  });
});

describe('parseEmailSet', () => {
  test('splits, trims, lowercases', () => {
    expect(parseEmailSet('A@x.com, b@Y.com  c@z.com')).toEqual(new Set(['a@x.com', 'b@y.com', 'c@z.com']));
    expect(parseEmailSet('')).toEqual(new Set());
    expect(parseEmailSet(undefined)).toEqual(new Set());
  });
});

describe('shouldIncludeByShareScope', () => {
  test('shared drive → include (no permission check)', () => {
    expect(shouldIncludeByShareScope(file([], { driveId: 'D1' }), cfg)).toBe(true);
  });

  test('unreadable sharing (no permissions) → exclude (fail closed)', () => {
    expect(shouldIncludeByShareScope(file([]), cfg)).toBe(false);
  });

  test('group/domain/anyone grant → include (broad)', () => {
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), { type: 'domain' }]), cfg)).toBe(true);
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), { type: 'anyone' }]), cfg)).toBe(true);
  });

  test('private to you (only self) → exclude', () => {
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com')]), cfg)).toBe(false);
  });

  test('you + your own alt account only → exclude', () => {
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), perm('jason@jrpreston.com')]), cfg)).toBe(false);
  });

  test('you + Steve only → exclude', () => {
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), perm('steve@dentthefuture.com')]), cfg)).toBe(false);
  });

  test('you + Steve + a third party → include', () => {
    expect(
      shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), perm('steve@dentthefuture.com'), perm('jeff@dentthefuture.com')]), cfg),
    ).toBe(true);
  });

  test('you + a non-excluded teammate → include', () => {
    expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), perm('jeff@dentthefuture.com')]), cfg)).toBe(true);
  });

  test('case-insensitive on grantee emails', () => {
    expect(shouldIncludeByShareScope(file([perm('Jason@DentTheFuture.com'), perm('STEVE@dentthefuture.com')]), cfg)).toBe(false);
  });

  test('shared with you by others (owner is a real third party) → include', () => {
    const f = file([perm('jason@dentthefuture.com')], { owners: [{ emailAddress: 'bob@dentthefuture.com' }] });
    expect(shouldIncludeByShareScope(f, cfg)).toBe(true); // owner bob counts as another principal
  });

  // --- hardening: stale/expired/unknown grants must not leak a private doc ---
  const NOW = Date.parse('2026-06-26T12:00:00Z');

  test('a deleted grantee account is ignored (does not make a private doc look shared)', () => {
    const f = file([perm('jason@dentthefuture.com'), { emailAddress: 'ghost@x.com', type: 'user', deleted: true }]);
    expect(shouldIncludeByShareScope(f, cfg, NOW)).toBe(false);
  });

  test('an expired grant is ignored; an unexpired one counts', () => {
    const expired = file([perm('jason@dentthefuture.com'), { emailAddress: 'temp@x.com', type: 'user', expirationTime: '2020-01-01T00:00:00Z' }]);
    expect(shouldIncludeByShareScope(expired, cfg, NOW)).toBe(false);
    const live = file([perm('jason@dentthefuture.com'), { emailAddress: 'temp@x.com', type: 'user', expirationTime: '2099-01-01T00:00:00Z' }]);
    expect(shouldIncludeByShareScope(live, cfg, NOW)).toBe(true);
  });

  test('an unknown permission type does NOT force-include (no leak via odd type)', () => {
    const f = file([perm('jason@dentthefuture.com'), { type: 'weird-future-type', emailAddress: 'x@y.com' }]);
    expect(shouldIncludeByShareScope(f, cfg, NOW)).toBe(false); // unknown type skipped, only self left
  });

  test('explicit broad grants (group/domain/anyone) still include', () => {
    for (const type of ['group', 'domain', 'anyone']) {
      expect(shouldIncludeByShareScope(file([perm('jason@dentthefuture.com'), { type }]), cfg, NOW)).toBe(true);
    }
  });
});
