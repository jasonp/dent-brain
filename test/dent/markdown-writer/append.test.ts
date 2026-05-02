/**
 * Integration tests for markdown_append_to_page against a local bare repo.
 *
 * Each test gets its own bare/clone pair via setupMarkdownWriter so commits
 * don't bleed across cases.
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { appendToPage } from '../../../src/dent/markdown-writer/append.ts';
import { markdownWriteOperations } from '../../../src/dent/operations/markdown-write.ts';
import { setupMarkdownWriter, makeCtx, rawGit, type MdWriterFixture } from './_helpers.ts';

const SLUG = 'entities/people/test-subject';

let fx: MdWriterFixture;

beforeEach(async () => {
  fx = await setupMarkdownWriter();
});

afterEach(async () => {
  await fx.cleanup();
});

describe('appendToPage — service layer', () => {
  test('creates new page with bootstrapped frontmatter and pushes', async () => {
    const result = await appendToPage(fx.engine, {
      slug: SLUG,
      content: '- 2026-05-02 first observation',
      section: 'Timeline',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.section_created).toBe(true);

    const filePath = join(fx.cloneRepo, `${SLUG}.md`);
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain(`slug: ${SLUG}`);
    expect(body).toContain('## Timeline');
    expect(body).toContain('- 2026-05-02 first observation');

    // Confirm the commit landed in the bare remote.
    const log = rawGit(fx.bareRepo, ['log', '--oneline', '-5']);
    expect(log).toContain('agent: append');
  });

  test('appends to existing page without creating section', async () => {
    await appendToPage(fx.engine, { slug: SLUG, content: '- entry 1', section: 'Notes' });
    const second = await appendToPage(fx.engine, { slug: SLUG, content: '- entry 2', section: 'Notes' });

    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.section_created).toBe(false);

    const body = readFileSync(join(fx.cloneRepo, `${SLUG}.md`), 'utf-8');
    expect(body).toContain('- entry 1');
    expect(body).toContain('- entry 2');
    // Order preserved: entry 1 comes before entry 2.
    expect(body.indexOf('- entry 1')).toBeLessThan(body.indexOf('- entry 2'));

    const log = rawGit(fx.bareRepo, ['log', '--oneline']);
    expect(log.split('\n').filter((l) => l.includes('agent: append')).length).toBe(2);
  });

  test('EOF append when section omitted', async () => {
    await appendToPage(fx.engine, { slug: SLUG, content: '- under timeline', section: 'Timeline' });
    const r = await appendToPage(fx.engine, { slug: SLUG, content: '- at eof' });

    expect(r.status).toBe('ok');
    const body = readFileSync(join(fx.cloneRepo, `${SLUG}.md`), 'utf-8');
    // EOF append lands AFTER the Timeline section.
    expect(body.indexOf('- under timeline')).toBeLessThan(body.indexOf('- at eof'));
  });

  test('rejects empty content', async () => {
    const r = await appendToPage(fx.engine, { slug: SLUG, content: '   ' });
    expect(r.status).toBe('error');
  });

  test('rejects path traversal in slug', async () => {
    const r = await appendToPage(fx.engine, { slug: '../../etc/passwd', content: '- bad' });
    expect(r.status).toBe('error');
  });

  test('refreshes Postgres index for the appended page', async () => {
    await appendToPage(fx.engine, { slug: SLUG, content: '- indexed bullet', section: 'Notes' });

    const page = await fx.engine.getPage(SLUG);
    expect(page).not.toBeNull();
    expect(page?.compiled_truth ?? '').toContain('- indexed bullet');
  });
});

describe('markdown_append_to_page — MCP op surface', () => {
  const op = markdownWriteOperations.find((o) => o.name === 'markdown_append_to_page')!;

  test('happy path returns ok + commit_sha', async () => {
    const result = (await op.handler(makeCtx(fx.engine), {
      slug: SLUG,
      content: '- via op',
      section: 'Notes',
    })) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(result.commit_sha).toBeString();
    expect(result.file_path).toBe(`${SLUG}.md`);
  });

  test('dry_run returns preview, writes nothing', async () => {
    const result = (await op.handler(makeCtx(fx.engine, true), {
      slug: SLUG,
      content: '- preview',
    })) as Record<string, unknown>;

    expect(result.dry_run).toBe(true);
    expect(existsSync(join(fx.cloneRepo, `${SLUG}.md`))).toBe(false);
  });

  test('rejects missing required params', async () => {
    let thrown: unknown;
    try {
      await op.handler(makeCtx(fx.engine), { slug: SLUG });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
  });
});
