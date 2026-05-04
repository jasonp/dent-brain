/**
 * Tests for the batch markdown-writer.
 *
 * The whole point of withBatch is: N file edits → 1 commit + 1 push.
 * These tests prove that property end-to-end against a real bare/clone fixture.
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { withBatch } from '../../../src/dent/markdown-writer/batch.ts';
import { setupMarkdownWriter, rawGit, type MdWriterFixture } from './_helpers.ts';

setDefaultTimeout(30_000);

let fx: MdWriterFixture;
beforeEach(async () => { fx = await setupMarkdownWriter(); });
afterEach(async () => { await fx.cleanup(); });

describe('withBatch', () => {
  test('N appends across N slugs land as one commit', async () => {
    const before = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);

    const result = await withBatch(fx.engine, async (batch) => {
      for (let i = 0; i < 5; i++) {
        const r = batch.appendToPage({
          slug: `entities/people/person-${i}`,
          section: '## Timeline',
          content: `- ${i} | bullet for person ${i}`,
        });
        expect(r.status).toBe('ok');
      }
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.commits).toBe(1);
    expect(result.staged_files).toBe(5);
    expect(result.pushed).toBe(true);

    const after = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);
    expect(parseInt(after) - parseInt(before)).toBe(1);

    // All 5 files exist with their bullets.
    for (let i = 0; i < 5; i++) {
      const path = join(fx.cloneRepo, `entities/people/person-${i}.md`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf-8')).toContain(`bullet for person ${i}`);
    }
  });

  test('mix of appends + replaces in one batch → one commit', async () => {
    const before = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);

    const result = await withBatch(fx.engine, async (batch) => {
      // New page via replace.
      const r1 = batch.replacePage({
        slug: 'entities/people/alice',
        content: '---\ntitle: Alice\nslug: entities/people/alice\n---\n# Alice\n\n## Timeline\n',
      });
      expect(r1.status).toBe('ok');
      // Append a bullet to that same page in the same batch.
      const r2 = batch.appendToPage({
        slug: 'entities/people/alice',
        section: '## Timeline',
        content: '- 2026-05-04 | something happened',
      });
      expect(r2.status).toBe('ok');
      // And a new page via append-EOF.
      const r3 = batch.appendToPage({
        slug: 'entities/people/bob',
        content: '## First note\n\nbob got onboarded',
      });
      expect(r3.status).toBe('ok');
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.commits).toBe(1);
    expect(result.staged_files).toBe(2); // 2 unique slugs

    const after = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);
    expect(parseInt(after) - parseInt(before)).toBe(1);

    expect(readFileSync(join(fx.cloneRepo, 'entities/people/alice.md'), 'utf-8')).toContain('something happened');
    expect(readFileSync(join(fx.cloneRepo, 'entities/people/bob.md'), 'utf-8')).toContain('bob got onboarded');
  });

  test('empty batch (no edits) → no commit, no push', async () => {
    const before = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);

    const result = await withBatch(fx.engine, async () => {
      // intentionally do nothing
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.commits).toBe(0);
    expect(result.pushed).toBe(false);
    expect(result.staged_files).toBe(0);

    const after = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);
    expect(after).toBe(before);
  });

  test('callback throws → working tree reset, no commit', async () => {
    const before = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);

    const result = await withBatch(fx.engine, async (batch) => {
      batch.appendToPage({ slug: 'entities/people/should-not-survive', content: '- bullet' });
      throw new Error('synthetic failure');
    });

    expect(result.status).toBe('error');

    const after = rawGit(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);
    expect(after).toBe(before);
    // File should not be present (reset cleared it).
    expect(existsSync(join(fx.cloneRepo, 'entities/people/should-not-survive.md'))).toBe(false);
    // Working tree clean.
    const status = rawGit(fx.cloneRepo, ['status', '--porcelain']);
    expect(status).toBe('');
  });

  test('setCommitMessage overrides the commit title', async () => {
    await withBatch(fx.engine, async (batch) => {
      batch.appendToPage({ slug: 'entities/people/x', section: '## Timeline', content: '- bullet' });
      batch.setCommitMessage('regfox-ingestor: 1 registrants (1 created)', 'cursors: form=261638 → id=99');
    });

    const lastSubject = rawGit(fx.cloneRepo, ['log', '-1', '--pretty=%s']);
    const lastBody = rawGit(fx.cloneRepo, ['log', '-1', '--pretty=%b']);
    expect(lastSubject).toBe('regfox-ingestor: 1 registrants (1 created)');
    expect(lastBody).toContain('cursors: form=261638 → id=99');
  });

  test('readSlug sees on-disk content from earlier in the batch', async () => {
    await withBatch(fx.engine, async (batch) => {
      const before = batch.readSlug('entities/people/seen-mid-batch');
      expect(before).toBeNull();

      batch.replacePage({
        slug: 'entities/people/seen-mid-batch',
        content: '---\ntitle: x\n---\n# x\n\n## Timeline\n\n- first\n',
      });

      const after = batch.readSlug('entities/people/seen-mid-batch');
      expect(after).not.toBeNull();
      expect(after!).toContain('first');
    });
  });
});
