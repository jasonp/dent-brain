#!/usr/bin/env bun
/**
 * Upstream (garrytan/gbrain) drift check.
 *
 * Read-only. Adds/fetches the `upstream` remote (if missing/wrong) and
 * reports how many commits `main` is behind `upstream/master`, plus the
 * commit-date range and a skimmable list of subjects. Never merges, never
 * touches the working tree beyond fetching refs.
 *
 * Why this exists: this fork pulls upstream via manual, human-reviewed
 * merges (`bun run sync:upstream`) — drift has silently grown to 100+
 * commits between syncs before because nothing surfaced it. This script is
 * the detection half; `.github/workflows/upstream-sync-check.yml` runs it on
 * a schedule and files/updates a GitHub issue when drift is nonzero. The
 * actual sync stays 100% human/agent-driven via `bun run sync:upstream`
 * (scripts/sync-from-upstream.sh).
 *
 * Usage:
 *   bun run scripts/check-upstream-drift.ts             # human-readable, exits 1 on drift
 *   bun run scripts/check-upstream-drift.ts --json       # machine-readable for CI
 *   bun run scripts/check-upstream-drift.ts --quiet      # suppress info logs (drift/errors still print)
 *
 * Exit codes: 0 = in sync, 1 = drift found (actionable, not fatal), 2 = fatal
 * (git failure, shallow clone without full history, etc.)
 */

import { spawnSync } from 'node:child_process';

const UPSTREAM_URL = 'https://github.com/garrytan/gbrain.git';
const UPSTREAM_REF = 'upstream/master';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const QUIET = args.includes('--quiet');
const maxSubjectsArg = args.find((a) => a.startsWith('--max-subjects='));
const MAX_SUBJECTS = maxSubjectsArg ? parseInt(maxSubjectsArg.split('=')[1], 10) : 15;

function log(msg: string) {
  if (!QUIET && !JSON_MODE) console.error(msg);
}

function fail(msg: string): never {
  if (JSON_MODE) {
    console.log(JSON.stringify({ error: msg }));
  } else {
    console.error(`[check-upstream-drift] FATAL ${msg}`);
  }
  process.exit(2);
}

function runGit(gitArgs: string[], cwd: string): string {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`git ${gitArgs.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout ?? '';
}

function main() {
  const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim();
  if (!repoRoot) fail('not a git repository');

  // A shallow checkout would make `rev-list --count HEAD..upstream/master`
  // wrong (HEAD would look artificially far "behind"). CI must check out
  // with fetch-depth: 0.
  const isShallow = runGit(['rev-parse', '--is-shallow-repository'], repoRoot).trim();
  if (isShallow === 'true') {
    fail(
      'local checkout is shallow — accurate drift counts require full history. ' +
        'In GitHub Actions, set `fetch-depth: 0` on actions/checkout.'
    );
  }

  // Ensure `upstream` remote exists and points at the right URL. Safe to
  // self-heal here (adding/repointing a remote is not destructive) — unlike
  // sync-from-upstream.sh, which errors and asks a human to fix it before
  // attempting a merge, this is a read-only check.
  const existingUrl = spawnSync('git', ['remote', 'get-url', 'upstream'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout?.trim();
  if (existingUrl !== UPSTREAM_URL) {
    if (existingUrl) {
      runGit(['remote', 'set-url', 'upstream', UPSTREAM_URL], repoRoot);
    } else {
      runGit(['remote', 'add', 'upstream', UPSTREAM_URL], repoRoot);
    }
  }

  log(`[check-upstream-drift] fetching ${UPSTREAM_URL}...`);
  runGit(['fetch', 'upstream', 'master', '--quiet'], repoRoot);

  const countStr = runGit(['rev-list', '--count', `HEAD..${UPSTREAM_REF}`], repoRoot).trim();
  const commitsBehind = parseInt(countStr, 10);
  if (Number.isNaN(commitsBehind)) fail(`could not parse commit count from "${countStr}"`);

  const localHead = runGit(['rev-parse', '--short', 'HEAD'], repoRoot).trim();
  const upstreamHead = runGit(['rev-parse', '--short', UPSTREAM_REF], repoRoot).trim();

  let oldestDate = '';
  let newestDate = '';
  let subjects: { sha: string; subject: string }[] = [];

  if (commitsBehind > 0) {
    oldestDate =
      runGit(['log', '--reverse', '--format=%ad', '--date=short', `HEAD..${UPSTREAM_REF}`], repoRoot)
        .split('\n')[0]
        ?.trim() ?? '';
    newestDate = runGit(['log', '-1', '--format=%ad', '--date=short', UPSTREAM_REF], repoRoot).trim();

    const subjectLines = runGit(
      ['log', '--format=%h %s', `HEAD..${UPSTREAM_REF}`, '-n', String(MAX_SUBJECTS)],
      repoRoot
    )
      .split('\n')
      .filter((l) => l.trim().length > 0);
    subjects = subjectLines.map((line) => {
      const [sha, ...rest] = line.split(' ');
      return { sha, subject: rest.join(' ') };
    });
  }

  const result = {
    commitsBehind,
    localRef: 'main',
    localHead,
    upstreamHead,
    oldestDate,
    newestDate,
    subjectsShown: subjects.length,
    subjects,
    checkedAt: new Date().toISOString(),
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(result));
  } else if (commitsBehind === 0) {
    log(`[check-upstream-drift] in sync ✓ (local main === ${UPSTREAM_REF})`);
  } else {
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`⚠ UPSTREAM DRIFT: main is ${commitsBehind} commits behind ${UPSTREAM_REF}`);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`  local main:      ${localHead}`);
    console.error(`  upstream/master: ${upstreamHead}`);
    console.error(`  date range:      ${oldestDate} → ${newestDate}`);
    console.error('');
    console.error(`  Recent upstream commits (${subjects.length} of ${commitsBehind} shown):`);
    for (const s of subjects) console.error(`    ${s.sha} ${s.subject}`);
    console.error('');
    console.error('  Sync with: bun run sync:upstream');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  process.exit(commitsBehind > 0 ? 1 : 0);
}

main();
