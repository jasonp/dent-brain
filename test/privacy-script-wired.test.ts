/**
 * Regression guard: scripts/check-privacy.sh must run in CI's auto-pipeline.
 *
 * CLAUDE.md bans the private OpenClaw fork name from public artifacts.
 * scripts/check-privacy.sh is the enforcement mechanism. If someone
 * refactors the script chain and drops the privacy check, this test
 * fails loudly.
 *
 * v0.26.4 split: `bun run test` is now the fast parallel loop and does
 * NOT chain pre-checks; the privacy gate moved to `bun run verify`,
 * which CI's test.yml runs as its own job before the matrix fans out.
 *
 * v0.41.4+ wave (upstream): upstream's `bun run verify` delegates to
 * scripts/run-verify-parallel.sh which fans out all checks in parallel.
 *
 * dent-brain fork (v0.43 upstream sync): our `verify` stays the explicit
 * `&&` chain (it carries the dent-only `check:plugin-version` and
 * `check:newlines`/`check:exports-count` gates that the upstream parallel
 * dispatcher's CHECKS[] array does not list). The parallel dispatcher still
 * exists and is exposed as `verify:parallel`; adopting it wholesale is a
 * reconcile-later item (see TODOS — it pulls in check:proposal-pii +
 * operations-filter-bypass allowlisting). Regression guard therefore checks:
 * (1) verify directly chains check:privacy, (2) the parallel dispatcher
 * (still present) lists check:privacy, (3) CI's verify job calls
 * `bun run verify`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts/run-verify-parallel.sh');
const TEST_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test.yml');

describe('check-privacy.sh CI wiring', () => {
  it('scripts/check-privacy.sh exists and is executable', () => {
    expect(existsSync(PRIVACY_SCRIPT)).toBe(true);
    const stat = require('fs').statSync(PRIVACY_SCRIPT);
    // eslint-disable-next-line no-bitwise
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  it('verify dispatches the privacy + plugin-version gates', () => {
    // REWRITTEN in v0.50.0.0. This used to assert that `verify` was an explicit
    // `&&` chain containing both gate names, because the fork ran a serial chain
    // while upstream ran a parallel dispatcher. The upstream sync adopted the
    // dispatcher (39 checks in ~21s against our 15 serial), so substring-matching
    // package.json now tests the wrong thing — and would pass on a `verify` that
    // dispatches neither gate.
    //
    // What must remain true is that both gates actually RUN. Assert that against
    // the dispatcher's own --dry-list, the same authoritative mechanism the
    // sibling test below uses. check:plugin-version is fork-only and registered
    // in the CHECKS array; if a future upstream sync overwrites that array, this
    // test is what catches the loss.
    expect(existsSync(VERIFY_DISPATCHER)).toBe(true);
    const r = spawnSync('bash', [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const checks = r.stdout.trim().split('\n').map(s => s.trim());
    expect(checks).toContain('check:privacy');
    expect(checks).toContain('check:plugin-version');

    // And `verify` must route through that dispatcher, not something else.
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts?.verify).toContain('run-verify-parallel.sh');
  });

  it('run-verify-parallel.sh dispatches check:privacy', () => {
    expect(existsSync(VERIFY_DISPATCHER)).toBe(true);
    // The dispatcher exposes --dry-list which prints one check name per
    // line. Authoritative check than substring-grepping the script body
    // (which could pass on a commented-out entry).
    const r = spawnSync('bash', [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const checks = r.stdout.trim().split('\n');
    expect(checks).toContain('check:privacy');
  });

  it('package.json "check:privacy" alias points at the script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts?.['check:privacy']).toContain('check-privacy.sh');
  });

  it('CI test.yml runs `bun run verify` so the privacy gate fires', () => {
    expect(existsSync(TEST_WORKFLOW)).toBe(true);
    const yml = readFileSync(TEST_WORKFLOW, 'utf-8');
    expect(yml).toContain('bun run verify');
  });
});
