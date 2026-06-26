/**
 * Unit tests for spliceFragment — pure function, no git, no engine.
 */

import { describe, test, expect } from 'bun:test';
import { spliceFragment } from '../../../src/dent/db-writer/append.ts';

describe('spliceFragment — EOF append (no section)', () => {
  test('appends to empty body', () => {
    const r = spliceFragment('', '- new bullet');
    expect(r.body).toBe('- new bullet\n');
    expect(r.sectionCreated).toBe(false);
  });

  test('appends to body without trailing newline', () => {
    const r = spliceFragment('# Title\nbody', '- new bullet');
    expect(r.body).toBe('# Title\nbody\n\n- new bullet\n');
  });

  test('appends to body with single trailing newline', () => {
    const r = spliceFragment('# Title\nbody\n', '- new bullet');
    expect(r.body).toBe('# Title\nbody\n\n- new bullet\n');
  });

  test('does not duplicate trailing blank line', () => {
    const r = spliceFragment('# Title\nbody\n\n', '- new bullet');
    expect(r.body).toBe('# Title\nbody\n\n- new bullet\n');
  });

  test('preserves multiline fragment as-is', () => {
    const r = spliceFragment('# T\n', '- a\n- b\n  - sub');
    expect(r.body).toBe('# T\n\n- a\n- b\n  - sub\n');
  });
});

describe('spliceFragment — section append', () => {
  test('appends under existing section, before next ## heading', () => {
    const body = `# Title\n\n## Notes\n- existing\n\n## Other\nfoo\n`;
    const r = spliceFragment(body, '- new', 'Notes');
    expect(r.sectionCreated).toBe(false);
    // Fragment lands between `- existing` and the next heading.
    const lines = r.body.split('\n');
    const notesIdx = lines.indexOf('## Notes');
    const otherIdx = lines.indexOf('## Other');
    expect(notesIdx).toBeGreaterThan(-1);
    expect(otherIdx).toBeGreaterThan(notesIdx);
    const between = lines.slice(notesIdx + 1, otherIdx).join('\n');
    expect(between).toContain('- existing');
    expect(between).toContain('- new');
  });

  test('appends under section that runs to EOF', () => {
    const body = `# T\n\n## Notes\n- a\n`;
    const r = spliceFragment(body, '- b', 'Notes');
    expect(r.body).toContain('- a');
    expect(r.body).toContain('- b');
    expect(r.body.indexOf('- a')).toBeLessThan(r.body.indexOf('- b'));
  });

  test('creates missing section at EOF', () => {
    const body = `# T\n\nintro\n`;
    const r = spliceFragment(body, '- first entry', 'Timeline');
    expect(r.sectionCreated).toBe(true);
    expect(r.body).toContain('## Timeline');
    expect(r.body.indexOf('## Timeline')).toBeLessThan(r.body.indexOf('- first entry'));
  });

  test('case-insensitive heading match', () => {
    const body = `# T\n\n## TIMELINE\n- old\n`;
    const r = spliceFragment(body, '- new', 'timeline');
    expect(r.sectionCreated).toBe(false);
    expect(r.body).toContain('- new');
  });

  test('accepts section input with leading hashes', () => {
    const body = `# T\n\n## Notes\n- a\n`;
    const r = spliceFragment(body, '- b', '## Notes');
    expect(r.sectionCreated).toBe(false);
    expect(r.body).toContain('- b');
  });

  test('does not match heading inside another heading prefix', () => {
    // `## Notes-extra` should NOT match `Notes`.
    const body = `# T\n\n## Notes-extra\n- a\n`;
    const r = spliceFragment(body, '- b', 'Notes');
    // No match, so creates a new "Notes" section.
    expect(r.sectionCreated).toBe(true);
    expect(r.body).toContain('## Notes-extra');
    expect(r.body).toContain('## Notes\n');
  });
});

describe('spliceFragment — replace mode (idempotent section + duplicate collapse)', () => {
  test('replaces an existing single section in place of appending', () => {
    const body = `# T\n\n## Mentioned\n- old\n`;
    const r = spliceFragment(body, '- new', 'Mentioned', true);
    expect(r.sectionCreated).toBe(false); // existed → replaced
    // Exactly one heading; old content gone, new content present.
    expect((r.body.match(/^## Mentioned$/gm) ?? []).length).toBe(1);
    expect(r.body).toContain('- new');
    expect(r.body).not.toContain('- old');
  });

  test('collapses DUPLICATE sections into one (the transition-bug shape)', () => {
    // Two `## Mentioned` blocks, like an older daemon left behind.
    const body = `# T\n\nintro\n\n## Mentioned\n- a1\n- a2\n\n## Mentioned\n- b1\n`;
    const r = spliceFragment(body, '- fresh', 'Mentioned', true);
    expect((r.body.match(/^## Mentioned$/gm) ?? []).length).toBe(1);
    expect(r.body).toContain('- fresh');
    expect(r.body).not.toContain('- a1');
    expect(r.body).not.toContain('- b1');
    expect(r.body).toContain('intro'); // surrounding content preserved
  });

  test('creates the section when none exists (sectionCreated true)', () => {
    const body = `# T\n\nintro\n`;
    const r = spliceFragment(body, '- first', 'Mentioned', true);
    expect(r.sectionCreated).toBe(true);
    expect((r.body.match(/^## Mentioned$/gm) ?? []).length).toBe(1);
    expect(r.body).toContain('- first');
  });

  test('replace preserves OTHER sections', () => {
    const body = `# T\n\n## Notes\n- keep\n\n## Mentioned\n- drop\n`;
    const r = spliceFragment(body, '- new', 'Mentioned', true);
    expect(r.body).toContain('## Notes');
    expect(r.body).toContain('- keep');
    expect(r.body).not.toContain('- drop');
    expect(r.body).toContain('- new');
  });
});
