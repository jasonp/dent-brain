/**
 * Unit tests for the v0.45 single-brain reconciliation script
 * (scripts/dent/migrate-v0.45-single-brain.ts), run against PGLite and a
 * tiny local git fixture.
 *
 * Covers winner selection (dent-only keep, default-only write, newest-wins
 * across the three stores, tie → git), dry-run write suppression,
 * idempotency of --apply, config hygiene, and purge counts + delete.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { DENT_SOURCE_ID, readPageMarkdown } from '../../src/dent/db-writer/page-io.ts';
import {
  reconcile,
  purgeDefault,
  listGitSlugs,
  gitFileTimestampMs,
} from '../../scripts/dent/migrate-v0.45-single-brain.ts';

setDefaultTimeout(60_000);

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
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [DENT_SOURCE_ID, 'Dent Brain (export mirror)'],
  );
});

// ---------------------------------------------------------------------------
// Git fixture: plain local repo with files committed at controlled dates.
// ---------------------------------------------------------------------------

interface RepoFixture {
  repo: string;
  ref: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: { ...process.env, ...(env ?? {}) },
  }).trim();
}

/** Build a repo whose managed files are committed at a fixed date. */
function setupRepo(files: Record<string, string>, commitIso: string): RepoFixture {
  const repo = mkdtempSync(join(tmpdir(), 'dent-v045-'));
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' });
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'fixture'], {
    GIT_AUTHOR_DATE: commitIso,
    GIT_COMMITTER_DATE: commitIso,
  });
  const ref = git(repo, ['rev-parse', 'HEAD']);
  return { repo, ref, cleanup: () => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ } } };
}

async function seedPage(sourceId: string, slug: string, body: string): Promise<void> {
  const r = await importFromContent(engine, slug, body, { sourceId, noEmbed: true });
  expect(r.status).not.toBe('error');
}

async function setUpdatedAt(sourceId: string, slug: string, iso: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET updated_at = $1::timestamptz WHERE source_id = $2 AND slug = $3`,
    [iso, sourceId, slug],
  );
}

// ---------------------------------------------------------------------------

describe('listGitSlugs / gitFileTimestampMs', () => {
  test('lists only managed paths at the pinned ref; timestamps come from the commit', () => {
    const fx = setupRepo({
      'notes/a.md': 'A\n',
      'README.md': 'root, human-owned\n',
      '_ingest/pending.md': 'underscore, not managed\n',
      'notes/script.sh': 'not md\n',
    }, '2026-01-15T12:00:00Z');
    try {
      const slugs = listGitSlugs(fx.repo, fx.ref);
      expect([...slugs.keys()]).toEqual(['notes/a']);
      expect(gitFileTimestampMs(fx.repo, fx.ref, 'notes/a.md')).toBe(Date.parse('2026-01-15T12:00:00Z'));
    } finally {
      fx.cleanup();
    }
  });
});

describe('reconcile — winner selection', () => {
  test('dent-only slug is kept, no write; default-only slug is copied to dent; git-only slug is imported', async () => {
    const fx = setupRepo({ 'notes/git-only.md': '---\ntitle: Git Only\n---\n\ngit only body\n' }, '2026-01-10T00:00:00Z');
    try {
      await seedPage(DENT_SOURCE_ID, 'notes/dent-only', '---\ntitle: Dent Only\n---\n\ndent only body\n');
      await seedPage('default', 'notes/default-only', '---\ntitle: Default Only\n---\n\ndefault only body\n');

      const reportPath = join(tmpdir(), `v045-report-${process.pid}.jsonl`);
      const { summary, records } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true, reportPath });

      expect(summary.errors).toBe(0);
      expect(summary.total_slugs).toBe(3);
      expect(summary.writes).toBe(2); // default-only + git-only

      const bySlug = new Map(records.map((r) => [r.slug, r]));
      expect(bySlug.get('notes/dent-only')!.decision).toBe('only_dent_keep');
      expect(bySlug.get('notes/dent-only')!.wrote).toBe(false);
      expect(bySlug.get('notes/default-only')!.winner).toBe('default');
      expect(bySlug.get('notes/default-only')!.wrote).toBe(true);
      expect(bySlug.get('notes/git-only')!.winner).toBe('git');
      expect(bySlug.get('notes/git-only')!.wrote).toBe(true);

      // Written content landed on source 'dent'.
      expect((await readPageMarkdown(engine, 'notes/default-only'))!.markdown).toContain('default only body');
      expect((await readPageMarkdown(engine, 'notes/git-only'))!.markdown).toContain('git only body');

      // JSONL report has one line per slug.
      const lines = readFileSync(reportPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(3);
      expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
      rmSync(reportPath, { force: true });
    } finally {
      fx.cleanup();
    }
  });

  test('conflicting copies: newest wins (git newest → git content lands on dent)', async () => {
    const fx = setupRepo(
      { 'notes/conflict.md': '---\ntitle: Conflict\n---\n\nGIT VERSION newest\n' },
      '2026-06-01T00:00:00Z',
    );
    try {
      await seedPage(DENT_SOURCE_ID, 'notes/conflict', '---\ntitle: Conflict\n---\n\ndent version old\n');
      await setUpdatedAt(DENT_SOURCE_ID, 'notes/conflict', '2026-05-01T00:00:00Z');
      await seedPage('default', 'notes/conflict', '---\ntitle: Conflict\n---\n\ndefault version older\n');
      await setUpdatedAt('default', 'notes/conflict', '2026-04-01T00:00:00Z');

      const { summary, records } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(summary.errors).toBe(0);
      expect(records[0].winner).toBe('git');
      expect(records[0].wrote).toBe(true);
      expect((await readPageMarkdown(engine, 'notes/conflict'))!.markdown).toContain('GIT VERSION newest');
    } finally {
      fx.cleanup();
    }
  });

  test('conflicting copies: dent newest → kept, no write', async () => {
    const fx = setupRepo(
      { 'notes/dent-newest.md': '---\ntitle: X\n---\n\ngit version old\n' },
      '2026-03-01T00:00:00Z',
    );
    try {
      await seedPage(DENT_SOURCE_ID, 'notes/dent-newest', '---\ntitle: X\n---\n\ndent version newest\n');
      await setUpdatedAt(DENT_SOURCE_ID, 'notes/dent-newest', '2026-06-01T00:00:00Z');

      const { summary, records } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(summary.errors).toBe(0);
      expect(records[0].decision).toBe('keep_dent_newest');
      expect(records[0].wrote).toBe(false);
      expect(summary.writes).toBe(0);
      expect((await readPageMarkdown(engine, 'notes/dent-newest'))!.markdown).toContain('dent version newest');
    } finally {
      fx.cleanup();
    }
  });

  test('exact timestamp tie between git and dent → git wins', async () => {
    const tieIso = '2026-05-15T08:00:00Z';
    const fx = setupRepo(
      { 'notes/tie.md': '---\ntitle: Tie\n---\n\nGIT tie content\n' },
      tieIso,
    );
    try {
      await seedPage(DENT_SOURCE_ID, 'notes/tie', '---\ntitle: Tie\n---\n\ndent tie content\n');
      await setUpdatedAt(DENT_SOURCE_ID, 'notes/tie', tieIso);

      const { records } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(records[0].winner).toBe('git');
      expect(records[0].wrote).toBe(true);
      expect((await readPageMarkdown(engine, 'notes/tie'))!.markdown).toContain('GIT tie content');
    } finally {
      fx.cleanup();
    }
  });

  test('dry-run makes no writes and leaves config alone', async () => {
    const fx = setupRepo({ 'notes/dry.md': '---\ntitle: Dry\n---\n\ngit dry body\n' }, '2026-01-01T00:00:00Z');
    try {
      await engine.setConfig('sync.repo_path', '/home/someone/dent-brain-data');

      const { summary, records } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: false });
      expect(summary.would_write).toBe(1);
      expect(summary.writes).toBe(0);
      expect(records[0].wrote).toBe(false);

      // Nothing landed; config key survives a dry-run.
      expect(await readPageMarkdown(engine, 'notes/dry')).toBeNull();
      expect(await engine.getConfig('sync.repo_path')).toBe('/home/someone/dent-brain-data');
    } finally {
      fx.cleanup();
    }
  });

  test('--apply deletes the sync.repo_path config key', async () => {
    const fx = setupRepo({ 'notes/cfg.md': 'body\n' }, '2026-01-01T00:00:00Z');
    try {
      await engine.setConfig('sync.repo_path', '/home/someone/dent-brain-data');
      const { summary } = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(summary.config_repo_path_deleted).toBe(true);
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test('idempotent: second --apply run performs 0 writes', async () => {
    const fx = setupRepo(
      { 'notes/idem.md': '---\ntitle: Idem\n---\n\ngit idem body\n' },
      '2026-06-01T00:00:00Z',
    );
    try {
      await seedPage(DENT_SOURCE_ID, 'notes/idem', '---\ntitle: Idem\n---\n\ndent idem old\n');
      await setUpdatedAt(DENT_SOURCE_ID, 'notes/idem', '2026-01-01T00:00:00Z');
      await seedPage('default', 'notes/only-default-idem', '---\ntitle: D\n---\n\ndefault body\n');

      const first = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(first.summary.errors).toBe(0);
      expect(first.summary.writes).toBe(2);

      const second = await reconcile(engine, { repo: fx.repo, ref: fx.ref, apply: true });
      expect(second.summary.errors).toBe(0);
      expect(second.summary.writes).toBe(0);
      expect(second.summary.would_write).toBe(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('purgeDefault', () => {
  test('counts per table, deletes default-source rows + children, leaves dent intact', async () => {
    await seedPage('default', 'notes/purge-me', '---\ntitle: Purge\ntags: [a, b]\n---\n\npurge body\n\n[[notes/keep-me]]\n');
    await seedPage('default', 'notes/purge-me-too', '---\ntitle: Purge2\n---\n\npurge body 2\n');
    await seedPage(DENT_SOURCE_ID, 'notes/keep-me', '---\ntitle: Keep\n---\n\nkeep body\n');

    const preview = await purgeDefault(engine, { apply: false });
    expect(preview.deleted).toBe(false);
    expect(preview.counts.pages).toBe(2);
    // Preview does not delete.
    const stillThere = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'`,
    );
    expect(Number(stillThere[0].n)).toBe(2);

    const purged = await purgeDefault(engine, { apply: true });
    expect(purged.deleted).toBe(true);
    expect(purged.counts.pages).toBe(2);

    const after = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'`,
    );
    expect(Number(after[0].n)).toBe(0);

    // Dent rows untouched.
    expect(await readPageMarkdown(engine, 'notes/keep-me')).not.toBeNull();

    // No orphaned children left behind.
    for (const table of ['content_chunks', 'tags', 'timeline_entries', 'page_versions', 'raw_data']) {
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = t.page_id)`,
      );
      expect(Number(rows[0].n)).toBe(0);
    }

    // Idempotent: a second purge counts 0 and succeeds.
    const again = await purgeDefault(engine, { apply: true });
    expect(again.counts.pages).toBe(0);
  });
});
