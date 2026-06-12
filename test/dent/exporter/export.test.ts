/**
 * One-way DB→git exporter tests (single-brain Stage C).
 *
 * Uses a local bare repo + working clone fixture (the same shape the
 * deleted markdown-writer/_helpers.ts used) — no SSH, no deploy key:
 * the clone's origin is a file:// path, the MirrorRepoContext is built
 * by hand instead of via ensureMirrorRepo (which reads env + PEM).
 *
 * Covers: flat <slug>.md materialization, single commit + push, orphan
 * pruning per isManagedPath, human-owned file preservation (repo root,
 * dot-/underscore-segments), no-change idempotency, the dent-export
 * lock, the isManagedPath rule itself, and the exportTick once-per-day
 * cron gating (pattern mirrored from test/dent/nightly-maintenance.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../helpers/reset-pglite.ts';
import { tryAcquireDbLock } from '../../../src/core/db-lock.ts';
import { importFromContent } from '../../../src/core/import-file.ts';
import { exportBrainToGit, isManagedPath, DENT_EXPORT_LOCK_ID } from '../../../src/dent/exporter/export.ts';
import { exportTick } from '../../../src/dent/exporter/cron.ts';
import type { MirrorRepoContext } from '../../../src/dent/exporter/repo.ts';
import { DENT_SOURCE_ID, readPageMarkdown } from '../../../src/dent/db-writer/page-io.ts';
import type { BrainEngine } from '../../../src/core/engine.ts';

setDefaultTimeout(30_000);

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
       VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [DENT_SOURCE_ID, 'Dent Brain (export mirror)', JSON.stringify({ mirror: true, syncEnabled: false })],
  );
});

// ---------------------------------------------------------------------------
// Git fixture (bare "remote" + working clone), ported from the deleted
// test/dent/markdown-writer/_helpers.ts.
// ---------------------------------------------------------------------------

interface GitFixture {
  workdir: string;
  bareRepo: string;
  cloneRepo: string;
  ctx: MirrorRepoContext;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();
}

function setupGitFixture(): GitFixture {
  const workdir = mkdtempSync(join(tmpdir(), 'dent-exporter-'));
  const bareRepo = join(workdir, 'remote.git');
  const cloneRepo = join(workdir, 'clone');
  const seedRepo = join(workdir, 'seed');

  mkdirSync(bareRepo);
  execFileSync('git', ['init', '--bare', '-b', 'master', bareRepo], { encoding: 'utf-8' });

  // Seed the remote: human-owned root file + dot/underscore-segment files +
  // one managed orphan (no DB row → exporter must prune it).
  mkdirSync(seedRepo);
  execFileSync('git', ['init', '-b', 'master', seedRepo], { encoding: 'utf-8' });
  git(seedRepo, ['config', 'user.email', 'test@example.com']);
  git(seedRepo, ['config', 'user.name', 'Test']);
  writeFileSync(join(seedRepo, 'README.md'), '# Human-owned root file\n');
  mkdirSync(join(seedRepo, '.github'));
  writeFileSync(join(seedRepo, '.github', 'workflow-notes.md'), 'dot-dir file\n');
  mkdirSync(join(seedRepo, '_meta'));
  writeFileSync(join(seedRepo, '_meta', 'notes.md'), 'underscore-dir file\n');
  mkdirSync(join(seedRepo, 'entities', 'people'), { recursive: true });
  writeFileSync(join(seedRepo, 'entities', 'people', 'orphan-no-db-row.md'), '# Orphan\n');
  git(seedRepo, ['add', '-A']);
  git(seedRepo, ['commit', '-m', 'init']);
  git(seedRepo, ['remote', 'add', 'origin', bareRepo]);
  git(seedRepo, ['push', '-u', 'origin', 'master']);

  execFileSync('git', ['clone', bareRepo, cloneRepo], { encoding: 'utf-8' });
  git(cloneRepo, ['config', 'user.email', 'dent-brain-server@example.com']);
  git(cloneRepo, ['config', 'user.name', 'dent-brain-server']);

  const ctx: MirrorRepoContext = {
    repoPath: cloneRepo,
    headCommit: git(cloneRepo, ['rev-parse', 'HEAD']),
    gitEnv: process.env,
    branch: 'master',
  };

  return {
    workdir,
    bareRepo,
    cloneRepo,
    ctx,
    cleanup: () => {
      try { rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

async function seedDentPage(slug: string, body: string): Promise<void> {
  const imported = await importFromContent(engine, slug, body, {
    sourceId: DENT_SOURCE_ID,
    noEmbed: true,
  });
  expect(imported.status).not.toBe('error');
}

// ---------------------------------------------------------------------------
// isManagedPath (pure)
// ---------------------------------------------------------------------------

describe('isManagedPath', () => {
  test('manages nested *.md paths', () => {
    expect(isManagedPath('entities/people/alice-example.md')).toBe(true);
    expect(isManagedPath('daily/2026-06-11.md')).toBe(true);
    expect(isManagedPath('a/b/c/deep.md')).toBe(true);
  });

  test('repo-root files are human-owned', () => {
    expect(isManagedPath('README.md')).toBe(false);
    expect(isManagedPath('DENT_SCHEMA.md')).toBe(false);
  });

  test('non-md files are never managed', () => {
    expect(isManagedPath('entities/people/photo.png')).toBe(false);
    expect(isManagedPath('scripts/run.sh')).toBe(false);
  });

  test('dot- and underscore-segments are excluded at every level', () => {
    expect(isManagedPath('.github/x.md')).toBe(false);
    expect(isManagedPath('_meta/notes.md')).toBe(false);
    expect(isManagedPath('_ingest/pending_regfox.md')).toBe(false);
    expect(isManagedPath('entities/.hidden/x.md')).toBe(false);
    expect(isManagedPath('entities/_private/x.md')).toBe(false);
    expect(isManagedPath('entities/people/.dotfile.md')).toBe(false);
    expect(isManagedPath('entities/people/_underscore.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exportBrainToGit
// ---------------------------------------------------------------------------

describe('exportBrainToGit', () => {
  test('writes flat <slug>.md files, prunes orphans, preserves human-owned files, one commit', async () => {
    const fx = setupGitFixture();
    try {
      await seedDentPage('entities/people/alice-example', '---\ntitle: Alice Example\n---\n\n## Timeline\n\n- seeded\n');
      await seedDentPage('daily/2026-06-11', '---\ntitle: daily note\n---\n\nan archive page\n');

      const before = Number(git(fx.cloneRepo, ['rev-list', '--count', 'HEAD']));
      const result = await exportBrainToGit(engine, fx.ctx);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.pages).toBe(2);
      expect(result.written).toBe(2);
      expect(result.deleted).toBe(1); // the seeded orphan
      expect(result.committed).toBe(true);
      expect(result.commit_sha).toBeString();

      // Files land at flat <slug>.md paths with the canonical rendering.
      const alicePath = join(fx.cloneRepo, 'entities/people/alice-example.md');
      expect(existsSync(alicePath)).toBe(true);
      const canonical = await readPageMarkdown(engine, 'entities/people/alice-example');
      expect(readFileSync(alicePath, 'utf-8')).toBe(canonical!.markdown);
      expect(existsSync(join(fx.cloneRepo, 'daily/2026-06-11.md'))).toBe(true);

      // Orphan managed file pruned; human-owned files untouched.
      expect(existsSync(join(fx.cloneRepo, 'entities/people/orphan-no-db-row.md'))).toBe(false);
      expect(existsSync(join(fx.cloneRepo, 'README.md'))).toBe(true);
      expect(existsSync(join(fx.cloneRepo, '.github/workflow-notes.md'))).toBe(true);
      expect(existsSync(join(fx.cloneRepo, '_meta/notes.md'))).toBe(true);

      // Exactly one commit, and it reached the bare remote.
      const after = Number(git(fx.cloneRepo, ['rev-list', '--count', 'HEAD']));
      expect(after - before).toBe(1);
      const remoteLog = git(fx.bareRepo, ['log', '-1', '--pretty=%s']);
      expect(remoteLog).toContain('brain-export: 2 changed, 1 deleted');
    } finally {
      fx.cleanup();
    }
  });

  test('second export with no changes commits nothing', async () => {
    const fx = setupGitFixture();
    try {
      await seedDentPage('entities/people/stable-page', '---\ntitle: Stable\n---\n\nunchanging body\n');

      const first = await exportBrainToGit(engine, fx.ctx);
      expect(first.status).toBe('ok');

      const countAfterFirst = git(fx.cloneRepo, ['rev-list', '--count', 'HEAD']);
      const second = await exportBrainToGit(engine, fx.ctx);

      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.written).toBe(0);
      expect(second.deleted).toBe(0);
      expect(second.committed).toBe(false);
      expect(git(fx.cloneRepo, ['rev-list', '--count', 'HEAD'])).toBe(countAfterFirst);
    } finally {
      fx.cleanup();
    }
  });

  test('held dent-export lock → {status: busy}', async () => {
    const fx = setupGitFixture();
    try {
      const lock = await tryAcquireDbLock(engine, DENT_EXPORT_LOCK_ID);
      expect(lock).not.toBeNull();
      try {
        const result = await exportBrainToGit(engine, fx.ctx);
        expect(result.status).toBe('busy');
      } finally {
        await lock!.release();
      }
    } finally {
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// exportTick — once-per-UTC-day gating (mirrors nightly-maintenance.test.ts)
// ---------------------------------------------------------------------------

function mockEngine(initialLastRun?: string): BrainEngine {
  let lastRun: string | null = initialLastRun ?? null;
  return {
    getConfig: async (k: string) => (k === 'dent_export_last_run' ? lastRun : null),
    setConfig: async (k: string, v: string) => {
      if (k === 'dent_export_last_run') lastRun = v;
    },
  } as unknown as BrainEngine;
}

describe('exportTick gating', () => {
  test('returns too_early when current UTC hour is before threshold', async () => {
    const result = await exportTick(mockEngine(), {
      hourUtc: 10,
      now: () => new Date('2026-06-11T07:30:00Z'),
      ensureRepoImpl: async () => { throw new Error('must not be called'); },
    });
    expect(result).toBe('too_early');
  });

  test('returns already_today when last_run is on the same UTC date', async () => {
    const result = await exportTick(mockEngine('2026-06-11T10:01:42.000Z'), {
      hourUtc: 10,
      now: () => new Date('2026-06-11T15:00:00Z'),
      ensureRepoImpl: async () => { throw new Error('must not be called'); },
    });
    expect(result).toBe('already_today');
  });

  test('marks the slot taken BEFORE running; ensure failure → failed, no re-fire today', async () => {
    const eng = mockEngine('2026-06-10T10:02:00.000Z'); // yesterday
    let ensureCalls = 0;
    const opts = {
      hourUtc: 10,
      now: () => new Date('2026-06-11T10:30:00Z'),
      ensureRepoImpl: async (): Promise<MirrorRepoContext> => {
        ensureCalls++;
        throw new Error('clone unavailable');
      },
    };
    const first = await exportTick(eng, opts);
    expect(first).toBe('failed');
    expect(ensureCalls).toBe(1);

    // The last-run mark was written before the failure — a second tick the
    // same day must NOT re-fire (skip a day rather than hot-loop).
    const second = await exportTick(eng, opts);
    expect(second).toBe('already_today');
    expect(ensureCalls).toBe(1);
  });

  test('fires for real against the PGLite engine + local repo fixture', async () => {
    const fx = setupGitFixture();
    try {
      await seedDentPage('entities/people/cron-export-page', '---\ntitle: Cron Export\n---\n\nbody\n');

      const result = await exportTick(engine, {
        hourUtc: 10,
        now: () => new Date('2026-06-11T10:05:00Z'),
        ensureRepoImpl: async () => fx.ctx,
      });

      expect(result).toBe('fired');
      expect(existsSync(join(fx.cloneRepo, 'entities/people/cron-export-page.md'))).toBe(true);
      const lastRun = await engine.getConfig('dent_export_last_run');
      expect(lastRun ?? '').toContain('2026-06-11');
    } finally {
      fx.cleanup();
    }
  });
});
