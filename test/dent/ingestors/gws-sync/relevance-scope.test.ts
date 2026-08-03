/**
 * Pure relevance-scope filter tests: is this file OURS (owned by us, our domain,
 * a named collaborator, or a shared drive) vs merely shared with us by an
 * outsider. The regression this gate exists for: a friend's league roster
 * shared with the crawl identity passed share-scope and earned a pointer-card.
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldIncludeByRelevanceScope,
  relevanceScopeActive,
  buildRelevanceScope,
  parseDomainSet,
  parseIdSet,
  type RelevanceScopeConfig,
} from '../../../../src/dent/ingestors/gws-sync/relevance-scope.ts';
import { MIME_DOC, type DriveFile } from '../../../../src/dent/ingestors/gws-sync/types.ts';

const cfg: RelevanceScopeConfig = {
  ownerDomains: new Set(['dentthefuture.com']),
  ownerEmails: new Set(['jason@jrpreston.com', 'chris@growthteam.co']),
  driveIds: new Set(),
};

const owned = (email: string | undefined, extra: Partial<DriveFile> = {}): DriveFile => ({
  id: 'F',
  name: 'Doc',
  mimeType: MIME_DOC,
  owners: email ? [{ emailAddress: email }] : undefined,
  ...extra,
});

describe('relevanceScopeActive', () => {
  test('off when no owner rules configured', () => {
    expect(relevanceScopeActive(undefined)).toBe(false);
    expect(
      relevanceScopeActive({ ownerDomains: new Set(), ownerEmails: new Set(), driveIds: new Set() }),
    ).toBe(false);
    expect(relevanceScopeActive(cfg)).toBe(true);
  });

  test('driveIds alone does NOT activate — it only narrows the shared-drive branch', () => {
    // Activating on driveIds alone would exclude every My Drive file with no
    // owner rule to save it, i.e. prune essentially the whole corpus.
    expect(
      relevanceScopeActive({ ownerDomains: new Set(), ownerEmails: new Set(), driveIds: new Set(['D1']) }),
    ).toBe(false);
  });
});

describe('parseDomainSet', () => {
  test('splits, trims, lowercases, strips a leading @ or full address', () => {
    expect(parseDomainSet('Example.com, @Other.com  user@Third.com')).toEqual(
      new Set(['example.com', 'other.com', 'third.com']),
    );
    expect(parseDomainSet('')).toEqual(new Set());
    expect(parseDomainSet(undefined)).toEqual(new Set());
  });
});

describe('parseIdSet', () => {
  test('preserves case — Drive ids are case-sensitive', () => {
    expect(parseIdSet('0ABcDeF, 0XyZ')).toEqual(new Set(['0ABcDeF', '0XyZ']));
    expect(parseIdSet(undefined)).toEqual(new Set());
  });
});

describe('buildRelevanceScope — the activation rule', () => {
  const SELF = new Set(['jason@dentthefuture.com', 'jason@jrpreston.com']);

  test('THE FOOTGUN: selfEmails alone must NOT activate the gate', () => {
    // GWS_SYNC_SELF_EMAILS is already set in every deployed brain. If it
    // activated the gate, a routine deploy would silently prune every card
    // owned by a teammate (~465 of 930 in the dent corpus).
    expect(buildRelevanceScope({}, SELF)).toBeUndefined();
    expect(buildRelevanceScope({ ownerDomains: '', collaboratorEmails: '' }, SELF)).toBeUndefined();
  });

  test('includeDriveIds alone must NOT activate the gate either', () => {
    expect(buildRelevanceScope({ includeDriveIds: 'D1,D2' }, SELF)).toBeUndefined();
  });

  test('ownerDomains activates it', () => {
    const cfg = buildRelevanceScope({ ownerDomains: 'dentthefuture.com' }, SELF);
    expect(cfg).toBeDefined();
    expect(cfg!.ownerDomains).toEqual(new Set(['dentthefuture.com']));
  });

  test('collaboratorEmails alone activates it', () => {
    const cfg = buildRelevanceScope({ collaboratorEmails: 'chris@growthteam.co' }, SELF);
    expect(cfg).toBeDefined();
    expect(cfg!.ownerDomains.size).toBe(0);
    expect(cfg!.ownerEmails.has('chris@growthteam.co')).toBe(true);
  });

  test('once active, selfEmails still contribute to ownerEmails', () => {
    // Otherwise an owner-domains-only config would prune docs you own on a
    // personal domain (jason@jrpreston.com owns 133 cards in the dent corpus).
    const cfg = buildRelevanceScope({ ownerDomains: 'dentthefuture.com' }, SELF);
    expect(cfg!.ownerEmails.has('jason@jrpreston.com')).toBe(true);
    expect(cfg!.ownerEmails.has('jason@dentthefuture.com')).toBe(true);
  });

  test('drive ids pass through case-preserved; absent means all shared drives', () => {
    expect(buildRelevanceScope({ ownerDomains: 'x.com', includeDriveIds: '0ABcD' }, SELF)!.driveIds)
      .toEqual(new Set(['0ABcD']));
    expect(buildRelevanceScope({ ownerDomains: 'x.com' }, SELF)!.driveIds.size).toBe(0);
  });

  test('an activated config is always relevanceScopeActive', () => {
    expect(relevanceScopeActive(buildRelevanceScope({ ownerDomains: 'x.com' }, new Set()))).toBe(true);
    expect(relevanceScopeActive(buildRelevanceScope({ collaboratorEmails: 'a@b.co' }, new Set()))).toBe(true);
  });
});

describe('shouldIncludeByRelevanceScope', () => {
  test('owner on our domain → include', () => {
    expect(shouldIncludeByRelevanceScope(owned('steve@dentthefuture.com'), cfg)).toBe(true);
  });

  test('owner is one of our own listed accounts → include', () => {
    expect(shouldIncludeByRelevanceScope(owned('jason@jrpreston.com'), cfg)).toBe(true);
  });

  test('owner is a named collaborator → include', () => {
    expect(shouldIncludeByRelevanceScope(owned('chris@growthteam.co'), cfg)).toBe(true);
  });

  test('THE REGRESSION: outsider-owned file shared with us → exclude', () => {
    expect(shouldIncludeByRelevanceScope(owned('adamsherr98118@gmail.com'), cfg)).toBe(false);
  });

  test('case-insensitive on the owner address', () => {
    expect(shouldIncludeByRelevanceScope(owned('Steve@DentTheFuture.COM'), cfg)).toBe(true);
    expect(shouldIncludeByRelevanceScope(owned('  jason@JRPreston.com '), cfg)).toBe(true);
  });

  test('a lookalike domain does not match by suffix', () => {
    // Substring/suffix matching would let notdentthefuture.com through.
    expect(shouldIncludeByRelevanceScope(owned('x@notdentthefuture.com'), cfg)).toBe(false);
    expect(shouldIncludeByRelevanceScope(owned('x@dentthefuture.com.evil.co'), cfg)).toBe(false);
  });

  test('no owner and not a shared drive → exclude (fail closed)', () => {
    expect(shouldIncludeByRelevanceScope(owned(undefined), cfg)).toBe(false);
    expect(shouldIncludeByRelevanceScope(owned(''), cfg)).toBe(false);
  });

  test('malformed owner address → exclude (fail closed)', () => {
    expect(shouldIncludeByRelevanceScope(owned('not-an-email'), cfg)).toBe(false);
    expect(shouldIncludeByRelevanceScope(owned('trailing@'), cfg)).toBe(false);
  });

  test('shared drive → include regardless of owner, when driveIds is empty', () => {
    expect(shouldIncludeByRelevanceScope(owned('stranger@gmail.com', { driveId: 'D1' }), cfg)).toBe(true);
    expect(shouldIncludeByRelevanceScope(owned(undefined, { driveId: 'D1' }), cfg)).toBe(true);
  });

  test('shared drive → allowlisted when driveIds is non-empty', () => {
    const narrowed: RelevanceScopeConfig = { ...cfg, driveIds: new Set(['D1']) };
    expect(shouldIncludeByRelevanceScope(owned('stranger@gmail.com', { driveId: 'D1' }), narrowed)).toBe(true);
    expect(shouldIncludeByRelevanceScope(owned('stranger@gmail.com', { driveId: 'D2' }), narrowed)).toBe(false);
    // An allowlisted drive wins even when the owner would fail the owner rules.
    expect(shouldIncludeByRelevanceScope(owned('x@notours.com', { driveId: 'D1' }), narrowed)).toBe(true);
  });

  test('only the FIRST owner is consulted (Drive returns the primary owner first)', () => {
    const f: DriveFile = {
      id: 'F',
      name: 'Doc',
      mimeType: MIME_DOC,
      owners: [{ emailAddress: 'stranger@gmail.com' }, { emailAddress: 'steve@dentthefuture.com' }],
    };
    expect(shouldIncludeByRelevanceScope(f, cfg)).toBe(false);
  });
});
