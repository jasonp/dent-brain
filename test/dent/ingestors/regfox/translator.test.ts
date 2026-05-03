/**
 * Pure translator tests. No DB, no network, no fixtures beyond what
 * RegFox would actually emit.
 */

import { describe, test, expect } from 'bun:test';
import { translateRegistrant, normalizeEmail, kebabize } from '../../../../src/dent/ingestors/regfox/translator.ts';
import type { RegfoxRegistrant } from '../../../../src/dent/ingestors/regfox/types.ts';

const baseRegistrant = (overrides: Partial<RegfoxRegistrant> = {}): RegfoxRegistrant => ({
  id: 12345,
  formId: 1440,
  formName: 'Dent 2026',
  orderEmail: 'alice@example.com',
  status: 'completed',
  total: '1495.00',
  currency: 'USD',
  dateCreated: '2026-04-22T15:00:00Z',
  billing: { firstName: 'Alice', lastName: 'Example' },
  ...overrides,
});

describe('normalizeEmail', () => {
  test('lowercases + trims', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });
  test('rejects empty / non-string', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42 as unknown as string)).toBeNull();
  });
  test('rejects strings without @ or .', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});

describe('kebabize', () => {
  test('basic kebab', () => {
    expect(kebabize('Alice Example')).toBe('alice-example');
  });
  test('strips diacritics', () => {
    expect(kebabize('Mike Coté')).toBe('mike-cote');
  });
  test('collapses runs of non-alphanumerics', () => {
    expect(kebabize("O'Brien-Smith Jr.")).toBe('o-brien-smith-jr');
  });
  test('trims hyphens', () => {
    expect(kebabize('---hello---')).toBe('hello');
  });
});

describe('translateRegistrant', () => {
  test('happy path: email + name + price', () => {
    const t = translateRegistrant(baseRegistrant());
    expect(t.email).toBe('alice@example.com');
    expect(t.fullName).toBe('Alice Example');
    expect(t.proposedSlug).toBe('alice-example');
    expect(t.isoDate).toBe('2026-04-22');
    expect(t.bullet).toContain('Registered for Dent 2026');
    expect(t.bullet).toContain('$1495.00 USD');
    expect(t.bullet).toContain('[Source: regfox/1440/12345]');
    expect(t.bullet).toMatch(/^- \*\*2026-04-22\*\* \|/);
  });

  test('discount code surfaces from fieldData via best-effort path search', () => {
    const t = translateRegistrant(
      baseRegistrant({ fieldData: { coupon_code: 'EARLYBIRD' } }),
    );
    expect(t.bullet).toContain('with discount code EARLYBIRD');
  });

  test('discount code via custom path override wins', () => {
    const t = translateRegistrant(
      baseRegistrant({ fieldData: { promo: { code: 'VIP' }, coupon_code: 'IGNORED' } }),
      { discountFieldPath: 'promo.code' },
    );
    expect(t.bullet).toContain('with discount code VIP');
    expect(t.bullet).not.toContain('IGNORED');
  });

  test('no discount = no clause', () => {
    const t = translateRegistrant(baseRegistrant({ fieldData: {} }));
    expect(t.bullet).not.toContain('discount');
  });

  test('formats numeric total correctly', () => {
    const t = translateRegistrant(baseRegistrant({ total: 250, currency: 'usd' }));
    expect(t.bullet).toContain('$250.00 USD');
  });

  test('falls back to today if dateCreated is missing', () => {
    const t = translateRegistrant(baseRegistrant({ dateCreated: undefined }));
    expect(t.isoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('slug derived from email when no name', () => {
    const t = translateRegistrant(
      baseRegistrant({ billing: {}, orderEmail: 'lone-wolf@example.com' }),
    );
    expect(t.proposedSlug).toBe('lone-wolf');
    expect(t.fullName).toBeNull();
  });

  test('stub frontmatter has all expected keys', () => {
    const t = translateRegistrant(baseRegistrant());
    expect(t.stubFrontmatter.title).toBe('Alice Example');
    expect(t.stubFrontmatter.slug).toBe('entities/people/alice-example');
    expect(t.stubFrontmatter.type).toBe('person');
    expect(t.stubFrontmatter.email).toBe('alice@example.com');
    expect(t.stubFrontmatter.regfox_registrant_id).toBe(12345);
    expect(t.stubFrontmatter.regfox_form_id).toBe(1440);
    expect(t.stubFrontmatter.created_via).toBe('regfox-ingestor');
  });

  test('stub body contains the bullet under ## Timeline', () => {
    const t = translateRegistrant(baseRegistrant());
    expect(t.stubBody).toContain('## Timeline');
    expect(t.stubBody).toContain(t.bullet);
  });

  test('handles fullName when first/last missing', () => {
    const t = translateRegistrant(
      baseRegistrant({ billing: { fullName: 'Bob Singleton' } }),
    );
    expect(t.fullName).toBe('Bob Singleton');
    expect(t.proposedSlug).toBe('bob-singleton');
  });

  test('email is lowercased even when RegFox returns mixed-case', () => {
    const t = translateRegistrant(baseRegistrant({ orderEmail: 'Alice@EXAMPLE.com' }));
    expect(t.email).toBe('alice@example.com');
  });

  test('non-ASCII names are slug-safe', () => {
    const t = translateRegistrant(
      baseRegistrant({ billing: { firstName: 'Mike', lastName: 'Coté' } }),
    );
    expect(t.proposedSlug).toBe('mike-cote');
  });
});
