/**
 * /dent-append-evidence skill contract tests (v2.0 — markdown-canonical).
 *
 * Pins the load-bearing clauses in skills/dent/append-evidence/SKILL.md
 * so accidental edits during prose tightening don't drop the protocol.
 *
 * Phase 2 (PLAN v2.0) rewrote this skill to write through
 * `markdown_append_to_page` instead of the now-deleted `append_evidence`
 * + `add_timeline_entry` ops. The contract tests reflect that pivot.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let body: string;
let lower: string;

beforeAll(() => {
  const path = join(import.meta.dir, '..', '..', '..', 'skills', 'dent', 'append-evidence', 'SKILL.md');
  body = readFileSync(path, 'utf8');
  lower = body.toLowerCase();
});

describe('append-evidence skill contract (v2.0)', () => {
  test('frontmatter declares the markdown write tool, not the dropped evidence ops', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    // Tier 1 detection
    expect(fm).toContain('detect_entities');
    // Tier 2 FM lookup
    expect(fm).toContain('fm_find_records');
    // The new write primitive
    expect(fm).toContain('markdown_append_to_page');
    // markdown_replace_page is used for stub creation in step 2
    expect(fm).toContain('markdown_replace_page');
  });

  test('frontmatter does NOT declare the dropped evidence ops', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    // The whole point of v2.0 — the evidence table is gone.
    expect(fm).not.toContain('append_evidence');
    expect(fm).not.toContain('add_timeline_entry');
    expect(fm).not.toContain('get_evidence');
    expect(fm).not.toContain('quarantine_batch');
    // No put_page either — markdown is canonical, writes go through the
    // new ops or `markdown_replace_page`.
    expect(fm).not.toContain('put_page');
  });

  test('tier 1: instructs calling detect_entities first', () => {
    expect(lower).toContain('detect_entities');
    expect(lower).toMatch(/step 1[^\n]*entity detection|tier.?1/);
  });

  test('A5 escalation rule: 0 / 1 / 2+ matches each have a documented action', () => {
    // 1 match → auto-link via markdown_replace_page (new entity stub)
    expect(lower).toMatch(/1 match[\s\S]*auto.?link/);
    // 2+ matches → escalate to /dent-resolve-entity
    expect(lower).toMatch(/2\+ matches[\s\S]*resolve.?entity/);
    // 0 matches → ask user about creating a stub
    expect(lower).toMatch(/0 matches[\s\S]*stub/);
  });

  test('stub creation for FM lookup goes through markdown_replace_page (not put_page)', () => {
    // The 0-match and 1-match branches both create new entity stubs.
    // Both must route through markdown_replace_page so the stub lands
    // in dent-brain-data git, not just Postgres.
    expect(lower).toMatch(/markdown_replace_page[\s\S]{0,200}stub|stub[\s\S]{0,200}markdown_replace_page/);
  });

  test('stub creation requires user confirmation (not silent auto-create)', () => {
    expect(lower).toMatch(/ask the user|create a stub entity/);
    expect(lower).toContain('do not silently create stubs');
  });

  test('email shortcut for 2+ FM match disambiguation', () => {
    expect(lower).toContain('email');
    expect(lower).toMatch(/disambiguat/);
  });

  test('canonical date-anchored bullet shape matches gbrain parseTimelineEntries', () => {
    // The bullet shape `- **YYYY-MM-DD** | <text>` is what
    // src/core/link-extraction.ts:786 (TIMELINE_LINE_RE) recognizes.
    // Skill must instruct exactly that shape.
    expect(body).toMatch(/-\s+\*\*YYYY-MM-DD\*\*\s*\|/);
    // And mention parseTimelineEntries / auto-extraction so future edits
    // know why the shape is rigid.
    expect(lower).toMatch(/parsetimelineentries|auto.?extract/);
  });

  test('targets ## Timeline section for date-anchored bullets', () => {
    expect(body).toContain('## Timeline');
    expect(lower).toMatch(/date.?anchored/);
  });

  test('forbids inventing dent-specific mandated sections', () => {
    // The whole point of PLAN v2.0 principle 2: pages are unstructured.
    // Skill must NOT mandate `## Recent Observations`, `## State`, etc.
    // It can REFERENCE those names in an anti-pattern call-out (and it
    // does), but must not instruct the agent to create them.
    expect(lower).toMatch(/do not invent.*mandated section|do not invent new mandated section names/);
    // `## Timeline` is the one allowed structural reference.
    expect(body).toMatch(/`?## Timeline`?\s+(is|the only)/i);
  });

  test('rejects writes targeting zero entities', () => {
    expect(lower).toMatch(/zero entities|orphan bullets/);
  });

  test('handles rate_limited, busy, page_changed responses', () => {
    expect(lower).toContain('rate_limited');
    expect(lower).toContain('busy');
    // markdown_append_to_page can return rebased: true on push retry —
    // skill should surface that to the user.
    expect(lower).toMatch(/rebased/);
  });

  test('idempotency hint via git-layer dedup, not content_hash table', () => {
    // No more content_hash idempotency (that was the evidence table's
    // primary key). Now: identical bullets produce identical files,
    // git no-ops the second commit.
    expect(lower).toMatch(/already have that observation|byte.?identical|no.?op/);
    // The phrase "content_hash" may appear in a "we don't use that
    // anymore" disclaimer — that's fine. What's NOT fine is anything
    // that sounds like an active instruction to compute or check it.
    expect(lower).not.toMatch(/check[\s\S]{0,30}content_hash|compute[\s\S]{0,30}content_hash|content_hash[\s\S]{0,30}rejects/);
  });

  test('does not call put_page anywhere', () => {
    // Belt-and-suspenders against a partial retarget.
    expect(lower).toMatch(/no put_page|do not write to postgres/);
  });
});
