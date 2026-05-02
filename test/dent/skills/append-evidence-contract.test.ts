/**
 * Phase 4 — /dent-append-evidence skill contract tests.
 *
 * Pins the load-bearing clauses in skills/dent/append-evidence/SKILL.md
 * so accidental edits during prose tightening don't drop the protocol.
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

describe('append-evidence skill contract', () => {
  test('frontmatter declares the right tools', () => {
    const fence = body.indexOf('\n---', 4);
    const fm = body.slice(0, fence).toLowerCase();
    // Tier 1 detection
    expect(fm).toContain('detect_entities');
    // Tier 2 FM lookup
    expect(fm).toContain('fm_find_records');
    // The write
    expect(fm).toContain('append_evidence');
    // Per-entity timeline append
    expect(fm).toContain('add_timeline_entry');
  });

  test('tier 1: instructs calling detect_entities first', () => {
    expect(lower).toContain('detect_entities');
    expect(lower).toMatch(/step 1[^\n]*entity detection|tier.?1/);
  });

  test('A5 escalation rule: 0 / 1 / 2+ matches each have a documented action', () => {
    // 1 match → auto-link
    expect(lower).toMatch(/1 match[\s\S]*auto.?link/);
    // 2+ matches → escalate to /dent-resolve-entity
    expect(lower).toMatch(/2\+ matches[\s\S]*resolve.?entity/);
    // 0 matches → ask user about creating a stub
    expect(lower).toMatch(/0 matches[\s\S]*stub/);
  });

  test('stub creation requires user confirmation (option b, not silent auto-create)', () => {
    expect(lower).toMatch(/ask the user|create a stub entity/);
    // And explicit anti-pattern
    expect(lower).toContain('do not silently create stubs');
  });

  test('email shortcut for 2+ FM match disambiguation', () => {
    expect(lower).toContain('email');
    expect(lower).toMatch(/disambiguat/);
  });

  test('writes timeline entries per evidence write', () => {
    expect(lower).toMatch(/step 5[^\n]*timeline/);
    expect(lower).toContain('add_timeline_entry');
  });

  test('rejects writes with zero entity_refs', () => {
    expect(lower).toMatch(/zero.*entity_refs|orphan evidence/);
  });

  test('captured_via metadata for ingest-vs-conversational filtering', () => {
    expect(lower).toContain('captured_via');
    expect(lower).toContain('dent-append-evidence');
  });

  test('source_type and source_ref defaulting rule documented', () => {
    expect(lower).toContain('source_type');
    expect(lower).toContain('source_ref');
    expect(lower).toMatch(/observation|meeting|email/);
  });

  test('idempotency hint: same content_hash means existing row', () => {
    expect(lower).toContain('content_hash');
    expect(lower).toMatch(/already have|don.?t re.?write|same content/);
  });
});
