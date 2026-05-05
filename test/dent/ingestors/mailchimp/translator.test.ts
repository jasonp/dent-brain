/**
 * Pure translator + CSV-parser tests. No DB, no network, no fixtures
 * beyond what Mailchimp actually emits.
 */

import { describe, test, expect } from 'bun:test';
import { translateMember } from '../../../../src/dent/ingestors/mailchimp/translator.ts';
import { parseCsv, parseMailchimpTags, isoDateOf } from '../../../../src/dent/ingestors/mailchimp/csv-parser.ts';
import type { MailchimpMember } from '../../../../src/dent/ingestors/mailchimp/types.ts';

const baseMember = (overrides: Partial<MailchimpMember> = {}): MailchimpMember => ({
  email: 'alice@example.com',
  euid: 'abc123',
  status: 'subscribed',
  optinDate: '2024-05-15',
  firstName: 'Alice',
  lastName: 'Example',
  tags: [],
  rowIndex: 0,
  sourceFile: 'subscribed_email_audience_export.csv',
  ...overrides,
});

describe('translateMember', () => {
  test('subscribed: status bullet + name slug + sourceRef', () => {
    const t = translateMember(baseMember());
    expect(t.email).toBe('alice@example.com');
    expect(t.fullName).toBe('Alice Example');
    expect(t.proposedSlug).toBe('alice-example');
    expect(t.isoDate).toBe('2024-05-15');
    expect(t.sourceRef).toBe('mailchimp/abc123');
    expect(t.bullets).toHaveLength(1);
    expect(t.bullets[0]).toContain('Subscribed to Mailchimp list');
    expect(t.bullets[0]).toContain('[Source: mailchimp/abc123]');
  });

  test('unsubscribed: includes campaign + reason', () => {
    const t = translateMember(baseMember({
      status: 'unsubscribed',
      unsubDate: '2025-06-10',
      unsubCampaignTitle: 'Dent 2026 Save the Date',
      unsubReason: 'Too many emails',
    }));
    expect(t.isoDate).toBe('2025-06-10');
    expect(t.bullets[0]).toContain('Unsubscribed from Mailchimp list');
    expect(t.bullets[0]).toContain('Dent 2026 Save the Date');
    expect(t.bullets[0]).toContain('Too many emails');
  });

  test('cleaned: bounce/clean wording with campaign', () => {
    const t = translateMember(baseMember({
      status: 'cleaned',
      cleanDate: '2025-04-25',
      cleanCampaignTitle: 'Unlock Collective Genius',
    }));
    expect(t.isoDate).toBe('2025-04-25');
    expect(t.bullets[0]).toContain('Mailchimp list-cleaned');
    expect(t.bullets[0]).toContain('Unlock Collective Genius');
  });

  test('tags bullet emitted when tags present', () => {
    const t = translateMember(baseMember({ tags: ['2025_SF_Approveds', 'DentAI_SEA_24_Attended'] }));
    expect(t.bullets).toHaveLength(2);
    expect(t.bullets[1]).toContain('Mailchimp tags: 2025_SF_Approveds, DentAI_SEA_24_Attended');
  });

  test('profile bullet emitted when org/title/location present', () => {
    const t = translateMember(baseMember({
      organization: 'Ten Adams',
      title: 'Chief Innovation Officer',
      city: 'Evansville',
      state: 'IN',
      country: 'US',
      linkedinUrl: 'https://www.linkedin.com/in/alice',
    }));
    expect(t.bullets).toHaveLength(2);
    expect(t.bullets[1]).toContain('Mailchimp profile');
    expect(t.bullets[1]).toContain('Organization: Ten Adams');
    expect(t.bullets[1]).toContain('Title: Chief Innovation Officer');
    expect(t.bullets[1]).toContain('Location: Evansville, IN, US');
    expect(t.bullets[1]).toContain('LinkedIn:');
  });

  test('emitTagsBullet=false suppresses tags bullet', () => {
    const t = translateMember(baseMember({ tags: ['x'] }), { emitTagsBullet: false });
    expect(t.bullets.every((b) => !b.includes('Mailchimp tags'))).toBe(true);
  });

  test('falls back to email-local-part slug when no name', () => {
    const t = translateMember(baseMember({ firstName: undefined, lastName: undefined }));
    expect(t.fullName).toBeNull();
    expect(t.proposedSlug).toBe('alice');
  });

  test('stub frontmatter has mailchimp_euid + email', () => {
    const t = translateMember(baseMember());
    expect(t.stubFrontmatter.mailchimp_euid).toBe('abc123');
    expect(t.stubFrontmatter.email).toBe('alice@example.com');
    expect(t.stubFrontmatter.created_via).toBe('mailchimp-ingestor');
  });

  test('stub goes to entities/audience/ (NOT entities/people/) with audience_only flag', () => {
    const t = translateMember(baseMember());
    expect(t.stubFrontmatter.slug).toBe('entities/audience/alice-example');
    expect(t.stubFrontmatter.type).toBe('audience-member');
    expect(t.stubFrontmatter.audience_only).toBe(true);
  });

  test('stub body bakes bullets into Timeline', () => {
    const t = translateMember(baseMember({ tags: ['tag-a'] }));
    expect(t.stubBody).toContain('## Timeline');
    expect(t.stubBody).toContain(t.bullets[0]);
    expect(t.stubBody).toContain(t.bullets[1]);
  });

  test('nonsubscribed status produces a contact-only bullet', () => {
    const t = translateMember(baseMember({ status: 'nonsubscribed' }));
    expect(t.bullets[0]).toContain('non-subscribed');
  });
});

describe('parseMailchimpTags', () => {
  test('splits the canonical "a","b" shape', () => {
    expect(parseMailchimpTags('"2025_SF","DentAI_SEA_24"')).toEqual(['2025_SF', 'DentAI_SEA_24']);
  });
  test('handles plain comma-separated fallback', () => {
    expect(parseMailchimpTags('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  test('drops empties + dedups', () => {
    expect(parseMailchimpTags('"a",,"a","b"')).toEqual(['a', 'b']);
  });
  test('empty input → empty array', () => {
    expect(parseMailchimpTags('')).toEqual([]);
    expect(parseMailchimpTags('   ')).toEqual([]);
  });
});

describe('isoDateOf', () => {
  test('extracts YYYY-MM-DD prefix', () => {
    expect(isoDateOf('2024-05-15 13:11:30')).toBe('2024-05-15');
  });
  test('handles slash-separated dates', () => {
    expect(isoDateOf('2024/05/15')).toBe('2024-05-15');
  });
  test('returns undefined on empty/garbage', () => {
    expect(isoDateOf('')).toBeUndefined();
    expect(isoDateOf(undefined)).toBeUndefined();
    expect(isoDateOf('not a date')).toBeUndefined();
  });
});

describe('parseCsv', () => {
  test('handles quoted fields with embedded commas', () => {
    const src = 'a,b,c\n1,"x,y",3\n';
    const { headers, rows } = parseCsv(src);
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ a: '1', b: 'x,y', c: '3' });
  });

  test('handles escaped double quotes ("")', () => {
    const src = 'a,b\n1,"he said ""hi"""\n';
    const { rows } = parseCsv(src);
    expect(rows[0].b).toBe('he said "hi"');
  });

  test('handles BOM prefix', () => {
    const src = '﻿a,b\n1,2\n';
    const { headers } = parseCsv(src);
    expect(headers).toEqual(['a', 'b']);
  });

  test('skips empty trailing lines', () => {
    const src = 'a\n1\n\n';
    const { rows } = parseCsv(src);
    expect(rows).toEqual([{ a: '1' }]);
  });
});
