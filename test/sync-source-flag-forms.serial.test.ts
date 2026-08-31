/**
 * `gbrain sync --source=<id>` must route exactly like `gbrain sync --source <id>`.
 *
 * Every CLI_ONLY command read its flags with
 * `args.find((a, i) => args[i - 1] === '--source')`, which only matches the
 * space-separated form. `sync` is CLI_ONLY, so `parseOpArgs`'s `--key=value`
 * handling never runs for it — the equals form was silently dropped and sync
 * fell through to the AMBIENT source chain, writing pages and taking the
 * per-source lock under a source the operator never named. The failure was
 * invisible: it even printed "pass --source to override" at an operator who
 * had just done exactly that.
 *
 * This pins the WIRING (sync.ts actually calls the helper), not the helper
 * itself — `readFlagValue`'s own semantics are unit-tested in
 * test/cli-options.test.ts.
 *
 * Serial + real CLI subprocesses: the arg-parsing path under test only exists
 * in the CLI entrypoint, and PGLite is single-writer.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let home: string;
let repo: string;

function runCli(args: string[]) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: home,
    HOME: home,
    GBRAIN_SWEEP: '0',
  };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_BRAIN_ID;
  delete env.GBRAIN_SOURCE;
  const r = spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gb-sff-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify(
      { engine: 'pglite', database_path: join(home, 'db'), embedding_dimensions: 1536 },
      null,
      2,
    ),
  );

  repo = mkdtempSync(join(tmpdir(), 'gb-sff-repo-'));
  mkdirSync(join(repo, 'topics'), { recursive: true });
  writeFileSync(join(repo, 'topics', 'note.md'), '---\ntype: concept\ntitle: Note\n---\n\nBody.\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });

  // One registered source. With exactly one non-default source, the ambient
  // chain's `sole_non_default` tier resolves to it — so a DROPPED --source
  // silently "succeeds" against 'workspace' instead of erroring. That is the
  // shape that hid this bug, and it is what makes the assertions below sharp.
  const added = runCli(['sources', 'add', 'workspace', '--path', repo]);
  expect(added.code, added.err).toBe(0);
}, 180_000);

afterAll(() => {
  for (const dir of [home, repo]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('sync honors both --source forms identically', () => {
  test('--source=<unknown> fails loudly instead of falling through to the ambient chain', () => {
    const r = runCli(['sync', '--source=nosuchsource', '--no-pull', '--yes', '--no-embed']);

    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('nosuchsource');
    // The regression: it used to drop the flag, resolve 'workspace' via the
    // sole_non_default tier, and sync the wrong source with exit 0.
    expect(r.out + r.err).not.toMatch(/routing to source 'workspace'/);
  }, 120_000);

  test('--source <unknown> (space form) behaves the same', () => {
    const r = runCli(['sync', '--source', 'nosuchsource', '--no-pull', '--yes', '--no-embed']);

    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('nosuchsource');
  }, 120_000);

  // Honoring the equals spelling made these two values REACHABLE for the first
  // time, so each needed a guard the old code never had to have.
  test('--strategy=<typo> is rejected instead of silently WIDENING the ingest set', () => {
    // isAllowedByStrategy's fallback branch is the widest admission set
    // (markdown + code + images). Pre-fix an equals-spelled typo was dropped
    // and fell back to narrow 'markdown'; honoring it without validation would
    // have broadened ingest and embed spend on a typo.
    const r = runCli(['sync', '--source=workspace', '--strategy=typoo', '--no-pull', '--yes', '--no-embed']);

    expect(r.code).toBe(2);
    expect(r.out + r.err).toMatch(/Invalid --strategy value: "typoo"/);
  }, 120_000);

  test('--strategy=<valid> is accepted', () => {
    const r = runCli(['sync', '--source=workspace', '--strategy=markdown', '--no-pull', '--yes', '--no-embed']);

    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).not.toMatch(/Invalid --strategy/);
  }, 120_000);

  test('--source=<known> is accepted and routes to that source', () => {
    const r = runCli(['sync', '--source=workspace', '--no-pull', '--yes', '--no-embed']);

    expect(r.code, r.err).toBe(0);
    // Resolved by the FLAG, so the sole-non-default auto-route nudge (which
    // only fires on the ambient path) must not appear.
    expect(r.out + r.err).not.toMatch(/sole non-default source registered/);
  }, 120_000);
});

// capture is a WRITE path, and the one where the old behavior was worst: it did
// not just read the wrong source, it filed the page under it and reported
// success. Pre-fix this test's command created `inbox/<date>-<hash>`.
describe('capture honors --source= on a write path', () => {
  test('--source=<unknown> refuses instead of silently filing under the ambient source', () => {
    const r = runCli(['capture', 'a note for the flag-form test', '--source=nosuchsource']);

    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain('nosuchsource');
    expect(r.out + r.err).not.toMatch(/captured:/);
  }, 120_000);
});
