/**
 * Phase 3 enrich helpers — TS unit tests.
 *
 * Covers extractFmRecordId, pageHasFmId, extractFrontmatter, splitPage.
 * The skill itself (skills/dent/enrich/SKILL.md) is markdown executed by
 * an agent at runtime; behavioral tests on the prompt prose live in
 * skill-contract.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  extractFmRecordId,
  pageHasFmId,
  extractFrontmatter,
  splitPage,
} from '../../../src/dent/enrich/helpers.ts';

const PAGE_WITH_FM = `---
title: Steve Broback
type: person
filemaker_record_id: 12345
updated: 2026-05-01
---

# Steve Broback

## State
- Founder, Dent The Future [Source: FM People #12345]
`;

const PAGE_NO_FM = `---
title: Random Person
type: person
updated: 2026-05-01
---

# Random Person

## State
- Met at a meetup once.
`;

const PAGE_FM_QUOTED = `---
filemaker_record_id: "abc-123-def"
type: person
---

body
`;

const PAGE_FM_SINGLE_QUOTED = `---
filemaker_record_id: 'xyz-789'
type: person
---

body
`;

const PAGE_FM_NULL = `---
filemaker_record_id:
type: person
---

body
`;

const PAGE_NO_FRONTMATTER = `# Just a body

No frontmatter at all here.
`;

describe('extractFmRecordId', () => {
  test('returns the id when present and unquoted', () => {
    expect(extractFmRecordId(PAGE_WITH_FM)).toBe('12345');
  });

  test('strips double quotes', () => {
    expect(extractFmRecordId(PAGE_FM_QUOTED)).toBe('abc-123-def');
  });

  test('strips single quotes', () => {
    expect(extractFmRecordId(PAGE_FM_SINGLE_QUOTED)).toBe('xyz-789');
  });

  test('returns null when key is absent', () => {
    expect(extractFmRecordId(PAGE_NO_FM)).toBeNull();
  });

  test('returns null when value is empty', () => {
    expect(extractFmRecordId(PAGE_FM_NULL)).toBeNull();
  });

  test('returns null when value is YAML null sentinel', () => {
    const page = `---\nfilemaker_record_id: ~\ntype: person\n---\n\nbody\n`;
    expect(extractFmRecordId(page)).toBeNull();
  });

  test('returns null when no frontmatter exists', () => {
    expect(extractFmRecordId(PAGE_NO_FRONTMATTER)).toBeNull();
  });

  test('handles trailing whitespace and inline comments', () => {
    const page = `---\nfilemaker_record_id:   42   # legacy id\ntype: person\n---\nbody\n`;
    expect(extractFmRecordId(page)).toBe('42');
  });
});

describe('pageHasFmId', () => {
  test('true when FM id is present', () => {
    expect(pageHasFmId(PAGE_WITH_FM)).toBe(true);
  });

  test('false when FM id is absent', () => {
    expect(pageHasFmId(PAGE_NO_FM)).toBe(false);
  });

  test('false when no frontmatter at all', () => {
    expect(pageHasFmId(PAGE_NO_FRONTMATTER)).toBe(false);
  });
});

describe('extractFrontmatter', () => {
  test('returns the YAML block between the fences', () => {
    const fm = extractFrontmatter(PAGE_WITH_FM);
    expect(fm).toContain('title: Steve Broback');
    expect(fm).toContain('filemaker_record_id: 12345');
    expect(fm).not.toContain('# Steve Broback'); // body not included
  });

  test('returns null when no frontmatter exists', () => {
    expect(extractFrontmatter(PAGE_NO_FRONTMATTER)).toBeNull();
  });

  test('returns null when only opening fence exists', () => {
    expect(extractFrontmatter('---\ntitle: Half\n')).toBeNull();
  });
});

describe('splitPage', () => {
  test('returns frontmatter + body for fenced page', () => {
    const { frontmatter, body } = splitPage(PAGE_WITH_FM);
    expect(frontmatter).toContain('filemaker_record_id: 12345');
    expect(body).toContain('# Steve Broback');
    expect(body).toContain('## State');
    expect(body).not.toContain('---'); // fences stripped
  });

  test('returns null frontmatter and full content as body when no fences', () => {
    const { frontmatter, body } = splitPage(PAGE_NO_FRONTMATTER);
    expect(frontmatter).toBeNull();
    expect(body).toBe(PAGE_NO_FRONTMATTER);
  });
});
