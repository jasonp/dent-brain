/**
 * /dent-resolve-entity skill contract tests (v2.0 — markdown-canonical).
 *
 * Pins the disambiguation protocol in
 * skills/dent/resolve-entity/SKILL.md.
 *
 * Phase 2 (PLAN v2.0) retargeted this skill to write new entity stubs
 * through `markdown_replace_page` instead of `put_page` — stubs now
 * land in dent-brain-data git, not just Postgres.
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

describe('resolve-entity skill contract (v2.0)', () => {
  test('frontmatter declares fm_find_records and markdown_replace_page', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    expect(fm).toContain('fm_find_records');
    expect(fm).toContain('markdown_replace_page');
  });

  test('frontmatter does NOT declare put_page (write path retargeted)', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    expect(fm).not.toContain('put_page');
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
    expect(lower).toContain('markdown_replace_page');
  });

  test('slug collision check via get_page before writing', () => {
    expect(lower).toMatch(/slug collision|already exists|disambiguator/);
    // get_page is the collision check — must reference it
    expect(lower).toContain('get_page');
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

  test('returns the slug to the caller for resumed flow', () => {
    expect(lower).toMatch(/return.*slug|caller.*resume/);
  });

  test('does not write to Postgres directly (no put_page)', () => {
    expect(lower).toMatch(/do not write to postgres|no put_page/);
  });

  test('forbids mandated dent-specific section scaffolds', () => {
    // The stub the skill writes must be minimal. It can include
    // `## Timeline` references (gbrain-native) but must NOT scaffold
    // `## State`, `## Recent Observations`, etc.
    expect(body).not.toMatch(/##\s+Recent Observations/);
    expect(body).not.toMatch(/##\s+What They Believe/);
    expect(body).not.toMatch(/##\s+Hobby Horses/);
    expect(body).not.toMatch(/##\s+Trajectory/);
    expect(body).not.toMatch(/##\s+Assessment/);
    // `## State` is the most common offender — the v1.x skill mandated
    // it. v2.0 stubs must not.
    expect(body).not.toMatch(/^##\s+State\s*$/m);
  });
});
