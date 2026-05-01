/**
 * Phase 3 enrich skill — contract tests on SKILL.md prose.
 *
 * The skill is a markdown file executed by an agent at runtime. We can't
 * unit-test the LLM's behavior, but we CAN guard against accidental edits
 * to the load-bearing clauses. Each test below pins one of the five
 * behaviors PLAN.md Phase 3 calls out:
 *
 *   1. enrich-fm-injection — skill instructs the agent to call
 *      `fm_get_record` when `filemaker_record_id` is present.
 *   2. enrich-fm-wins — skill carries an "FM is authoritative for owned
 *      fields" rule plus a discrepancy-noting instruction.
 *   3. enrich-merge — skill instructs the agent to read the existing
 *      page first and preserve human-written content verbatim across
 *      re-runs.
 *   4. enrich-empty-evidence — skill handles the FM-record-but-no-evidence
 *      case explicitly (renders cleanly, doesn't abort).
 *   5. enrich-no-fm — skill handles the no-FM-link case explicitly
 *      (proceeds on evidence alone, doesn't fail).
 *
 * If you're tweaking the skill prose, you may need to update these
 * assertions — but the underlying CONTRACT (the five behaviors) must
 * survive every edit.
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

describe('skill contract', () => {
  test('frontmatter declares the right tools (FM + dent ops)', () => {
    // Frontmatter is everything before the second `---` fence.
    const fenceClose = skillBody.indexOf('\n---', 4);
    expect(fenceClose).toBeGreaterThan(0);
    const frontmatter = skillBody.slice(0, fenceClose).toLowerCase();

    // Must list the FM tools so the agent knows it can call them.
    expect(frontmatter).toContain('fm_get_record');
    // Must list the dent evidence ops.
    expect(frontmatter).toContain('get_evidence');
    expect(frontmatter).toContain('get_page');
    expect(frontmatter).toContain('put_page');
  });

  test('1. enrich-fm-injection: instructs reading filemaker_record_id and calling fm_get_record', () => {
    expect(skillBodyLower).toContain('filemaker_record_id');
    expect(skillBodyLower).toContain('fm_get_record');
    // The skill must explicitly handle the "absent" branch — agent skips
    // FM lookup when there's no id.
    expect(skillBodyLower).toMatch(/absent[^.]*skip|no.*filemaker_record_id|no.*fm.*link/);
  });

  test('2. enrich-fm-wins: declares FM authority and discrepancy-noting rule', () => {
    // Authority: FM is authoritative / FM wins / FM-as-truth — any of
    // those phrasings should land.
    expect(skillBodyLower).toMatch(/fm.*authoritative|fm.*wins|fm-as-truth|fm.*as.*truth/);
    // Discrepancy: when FM and evidence disagree, note it inline.
    expect(skillBodyLower).toContain('discrepancy');
    // The owned-fields concept must appear somewhere — defines what FM
    // is authoritative ABOUT.
    expect(skillBodyLower).toMatch(/owned field|owned.*fields/);
  });

  test('3. enrich-merge: instructs reading the existing page first and preserving hand-edits', () => {
    // Step 1 of the protocol must read the existing page.
    expect(skillBodyLower).toMatch(/get_page\s*\(/);
    // Hand-edit / human-written preservation language.
    expect(skillBodyLower).toMatch(/preserve.*hand|preserve.*human|preserve any human-written/);
    expect(skillBodyLower).toContain('verbatim');
    // The "trust the whole body, don't parse sections" instruction.
    expect(skillBodyLower).toMatch(/whole body|entire body|full body/);
  });

  test('4. enrich-empty-evidence: explicitly handles FM-but-no-evidence', () => {
    // Should mention that empty evidence is fine when an FM record exists.
    expect(skillBodyLower).toMatch(/empty.*fm|fm record alone|fm.*alone/);
  });

  test('5. enrich-no-fm: proceeds on evidence alone when there is no FM link', () => {
    // The "skip FM, run on evidence" branch must be present.
    expect(skillBodyLower).toMatch(/evidence alone|evidence-only|on evidence alone/);
  });

  test('abort condition: no FM and no evidence', () => {
    // The skill must NOT silently produce a page from nothing — it has
    // to abort with a clear message when both inputs are empty.
    expect(skillBodyLower).toMatch(/no fm.*no evidence|nothing to synthesize|no fm record and no evidence/);
  });

  test('citations rule: every claim carries an inline source', () => {
    expect(skillBody).toContain('[Source:');
    // FM citation pattern (illustrative).
    expect(skillBodyLower).toContain('fm people');
  });

  test('no proxy rule: skill explicitly says dent-brain server does not proxy FM', () => {
    // Belt-and-suspenders against future drift toward server-side FM
    // proxying — PLAN.md is unambiguous here.
    expect(skillBodyLower).toMatch(/does not proxy|do not proxy|no.*proxy/);
  });
});
