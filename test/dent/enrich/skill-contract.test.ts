/**
 * /dent-enrich skill contract tests (v2.0 — markdown-canonical).
 *
 * The skill is a markdown file executed by an agent at runtime. We can't
 * unit-test the LLM's behavior, but we CAN guard against accidental edits
 * to the load-bearing clauses.
 *
 * Phase 2 (PLAN v2.0) retargeted the write tail: synthesis output now
 * flows through `markdown_replace_page` with `expected_prior_hash`
 * optimistic concurrency, and observations are read from the page body
 * (not a separate evidence table). The contract surface adapts.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let skillBody: string;
let skillBodyLower: string;

beforeAll(() => {
  const skillPath = join(import.meta.dir, '..', '..', '..', 'skills', 'dent', 'enrich', 'SKILL.md');
  skillBody = readFileSync(skillPath, 'utf8');
  skillBodyLower = skillBody.toLowerCase();
});

describe('skill contract (v2.0)', () => {
  test('frontmatter declares the right tools (FM + markdown write)', () => {
    const fenceClose = skillBody.indexOf('\n---', 4);
    expect(fenceClose).toBeGreaterThan(0);
    const frontmatter = skillBody.slice(0, fenceClose).toLowerCase();

    // FM tools (per-user stdio)
    expect(frontmatter).toContain('fm_get_record');
    // Read primitive (still gbrain-native put_page's read counterpart)
    expect(frontmatter).toContain('get_page');
    // The new write primitive
    expect(frontmatter).toContain('markdown_replace_page');
  });

  test('frontmatter does NOT declare the dropped evidence ops', () => {
    const fenceClose = skillBody.indexOf('\n---', 4);
    const frontmatter = skillBody.slice(0, fenceClose).toLowerCase();
    expect(frontmatter).not.toContain('get_evidence');
    expect(frontmatter).not.toContain('get_provenance');
    expect(frontmatter).not.toContain('append_evidence');
    // No put_page either — markdown is canonical
    expect(frontmatter).not.toContain('put_page');
  });

  test('1. enrich-fm-injection: instructs reading filemaker_record_id and calling fm_get_record', () => {
    expect(skillBodyLower).toContain('filemaker_record_id');
    expect(skillBodyLower).toContain('fm_get_record');
    expect(skillBodyLower).toMatch(/absent[^.]*skip|no.*filemaker_record_id|no.*fm.*link/);
  });

  test('2. enrich-fm-wins: declares FM authority and discrepancy-noting rule', () => {
    expect(skillBodyLower).toMatch(/fm.*authoritative|fm.*wins|fm-as-truth|fm.*as.*truth/);
    expect(skillBodyLower).toContain('discrepancy');
    expect(skillBodyLower).toMatch(/owned field|owned.*fields/);
  });

  test('3. enrich-merge: instructs reading the existing page first and preserving hand-edits + bullets', () => {
    // Step 1 of the protocol must read the existing page.
    expect(skillBodyLower).toMatch(/get_page\s*\(/);
    // Hand-edit / human-written preservation language.
    expect(skillBodyLower).toMatch(/preserve.*hand|preserve.*human|preserve any human-written/);
    expect(skillBodyLower).toContain('verbatim');
    // The "trust the whole body" instruction.
    expect(skillBodyLower).toMatch(/whole body|entire body|full body/);
    // v2.0-specific: timeline bullets are immutable observation log,
    // must be preserved verbatim across re-runs.
    expect(skillBodyLower).toMatch(/preserve.*bullet.*timeline|timeline[\s\S]{0,80}verbatim|immutable observation/);
  });

  test('4. optimistic concurrency on write via expected_prior_hash', () => {
    // The whole reason markdown_replace_page exists for re-synthesis is
    // to detect mid-synthesis page changes. Skill must instruct hash
    // computation + retry on `page_changed`.
    expect(skillBodyLower).toContain('expected_prior_hash');
    expect(skillBodyLower).toContain('page_changed');
    expect(skillBodyLower).toMatch(/sha256/);
    expect(skillBodyLower).toMatch(/retry/);
  });

  test('5. abort condition: no FM and no observations and no related context', () => {
    // The skill must NOT silently produce a page from nothing.
    expect(skillBodyLower).toMatch(/no fm.*no observations|nothing to synthesize|no fm record/);
  });

  test('6. abort condition: page does not exist (skill is re-synthesis, not stub creation)', () => {
    // /dent-enrich expects an existing page. Stub creation is
    // /dent-resolve-entity's job.
    expect(skillBodyLower).toMatch(/page does not exist|no page at|stub creator/);
  });

  test('citations rule: every claim carries an inline source', () => {
    expect(skillBody).toContain('[Source:');
    expect(skillBodyLower).toContain('fm people');
  });

  test('no proxy rule: skill explicitly says dent-brain server does not proxy FM', () => {
    expect(skillBodyLower).toMatch(/does not proxy|do not proxy|no.*proxy/);
  });

  test('forbids mandated dent-specific section scaffolds (v2.0 principle 2)', () => {
    // The skill must not instruct the agent to create
    // `## Recent Observations`, `## State`, etc. The page's existing
    // structure is authoritative. Anti-pattern callout enforces this.
    expect(skillBodyLower).toMatch(/do not impose mandated section|no mandated section|do not invent.*section/);
  });

  test('## Timeline is the only structurally-meaningful heading', () => {
    expect(skillBody).toContain('## Timeline');
    expect(skillBodyLower).toMatch(/timeline.*gbrain.?native|gbrain.?native.*timeline|only structurally-meaningful/);
  });

  test('does not write to Postgres directly (no put_page)', () => {
    expect(skillBodyLower).toMatch(/no put_page|do not[\s\S]{0,40}postgres directly/);
  });

  test('does not call dropped get_evidence / get_provenance ops', () => {
    expect(skillBodyLower).not.toContain('get_evidence');
    expect(skillBodyLower).not.toContain('get_provenance');
  });
});
