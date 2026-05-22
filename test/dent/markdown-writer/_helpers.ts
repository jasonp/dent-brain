/**
 * Shared test setup for markdown-writer integration tests.
 *
 * Spins up:
 *   - PGLite engine + gbrain core schema + dent migrations + sources upsert.
 *   - A bare repo (the "remote") + a working clone (what the server treats as
 *     `/app/dent-brain-data`). No SSH; commits use --local user.name/email and
 *     `file://` push URL so no deploy key is needed.
 *   - A repo context wired into the markdown-writer singleton.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { runDentMigrations } from '../../../src/dent/migrate.ts';
import {
  __setRepoContextForTests,
  __resetRepoContextForTests,
  DENT_SOURCE_ID,
} from '../../../src/dent/markdown-writer/repo.ts';
import { __resetWriteRateForTests } from '../../../src/dent/operations/markdown-write.ts';
import type { OperationContext } from '../../../src/core/operations.ts';
import type { BrainEngine } from '../../../src/core/engine.ts';

export interface MdWriterFixture {
  engine: PGLiteEngine;
  workdir: string;
  bareRepo: string;
  cloneRepo: string;
  cleanup: () => Promise<void>;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: env ?? process.env,
  }).trim();
}

export async function setupMarkdownWriter(): Promise<MdWriterFixture> {
  const workdir = mkdtempSync(join(tmpdir(), 'dent-mdwriter-'));
  const bareRepo = join(workdir, 'remote.git');
  const cloneRepo = join(workdir, 'clone');
  const seedRepo = join(workdir, 'seed');

  // Create bare "remote".
  mkdirSync(bareRepo);
  execFileSync('git', ['init', '--bare', '-b', 'master', bareRepo], { encoding: 'utf-8' });

  // Seed the remote with one commit so origin/master exists.
  mkdirSync(seedRepo);
  execFileSync('git', ['init', '-b', 'master', seedRepo], { encoding: 'utf-8' });
  git(seedRepo, ['config', 'user.email', 'test@example.com']);
  git(seedRepo, ['config', 'user.name', 'Test']);
  writeFileSync(join(seedRepo, 'README.md'), '# Test\n');
  git(seedRepo, ['add', 'README.md']);
  git(seedRepo, ['commit', '-m', 'init']);
  git(seedRepo, ['remote', 'add', 'origin', bareRepo]);
  git(seedRepo, ['push', '-u', 'origin', 'master']);

  // Clone into the path the markdown-writer treats as "the server's checkout".
  execFileSync('git', ['clone', bareRepo, cloneRepo], { encoding: 'utf-8' });
  git(cloneRepo, ['config', 'user.email', 'dent-brain-server@example.com']);
  git(cloneRepo, ['config', 'user.name', 'dent-brain-server']);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runDentMigrations(engine);

  // Upsert the sources row that performSync({sourceId: 'dent'}) resolves.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path`,
    [DENT_SOURCE_ID, 'Dent Brain markdown', cloneRepo, JSON.stringify({ federated: true, syncEnabled: true, strategy: 'markdown' })],
  );

  // Wire the repo context — no SSH needed since origin URL is local file path.
  const headCommit = git(cloneRepo, ['rev-parse', 'HEAD']);
  __setRepoContextForTests({
    repoPath: cloneRepo,
    headCommit,
    gitEnv: process.env,
    branch: 'master', // fixture creates the bare repo with -b master
  });
  __resetWriteRateForTests();

  const cleanup = async () => {
    try { await engine.disconnect(); } catch { /* noop */ }
    __resetRepoContextForTests();
    __resetWriteRateForTests();
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ }
  };

  return { engine, workdir, bareRepo, cloneRepo, cleanup };
}

export function makeCtx(engine: BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun,
    remote: true,
    sourceId: 'default',
  };
}

export function rawGit(cwd: string, args: string[]): string {
  return git(cwd, args);
}
