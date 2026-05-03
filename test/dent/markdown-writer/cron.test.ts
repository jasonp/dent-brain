/**
 * Phase 4: scheduled-pull integration tests.
 *
 * Bare/clone fixture matches `_helpers.ts`. Each test simulates a
 * "teammate push" by committing to a separate working tree pointed
 * at the same bare remote, then runs `pullAndSyncOnce(engine)` and
 * asserts the local clone advanced + the Postgres index reflects
 * the new content.
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { pullAndSyncOnce } from '../../../src/dent/markdown-writer/cron.ts';
import { setupMarkdownWriter, type MdWriterFixture } from './_helpers.ts';

setDefaultTimeout(30_000);

let fx: MdWriterFixture;
let teammateRepo: string;

beforeEach(async () => {
  fx = await setupMarkdownWriter();
  // Create a second working clone that simulates a teammate's machine.
  // Both clones push to/pull from the same bare remote (fx.bareRepo).
  teammateRepo = join(fx.workdir, 'teammate-clone');
  execFileSync('git', ['clone', fx.bareRepo, teammateRepo], { encoding: 'utf-8' });
  execFileSync('git', ['-C', teammateRepo, 'config', 'user.email', 'teammate@example.com'], { encoding: 'utf-8' });
  execFileSync('git', ['-C', teammateRepo, 'config', 'user.name', 'Teammate'], { encoding: 'utf-8' });
});

afterEach(async () => {
  await fx.cleanup();
});

function teammatePush(filePath: string, body: string, msg: string): void {
  const abs = join(teammateRepo, filePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  execFileSync('git', ['-C', teammateRepo, 'add', filePath], { encoding: 'utf-8' });
  execFileSync('git', ['-C', teammateRepo, 'commit', '-m', msg], { encoding: 'utf-8' });
  execFileSync('git', ['-C', teammateRepo, 'push', 'origin', 'master'], { encoding: 'utf-8' });
}

describe('pullAndSyncOnce', () => {
  test('no-op when remote HEAD is unchanged', async () => {
    const result = await pullAndSyncOnce(fx.engine);
    expect(result).toEqual({ changed: false });
  });

  test('pulls + re-indexes a teammate-pushed page', async () => {
    const slug = 'entities/people/teammate-edit';
    const body = `---\nslug: ${slug}\n---\n\n# Teammate edit\n\n- Hand-edited fact about the entity.\n`;
    teammatePush(`${slug}.md`, body, 'teammate: hand-edit');

    const result = await pullAndSyncOnce(fx.engine);
    expect('changed' in result && result.changed).toBe(true);
    if ('changed' in result && result.changed) {
      expect(result.fromCommit).toBeString();
      expect(result.toCommit).toBeString();
      expect(result.fromCommit).not.toBe(result.toCommit);
    }

    // The clone now has the file.
    const localPath = join(fx.cloneRepo, `${slug}.md`);
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf-8')).toContain('Hand-edited fact');

    // Postgres reflects it.
    const page = await fx.engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(page?.compiled_truth ?? '').toContain('Hand-edited fact');
  });

  test('second tick after a teammate change is no-op', async () => {
    const slug = 'entities/people/teammate-second';
    teammatePush(`${slug}.md`, `---\nslug: ${slug}\n---\n\nfirst\n`, 'teammate');

    const first = await pullAndSyncOnce(fx.engine);
    expect('changed' in first && first.changed).toBe(true);

    const second = await pullAndSyncOnce(fx.engine);
    expect(second).toEqual({ changed: false });
  });

  test('handles teammate adding under a sub-namespace', async () => {
    const slug = 'meetings/2026-05-02-jason-steve';
    const body = `---\nslug: ${slug}\nkind: meeting\n---\n\n# 1:1\n\nNotes.\n`;
    teammatePush(`${slug}.md`, body, 'teammate: add meeting note');

    const result = await pullAndSyncOnce(fx.engine);
    expect('changed' in result && result.changed).toBe(true);

    const page = await fx.engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(page?.compiled_truth ?? '').toContain('1:1');
  });
});
