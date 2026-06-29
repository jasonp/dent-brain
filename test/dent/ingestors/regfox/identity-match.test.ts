import { describe, test, expect } from 'bun:test';
import {
  classifyNameMatch,
  splitEmail,
  domainRootLabel,
  emailsFromFrontmatter,
  emailsFromMarkdown,
  mergeEmailIntoFrontmatter,
  type NameMatchInput,
} from '../../../../src/dent/ingestors/regfox/identity-match.ts';

const base = (o: Partial<NameMatchInput> = {}): NameMatchInput => ({
  registrantEmail: null,
  firstName: null,
  lastName: null,
  candidateEmails: [],
  hasVariants: false,
  ...o,
});

describe('splitEmail / domainRootLabel', () => {
  test('splits + lowercases; rejects malformed', () => {
    expect(splitEmail('Foo.Bar@Acme.IO')).toEqual({ local: 'foo.bar', domain: 'acme.io' });
    expect(splitEmail('no-at')).toBeNull();
    expect(splitEmail('a@b')).toBeNull(); // no dot in domain
    expect(splitEmail(null)).toBeNull();
  });
  test('root label strips TLD incl. two-level ccSLDs', () => {
    expect(domainRootLabel('mauvais.com')).toBe('mauvais');
    expect(domainRootLabel('theevelyngroup.co.uk')).toBe('theevelyngroup');
  });
});

describe('classifyNameMatch — Tier A (ties new email to the existing page)', () => {
  test('shared custom domain → append', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'contact@theevelyngroup.com', firstName: 'Kristin', lastName: 'Grimm', candidateEmails: ['kristin.grimm@theevelyngroup.com'] }));
    expect(v.decision).toBe('append');
    expect(v.signal).toContain('shared_custom_domain');
  });
  test('shared local-part across providers → append', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'genealogyconsult@utexas.edu', firstName: 'Barbara', lastName: 'Rae-Venter', candidateEmails: ['genealogyconsult@gmail.com'] }));
    expect(v.decision).toBe('append');
    expect(v.signal).toContain('shared_local_part');
  });
  test('shared FREEMAIL domain is NOT a signal', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'newhandle@gmail.com', firstName: 'Pat', lastName: 'Smith', candidateEmails: ['oldhandle@gmail.com'] }));
    expect(v.decision).toBe('pending');
  });
  test('shared ROLE local-part (contact@) is NOT a signal', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'contact@one.io', firstName: 'A', lastName: 'B', candidateEmails: ['contact@two.io'] }));
    expect(v.decision).toBe('pending');
  });
  test('Tier A fires even when same-name variants exist', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'e@truss.works', firstName: 'Everett', lastName: 'Harper', candidateEmails: ['everett@truss.works'], hasVariants: true }));
    expect(v.decision).toBe('append');
  });
});

describe('classifyNameMatch — Tier B (ties new email to the name)', () => {
  test('surname-as-domain → append', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'scott@mauvais.com', firstName: 'Scott', lastName: 'Mauvais' }));
    expect(v.decision).toBe('append');
    expect(v.signal).toContain('surname_domain');
  });
  test('full name encoded in local-part → append', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'david.jones@northwind.io', firstName: 'David', lastName: 'Jones' }));
    expect(v.decision).toBe('append');
    expect(v.signal).toBe('full_name_in_email');
  });
  test('surname + first initial → append', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'jquimby@northwind.io', firstName: 'John', lastName: 'Quimby' }));
    expect(v.decision).toBe('append');
    expect(v.signal).toBe('surname_with_initial');
  });
  test('Tier B is SUPPRESSED when same-name variants exist', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'scott@mauvais.com', firstName: 'Scott', lastName: 'Mauvais', hasVariants: true }));
    expect(v.decision).toBe('pending');
    expect(v.signal).toContain('but_variants');
  });
});

describe('classifyNameMatch — pending fallbacks', () => {
  test('no email → pending', () => {
    expect(classifyNameMatch(base({ firstName: 'A', lastName: 'B' })).signal).toBe('no_email');
  });
  test('unrelated email, no name encoding → pending (the genuinely ambiguous case)', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'boulderbear2@gmail.com', firstName: 'Sara', lastName: 'Sutton', candidateEmails: ['sara@flexjobs.com'] }));
    expect(v.decision).toBe('pending');
    expect(v.signal).toBe('weak_signal');
  });
  test('reserved placeholder domain (example.com) yields no surname signal', () => {
    const v = classifyNameMatch(base({ registrantEmail: 'alice@example.com', firstName: 'Alice', lastName: 'Example' }));
    expect(v.decision).toBe('pending');
  });
  test('short surname is not fuzzy-matched in local-part', () => {
    // "ford" appears inside "crawford" but surname "Lee" (<4) and short tokens
    // must not trigger; here surname "Lee" should not match crawford-style locals.
    const v = classifyNameMatch(base({ registrantEmail: 'crawford@northwind.io', firstName: 'John', lastName: 'Lee' }));
    expect(v.decision).toBe('pending');
  });
});

describe('frontmatter helpers', () => {
  test('emailsFromFrontmatter merges email + emails[], lowercased + deduped', () => {
    expect(emailsFromFrontmatter({ email: 'A@X.com', emails: ['A@X.com', 'B@Y.com'] })).toEqual(['a@x.com', 'b@y.com']);
  });
  test('emailsFromMarkdown parses a real page', () => {
    const md = '---\ntitle: Jane\nemail: jane@acme.io\nemails:\n  - jane@acme.io\n  - jane.personal@gmail.com\n---\n\n# Jane\n';
    expect(emailsFromMarkdown(md).sort()).toEqual(['jane.personal@gmail.com', 'jane@acme.io']);
  });
  test('mergeEmailIntoFrontmatter adds a new address', () => {
    const md = '---\ntitle: Jane\nemail: jane@acme.io\n---\n\n# Jane\n\n## Timeline\n\n- a\n';
    const out = mergeEmailIntoFrontmatter(md, 'Jane.New@Other.com');
    expect(emailsFromMarkdown(out)).toContain('jane.new@other.com');
    expect(out).toContain('# Jane'); // body preserved
  });
  test('mergeEmailIntoFrontmatter is idempotent (already-known email)', () => {
    const md = '---\ntitle: Jane\nemails:\n  - jane@acme.io\n---\n\n# Jane\n';
    expect(mergeEmailIntoFrontmatter(md, 'jane@acme.io')).toBe(md);
  });
});
