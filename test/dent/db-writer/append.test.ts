/**
 * DB-direct append tests (single-brain Stage C). No git fixture — every
 * write lands in PGLite via importFromContent (source 'dent', noEmbed)
 * and reads come back through readPageMarkdown's canonical rendering.
 *
 * Splice mechanics (section matching, whitespace) are covered by
 * test/dent/markdown-writer/splice.test.ts; this file covers the
 * engine-facing contract: bootstrap, flags, round-trip fidelity,
 * source scoping, size guard, and lock behavior.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../helpers/reset-pglite.ts';
import { tryAcquireDbLock } from '../../../src/core/db-lock.ts';
import { appendToPageDb } from '../../../src/dent/db-writer/append.ts';
import { DentOperationError } from '../../../src/dent/errors.ts';
import {
  DENT_SOURCE_ID,
  MAX_PAGE_BYTES,
  readPageMarkdown,
} from '../../../src/dent/db-writer/page-io.ts';
import { upsertDentSource } from './_helpers.ts';

setDefaultTimeout(30_000);

const SLUG = 'entities/people/test-subject';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await upsertDentSource(engine);
});

describe('appendToPageDb', () => {
  test('missing page bootstraps with frontmatter; created + section_created flags set', async () => {
    const result = await appendToPageDb(engine, {
      slug: SLUG,
      content: '- 2026-05-02 first observation',
      section: 'Timeline',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.created).toBe(true);
    expect(result.section_created).toBe(true);
    expect(result.file_path).toBe(`${SLUG}.md`);

    const page = await readPageMarkdown(engine, SLUG);
    expect(page).not.toBeNull();
    // Canonical rendering: the slug key is structural (lives on the row),
    // title survives from the bootstrap frontmatter, type is inferred from
    // the entities/people/ prefix.
    expect(page!.markdown).toContain('title: test-subject');
    expect(page!.markdown).toContain('type: person');
    expect(page!.markdown).toContain('## Timeline');
    expect(page!.markdown).toContain('- 2026-05-02 first observation');
  });

  test('appends to existing page + existing section without re-creating it', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- entry 1', section: 'Notes' });
    const second = await appendToPageDb(engine, { slug: SLUG, content: '- entry 2', section: 'Notes' });

    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.created).toBe(false);
    expect(second.section_created).toBe(false);

    const page = await readPageMarkdown(engine, SLUG);
    const body = page!.markdown;
    expect(body).toContain('- entry 1');
    expect(body).toContain('- entry 2');
    expect(body.indexOf('- entry 1')).toBeLessThan(body.indexOf('- entry 2'));
    // Only one Notes heading despite two appends.
    expect(body.split('## Notes').length - 1).toBe(1);
  });

  test('missing section on existing page is created at EOF', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- under timeline', section: 'Timeline' });
    const r = await appendToPageDb(engine, { slug: SLUG, content: '- fresh section entry', section: 'Brand New' });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.section_created).toBe(true);
    expect(r.created).toBe(false);

    const body = (await readPageMarkdown(engine, SLUG))!.markdown;
    expect(body.indexOf('## Timeline')).toBeLessThan(body.indexOf('## Brand New'));
    expect(body).toContain('- fresh section entry');
  });

  test('EOF append when section omitted lands after existing sections', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- under timeline', section: 'Timeline' });
    const r = await appendToPageDb(engine, { slug: SLUG, content: '- at eof' });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.section_created).toBe(false);

    const body = (await readPageMarkdown(engine, SLUG))!.markdown;
    expect(body.indexOf('- under timeline')).toBeLessThan(body.indexOf('- at eof'));
  });

  test('returned content_hash matches a subsequent canonical read', async () => {
    const r = await appendToPageDb(engine, { slug: SLUG, content: '- hash pin', section: 'Notes' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const after = await readPageMarkdown(engine, SLUG);
    expect(after!.hash).toBe(r.content_hash);
  });

  // Split-brain regression pin (ported from the deleted markdown-writer
  // append.test.ts): writes land on DENT_SOURCE_ID, never 'default'. The
  // prod serve.ts read context was once hardcoded to 'default', which made
  // everything written here invisible — the bug that stranded the v0.43
  // bulk imports.
  test('write lands on DENT_SOURCE_ID and is invisible to a default-scoped read', async () => {
    await appendToPageDb(engine, {
      slug: SLUG,
      content: '- 2026-05-02 canonical observation',
      section: 'Timeline',
    });

    const onDent = await engine.getPage(SLUG, { sourceId: DENT_SOURCE_ID });
    expect(onDent).not.toBeNull();
    expect(`${onDent?.compiled_truth ?? ''}${onDent?.timeline ?? ''}`).toContain('canonical observation');

    const onDefault = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(onDefault).toBeNull();
  });

  test('frontmatter survives the append round-trip', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- seed', section: 'Timeline' });
    // Bootstrap frontmatter: title survives the canonical round-trip.
    const first = (await readPageMarkdown(engine, SLUG))!.markdown;
    expect(first).toContain('title: test-subject');
    expect(first).toContain('type: person');

    await appendToPageDb(engine, { slug: SLUG, content: '- more', section: 'Timeline' });
    const second = (await readPageMarkdown(engine, SLUG))!.markdown;
    expect(second).toContain('title: test-subject');
    expect(second).toContain('type: person');
    expect(second).toContain('- seed');
    expect(second).toContain('- more');
  });

  test('rejects empty content', async () => {
    const r = await appendToPageDb(engine, { slug: SLUG, content: '   ' });
    expect(r.status).toBe('error');
  });

  test('rejects traversal slugs structurally (throws DentOperationError)', async () => {
    let thrown: unknown;
    try {
      await appendToPageDb(engine, { slug: '../../etc/passwd', content: '- bad' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
  });

  test('oversized result throws content_too_large', async () => {
    const huge = 'x'.repeat(MAX_PAGE_BYTES + 1);
    let thrown: unknown;
    try {
      await appendToPageDb(engine, { slug: SLUG, content: huge });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect((thrown as DentOperationError).message).toContain('bytes');
    // Nothing was written.
    expect(await readPageMarkdown(engine, SLUG)).toBeNull();
  });

  test('held dent-page lock → {status: busy}', async () => {
    const lock = await tryAcquireDbLock(engine, `dent-page:${SLUG}`);
    expect(lock).not.toBeNull();
    try {
      const r = await appendToPageDb(engine, { slug: SLUG, content: '- blocked' });
      expect(r.status).toBe('busy');
    } finally {
      await lock!.release();
    }
    // After release, the same write goes through.
    const after = await appendToPageDb(engine, { slug: SLUG, content: '- unblocked' });
    expect(after.status).toBe('ok');
  });
});
