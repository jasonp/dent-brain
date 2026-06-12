/**
 * Pins the dent HTTP MCP op registry (single-brain Stage C).
 *
 * serve.ts can't be imported in a test (module-level engine connect +
 * Bun.serve), so the assembly logic lives in src/dent/serve-ops.ts and
 * the canonical localOnly filter expression stays literally in serve.ts
 * (pinned by scripts/check-operations-filter-bypass.sh). This test applies
 * the same filter expression and asserts:
 *
 *   - sync_brain (and every localOnly op) is absent from the registry;
 *   - the dent ops (markdown_*, detect_entities, export_brain_now) are
 *     present;
 *   - the markdown op param schemas haven't drifted (callers pin
 *     slug/content/section/commit_note + slug/content/expected_prior_hash/
 *     commit_note).
 */

import { describe, test, expect } from 'bun:test';
import { operations } from '../../src/core/operations.ts';
import { assembleServeOps } from '../../src/dent/serve-ops.ts';

// The exact filter serve.ts applies before handing ops to assembleServeOps.
const served = assembleServeOps(operations.filter(op => !op.localOnly));
const byName = new Map(served.map((o) => [o.name, o]));

describe('dent serve registry', () => {
  test('sync_brain is localOnly upstream and absent from the served registry', () => {
    const upstream = operations.find((o) => o.name === 'sync_brain');
    expect(upstream).toBeDefined();
    expect(upstream!.localOnly).toBe(true);
    expect(byName.has('sync_brain')).toBe(false);
  });

  test('no served op carries localOnly', () => {
    const leaked = served.filter((o) => o.localOnly === true).map((o) => o.name);
    expect(leaked).toEqual([]);
  });

  test('every upstream localOnly op is filtered out', () => {
    const localOnlyNames = operations.filter((o) => o.localOnly).map((o) => o.name);
    expect(localOnlyNames.length).toBeGreaterThan(0);
    for (const name of localOnlyNames) {
      expect(byName.has(name)).toBe(false);
    }
  });

  test('dent ops are present: markdown_append_to_page, markdown_replace_page, detect_entities, export_brain_now', () => {
    for (const name of ['markdown_append_to_page', 'markdown_replace_page', 'detect_entities', 'export_brain_now']) {
      expect(byName.has(name)).toBe(true);
    }
  });

  test('no duplicate op names across the merged registry', () => {
    expect(byName.size).toBe(served.length);
  });

  test('markdown_append_to_page param schema is unchanged', () => {
    const op = byName.get('markdown_append_to_page')!;
    expect(Object.keys(op.params).sort()).toEqual(['commit_note', 'content', 'section', 'slug']);
    expect(op.params.slug.required).toBe(true);
    expect(op.params.slug.type).toBe('string');
    expect(op.params.content.required).toBe(true);
    expect(op.params.content.type).toBe('string');
    expect(op.params.section.required ?? false).toBe(false);
    expect(op.params.commit_note.required ?? false).toBe(false);
    expect(op.mutating).toBe(true);
  });

  test('markdown_replace_page param schema is unchanged', () => {
    const op = byName.get('markdown_replace_page')!;
    expect(Object.keys(op.params).sort()).toEqual(['commit_note', 'content', 'expected_prior_hash', 'slug']);
    expect(op.params.slug.required).toBe(true);
    expect(op.params.slug.type).toBe('string');
    expect(op.params.content.required).toBe(true);
    expect(op.params.content.type).toBe('string');
    expect(op.params.expected_prior_hash.required ?? false).toBe(false);
    expect(op.params.expected_prior_hash.type).toBe('string');
    expect(op.params.commit_note.required ?? false).toBe(false);
    expect(op.mutating).toBe(true);
  });

  test('export_brain_now is admin-scoped and mutating', () => {
    const op = byName.get('export_brain_now')!;
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);
    expect(Object.keys(op.params)).toEqual([]);
  });
});
