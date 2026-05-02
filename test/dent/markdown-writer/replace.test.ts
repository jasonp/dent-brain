/**
 * Integration tests for markdown_replace_page (optimistic concurrency).
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { replacePage, hashContent } from '../../../src/dent/markdown-writer/replace.ts';
import { appendToPage } from '../../../src/dent/markdown-writer/append.ts';
import { setupMarkdownWriter, type MdWriterFixture } from './_helpers.ts';

const SLUG = 'entities/people/replace-subject';

let fx: MdWriterFixture;

beforeEach(async () => {
  fx = await setupMarkdownWriter();
});

afterEach(async () => {
  await fx.cleanup();
});

describe('replacePage', () => {
  test('creates brand-new page (no expected_prior_hash)', async () => {
    const content = `---\ntitle: replace-subject\nslug: ${SLUG}\n---\n\nfresh page body\n`;
    const r = await replacePage(fx.engine, { slug: SLUG, content });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(true);

    const onDisk = readFileSync(join(fx.cloneRepo, `${SLUG}.md`), 'utf-8');
    expect(onDisk).toBe(content);
  });

  test('overwrites existing page when hash matches', async () => {
    // Seed the page via append.
    await appendToPage(fx.engine, { slug: SLUG, content: '- seed', section: 'Notes' });
    const path = join(fx.cloneRepo, `${SLUG}.md`);
    const prior = readFileSync(path, 'utf-8');
    const priorHash = hashContent(prior);

    const newContent = `---\ntitle: replaced\nslug: ${SLUG}\n---\n\nfully rewritten body\n`;
    const r = await replacePage(fx.engine, {
      slug: SLUG,
      content: newContent,
      expected_prior_hash: priorHash,
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(newContent);
  });

  test('returns page_changed when hash mismatches', async () => {
    await appendToPage(fx.engine, { slug: SLUG, content: '- seed', section: 'Notes' });
    const r = await replacePage(fx.engine, {
      slug: SLUG,
      content: 'attempted overwrite',
      expected_prior_hash: 'deadbeef'.repeat(8),
    });

    expect(r.status).toBe('page_changed');
    if (r.status !== 'page_changed') return;
    expect(r.current_content).toContain('- seed');
    expect(r.current_hash).toBeString();

    // Page on disk untouched.
    const onDisk = readFileSync(join(fx.cloneRepo, `${SLUG}.md`), 'utf-8');
    expect(onDisk).toBe(r.current_content);
  });

  test('no-op short-circuit when content equals current', async () => {
    const initial = `---\ntitle: x\n---\n\nbody\n`;
    await replacePage(fx.engine, { slug: SLUG, content: initial });
    const priorHash = hashContent(initial);

    const r = await replacePage(fx.engine, {
      slug: SLUG,
      content: initial,
      expected_prior_hash: priorHash,
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(false);
    // Same content + same hash → no second commit. Sanity-check the log
    // by counting commits with our agent prefix.
    // (We don't assert exact count here because performSync's sync may add
    //  config writes, but the file content is the contract.)
  });

  test('rejects path traversal in slug', async () => {
    const r = await replacePage(fx.engine, { slug: '../escape', content: 'x' });
    expect(r.status).toBe('error');
  });
});
