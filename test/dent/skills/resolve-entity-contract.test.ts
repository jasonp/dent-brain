/**
 * Phase 4 — /dent-resolve-entity skill contract tests.
 *
 * Pins the disambiguation protocol in
 * skills/dent/resolve-entity/SKILL.md.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let body: string;
let lower: string;

beforeAll(() => {
  const path = join(import.meta.dir, '..', '..', '..', 'skills', 'dent', 'resolve-entity', 'SKILL.md');
  body = readFileSync(path, 'utf8');
  lower = body.toLowerCase();
});

describe('resolve-entity skill contract', () => {
  test('frontmatter declares fm_find_records and put_page', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    expect(fm).toContain('fm_find_records');
    expect(fm).toContain('put_page');
  });

  test('re-fetches candidates fresh', () => {
    expect(lower).toMatch(/re.?fetch|step 1[^\n]*candidates/);
  });

  test('handles ambiguity-resolved-itself case', () => {
    expect(lower).toMatch(/0 or 1 record|self/);
  });

  test('user picks from numbered list with explicit "none" and "skip" options', () => {
    expect(lower).toContain('none of these');
    expect(lower).toMatch(/skip|leave.*unresolved/);
  });

  test('writes filemaker_record_id when user picks an FM candidate', () => {
    expect(lower).toContain('filemaker_record_id');
    expect(lower).toContain('put_page');
  });

  test('slug collision handling', () => {
    expect(lower).toMatch(/slug collision|already exists|disambiguator/);
  });

  test('does NOT write to FM (read-only contract preserved)', () => {
    expect(lower).toMatch(/do not write to.*fm|fm stays read.?only|read.?only in mvp/);
  });

  test('does NOT auto-pick from context', () => {
    expect(lower).toMatch(/do not auto.?pick|human disambiguation/);
  });

  test('does NOT auto-invoke /dent-enrich after creating the page', () => {
    expect(lower).toMatch(/do not call.*enrich|run enrich later/);
  });

  test('returns the slug to the caller for resumed evidence write', () => {
    expect(lower).toMatch(/return.*slug|caller.*resume|append.?evidence resumes/);
  });
});
