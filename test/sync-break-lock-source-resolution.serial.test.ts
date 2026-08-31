/**
 * `gbrain sync --break-lock` / `--force-break-lock` must resolve the source
 * the SAME way as the sync it is unblocking:
 * `--source` flag > `--repo`-derived > the ambient 6-tier chain.
 *
 * The lock key is per-source (`gbrain-sync:<sourceId>`). The break-lock branch
 * used to read ONLY the `--source` flag and fall back to `'default'`, so an
 * operator whose source comes from GBRAIN_SOURCE / `.gbrain-source` / a
 * cwd-matched local_path broke `gbrain-sync:default` — a key nobody held — and
 * got "nothing to break" with exit 0 while the real lock stayed wedged. The
 * misleading dead-end is exactly what the wedge hint exists to prevent, and it
 * is what made `Pin 4` of test/e2e/sync-delegation-under-serve.serial.test.ts
 * fail intermittently in CI (that pin force-breaks without `--source` under
 * GBRAIN_SOURCE=workspace).
 *
 * Real CLI subprocesses against a temp PGLite brain — the arg-parsing branch
 * under test only exists in the CLI entrypoint. Serial: the in-process engine
 * and the CLI child both want PGLite's single-writer lock, so every open is
 * opened and closed around the spawn.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let home: string;
let dbDir: string;
let repo: string;

/** Open the brain in-process, run `fn`, and always close before the next spawn. */
async function withEngine<T>(fn: (e: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  const config = { engine: 'pglite' as const, database_path: dbDir };
  await engine.connect(config);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

function runCli(args: string[], env: Record<string, string> = {}) {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: home,
    HOME: home,
    GBRAIN_SWEEP: '0',
    ...env,
  };
  // A dev/CI Postgres URL must not flip this sandboxed brain off PGLite.
  delete childEnv.DATABASE_URL;
  delete childEnv.GBRAIN_DATABASE_URL;
  delete childEnv.GBRAIN_BRAIN_ID;
  const r = spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * A planted lock row. Default pid is one nobody holds — the shape a SIGKILLed
 * holder leaves, which `--force` clears. Pass this process's own pid to get a
 * LIVE holder, which the safe (non-force) path must refuse.
 */
async function plantLock(lockKey: string, holderPid = 999_999): Promise<void> {
  await withEngine(async (e) => {
    await e.executeRaw(
      `INSERT INTO gbrain_cycle_locks
         (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW(), NOW() + interval '1 hour', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [lockKey, holderPid, hostname()],
    );
  });
}

async function heldLockIds(): Promise<string[]> {
  return withEngine(async (e) => {
    const rows = await e.executeRaw<{ id: string }>(
      `SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:%' ORDER BY id`,
    );
    return rows.map((r) => r.id);
  });
}

beforeAll(async () => {
  const parent = mkdtempSync(join(tmpdir(), 'gb-blsr-'));
  home = parent;
  dbDir = join(parent, 'db');
  mkdirSync(join(parent, '.gbrain'), { recursive: true });
  writeFileSync(
    join(parent, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir, embedding_dimensions: 1536 }, null, 2),
  );

  repo = mkdtempSync(join(tmpdir(), 'gb-blsr-repo-'));
  mkdirSync(join(repo, 'topics'), { recursive: true });
  writeFileSync(join(repo, 'topics', 'note.md'), '---\ntype: concept\ntitle: Note\n---\n\nBody.\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

  await withEngine(async (e) => { await e.initSchema(); });
  const added = runCli(['sources', 'add', 'workspace', '--path', repo]);
  expect(added.code, added.err).toBe(0);
}, 180_000);

afterAll(() => {
  for (const dir of [home, repo]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

beforeEach(async () => {
  await withEngine(async (e) => {
    await e.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:%'`);
  });
});

describe('sync --break-lock resolves the source the same way sync does', () => {
  test('GBRAIN_SOURCE (no --source flag) targets that source\'s lock, not gbrain-sync:default', async () => {
    await plantLock('gbrain-sync:workspace');

    // Precondition: without this, the post-assertions below pass vacuously
    // (an empty table trivially equals [], and the absent-lock wedge hint also
    // contains the key name).
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);

    const r = runCli(['sync', '--force-break-lock', '--yes'], { GBRAIN_SOURCE: 'workspace' });

    expect(r.code, r.err).toBe(0);
    // The regression: pre-fix this said "No lock is held on gbrain-sync:default".
    expect(r.out + r.err).not.toContain('gbrain-sync:default');
    // Assert it was actually BROKEN, not merely named — the wedge hint
    // ("No lock is held on gbrain-sync:workspace") also contains the key.
    expect(r.out + r.err).toMatch(/Force-broke lock gbrain-sync:workspace/);
    expect(await heldLockIds()).toEqual([]);
  }, 120_000);

  test('an explicit --source still wins over GBRAIN_SOURCE', async () => {
    await plantLock('gbrain-sync:workspace');
    await plantLock('gbrain-sync:default');

    const r = runCli(
      ['sync', '--force-break-lock', '--yes', '--source', 'default'],
      { GBRAIN_SOURCE: 'workspace' },
    );

    expect(r.code, r.err).toBe(0);
    // Only the flag's lock was broken; the env's source is untouched.
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);

  // An ambient `__all__` must NOT be reinterpreted as `--all`. `gbrain sync`
  // has no `__all__` handling — it hands the sentinel to performSync, which
  // takes `gbrain-sync:__all__`. Fanning out here would force-delete every
  // OTHER source's lock and miss the one actually wedged.
  test('GBRAIN_SOURCE=__all__ targets gbrain-sync:__all__, exactly like sync does', async () => {
    await plantLock('gbrain-sync:__all__');
    await plantLock('gbrain-sync:workspace');

    const r = runCli(['sync', '--force-break-lock', '--yes'], { GBRAIN_SOURCE: '__all__' });

    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/Force-broke lock gbrain-sync:__all__/);
    // The unrelated source's lock is untouched — no collateral fan-out.
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);

  test('--source=<id> (equals form) is honored, not silently resolved from the ambient chain', async () => {
    await plantLock('gbrain-sync:workspace');
    await plantLock('gbrain-sync:default');

    const r = runCli(['sync', '--force-break-lock', '--yes', '--source=default'], {
      GBRAIN_SOURCE: 'workspace',
    });

    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/Force-broke lock gbrain-sync:default/);
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);

  // break-lock is the RECOVERY tool: a source that wedged and was then archived
  // must still be clearable, or the only way out is hand-written SQL.
  test("an archived source's lock is still breakable", async () => {
    await withEngine(async (e) => {
      await e.executeRaw(`UPDATE sources SET archived = true WHERE id = 'workspace'`);
    });
    try {
      await plantLock('gbrain-sync:workspace');

      const r = runCli(['sync', '--force-break-lock', '--yes', '--source', 'workspace']);

      expect(r.code, r.err).toBe(0);
      expect(r.out + r.err).toMatch(/Force-broke lock gbrain-sync:workspace/);
      expect(await heldLockIds()).toEqual([]);
    } finally {
      await withEngine(async (e) => {
        await e.executeRaw(`UPDATE sources SET archived = false WHERE id = 'workspace'`);
      });
    }
  }, 120_000);

  // Behavior CHANGE, pinned deliberately. Routing through the resolver means an
  // unknown/archived source now raises SourceTargetError instead of minting
  // `gbrain-sync:<typo>` and reporting "not held" with exit 0. Exiting 0 on a
  // source the operator never meant is the same silent-success dead-end this
  // whole fix exists to remove, so the loud exit is the intended contract.
  test('an unknown --source fails loudly (exit 1) instead of breaking a phantom key', async () => {
    await plantLock('gbrain-sync:workspace');

    const r = runCli(['sync', '--break-lock', '--yes', '--source', 'nosuchsource']);

    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('nosuchsource');
    expect(r.out + r.err).not.toContain('gbrain-sync:nosuchsource');
    // The real lock is untouched — a typo must never clear someone's holder.
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);

  // The all-sources loop's populated case: one active source, so the per-source
  // envelope is what lands. (The empty-brain `no_sources` branch is pinned
  // separately below.)
  test('--all --json emits a per-source envelope for each active source', async () => {
    const r = runCli(['sync', '--force-break-lock', '--yes', '--all', '--json'], {
      GBRAIN_SOURCE: 'workspace',
    });

    expect(r.code, r.err).toBe(0);
    const line = (r.out + r.err).split('\n').find((l) => l.includes('"status"'));
    // `workspace` HAS a local_path, so this brain does have an active source —
    // the envelope under test is the per-source break, not the empty case.
    expect(line, `expected a JSON status envelope in:\n${r.out}${r.err}`).toBeTruthy();
    expect(JSON.parse(line!.trim())).toMatchObject({ source_id: 'workspace' });
  }, 120_000);

  // The genuinely-empty case: a SEPARATE brain with schema but no sources at
  // all, so `activeSources.length === 0` and the no_sources envelope is the
  // only reachable branch.
  test('--all --json on a brain with no sources emits the no_sources envelope', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'gb-blsr-empty-'));
    const emptyDb = join(emptyHome, 'db');
    mkdirSync(join(emptyHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(emptyHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: emptyDb, embedding_dimensions: 1536 }, null, 2),
    );
    try {
      const e = new PGLiteEngine();
      const cfg = { engine: 'pglite' as const, database_path: emptyDb };
      await e.connect(cfg);
      try { await e.initSchema(); } finally { await e.disconnect(); }

      const r = runCli(['sync', '--force-break-lock', '--yes', '--all', '--json'], {
        GBRAIN_HOME: emptyHome,
        HOME: emptyHome,
      });

      expect(r.code, r.err).toBe(0);
      const line = (r.out + r.err).split('\n').find((l) => l.includes('"status"'));
      expect(line, `expected a JSON envelope in:\n${r.out}${r.err}`).toBeTruthy();
      expect(JSON.parse(line!.trim())).toEqual({ status: 'no_sources' });
    } finally {
      try { rmSync(emptyHome, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 120_000);

  // #3765 parity: `--repo` anchors resolution at the REPO dir. Without it the
  // break targets the cwd/env-resolved key — the same wrong-key bug one tier
  // down. `workspace` is registered with local_path = repo, so --repo must
  // resolve there even though the CLI runs with cwd = REPO_ROOT.
  test('--repo anchors the lock key at the repo dir, not the caller cwd', async () => {
    await plantLock('gbrain-sync:workspace');
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);

    const r = runCli(['sync', '--force-break-lock', '--yes', '--repo', repo]);

    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/Force-broke lock gbrain-sync:workspace/);
    expect(await heldLockIds()).toEqual([]);
  }, 120_000);

  // `--all` skips resolution, so a narrowing flag beside it would be silently
  // ignored and the run would go fleet-wide. A typo'd --source must never
  // escalate into a force-delete of every lock.
  test('--all combined with --source is refused, not silently widened', async () => {
    await plantLock('gbrain-sync:workspace');

    const r = runCli(['sync', '--force-break-lock', '--yes', '--all', '--source', 'nosuchsource']);

    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/--all cannot be combined with --source/);
    // Nothing was broken — the refusal happens before any delete.
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);

  // worstExit max-fold: one refusing source must poison the whole --all run's
  // exit code, or a cron self-heal reports success while a lock survives.
  test('--all folds a per-source refusal into a non-zero exit', async () => {
    // Live holder + unexpired TTL: the SAFE path must refuse this one.
    await plantLock('gbrain-sync:workspace', process.pid);

    const r = runCli(['sync', '--break-lock', '--yes', '--all']);

    expect(r.code).toBe(1);
    expect(await heldLockIds()).toEqual(['gbrain-sync:workspace']);
  }, 120_000);
});
