/**
 * DB-direct replace tests (single-brain Stage C): optimistic concurrency
 * via expected_prior_hash, no-op short-circuit, size guard, lock behavior,
 * and page_versions snapshots (the git-history replacement).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../helpers/reset-pglite.ts';
import { tryAcquireDbLock } from '../../../src/core/db-lock.ts';
import { replacePageDb } from '../../../src/dent/db-writer/replace.ts';
import { appendToPageDb } from '../../../src/dent/db-writer/append.ts';
import { DentOperationError } from '../../../src/dent/errors.ts';
import {
  DENT_SOURCE_ID,
  MAX_PAGE_BYTES,
  readPageMarkdown,
} from '../../../src/dent/db-writer/page-io.ts';
import { upsertDentSource } from './_helpers.ts';

setDefaultTimeout(30_000);

const SLUG = 'entities/people/replace-subject';

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

describe('replacePageDb', () => {
  test('creates brand-new page (no expected_prior_hash); lands on source dent', async () => {
    const content = `---\ntitle: replace-subject\nslug: ${SLUG}\n---\n\nfresh page body\n`;
    const r = await replacePageDb(engine, { slug: SLUG, content });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(true);

    const onDent = await engine.getPage(SLUG, { sourceId: DENT_SOURCE_ID });
    expect(onDent).not.toBeNull();
    expect(onDent!.compiled_truth ?? '').toContain('fresh page body');
    // Invisible to a default-scoped read (split-brain pin).
    expect(await engine.getPage(SLUG, { sourceId: 'default' })).toBeNull();
  });

  test('overwrites when expected_prior_hash matches the current rendering', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- seed', section: 'Notes' });
    const prior = await readPageMarkdown(engine, SLUG);

    const newContent = `---\ntitle: replaced\nslug: ${SLUG}\n---\n\nfully rewritten body\n`;
    const r = await replacePageDb(engine, {
      slug: SLUG,
      content: newContent,
      expected_prior_hash: prior!.hash,
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(false);

    const after = await readPageMarkdown(engine, SLUG);
    expect(after!.markdown).toContain('fully rewritten body');
    expect(after!.markdown).not.toContain('- seed');
    expect(after!.hash).toBe(r.content_hash);
  });

  test('stale expected_prior_hash → page_changed with current content + hash', async () => {
    await appendToPageDb(engine, { slug: SLUG, content: '- seed', section: 'Notes' });
    const r = await replacePageDb(engine, {
      slug: SLUG,
      content: 'attempted overwrite',
      expected_prior_hash: 'deadbeef'.repeat(8),
    });

    expect(r.status).toBe('page_changed');
    if (r.status !== 'page_changed') return;
    expect(r.current_content).toContain('- seed');

    const current = await readPageMarkdown(engine, SLUG);
    expect(r.current_content).toBe(current!.markdown);
    expect(r.current_hash).toBe(current!.hash);
    // Page untouched.
    expect(current!.markdown).not.toContain('attempted overwrite');
  });

  test('no-op short-circuit when content is byte-identical (no new version)', async () => {
    const initial = `---\ntitle: x\nslug: ${SLUG}\n---\n\nbody\n`;
    await replacePageDb(engine, { slug: SLUG, content: initial });
    const canonical = await readPageMarkdown(engine, SLUG);

    const versionsBefore = await engine.getVersions(SLUG, { sourceId: DENT_SOURCE_ID });
    const r = await replacePageDb(engine, {
      slug: SLUG,
      content: canonical!.markdown,
      expected_prior_hash: canonical!.hash,
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.created).toBe(false);
    expect(r.content_hash).toBe(canonical!.hash);
    const versionsAfter = await engine.getVersions(SLUG, { sourceId: DENT_SOURCE_ID });
    expect(versionsAfter.length).toBe(versionsBefore.length);
  });

  test('two replaces → page_versions holds the prior snapshot', async () => {
    const v1 = `---\ntitle: x\nslug: ${SLUG}\n---\n\nversion one body\n`;
    const v2 = `---\ntitle: x\nslug: ${SLUG}\n---\n\nversion two body\n`;
    await replacePageDb(engine, { slug: SLUG, content: v1 });
    const r2 = await replacePageDb(engine, { slug: SLUG, content: v2 });
    expect(r2.status).toBe('ok');

    const versions = await engine.getVersions(SLUG, { sourceId: DENT_SOURCE_ID });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    // The snapshot importFromContent took before the second write carries
    // the v1 body — this is the git-history replacement contract.
    const snapshots = versions.map((v) => v.compiled_truth ?? '').join('\n');
    expect(snapshots).toContain('version one body');
  });

  test('oversized content throws content_too_large before any write', async () => {
    const huge = 'x'.repeat(MAX_PAGE_BYTES + 1);
    let thrown: unknown;
    try {
      await replacePageDb(engine, { slug: SLUG, content: huge });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect(await readPageMarkdown(engine, SLUG)).toBeNull();
  });

  test('rejects empty content', async () => {
    const r = await replacePageDb(engine, { slug: SLUG, content: '' });
    expect(r.status).toBe('error');
  });

  test('rejects traversal slugs (throws DentOperationError)', async () => {
    let thrown: unknown;
    try {
      await replacePageDb(engine, { slug: '../escape', content: 'x' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
  });

  test('held dent-page lock → {status: busy}', async () => {
    const lock = await tryAcquireDbLock(engine, `dent-page:${SLUG}`);
    expect(lock).not.toBeNull();
    try {
      const r = await replacePageDb(engine, { slug: SLUG, content: 'blocked write\n' });
      expect(r.status).toBe('busy');
    } finally {
      await lock!.release();
    }
  });
});
