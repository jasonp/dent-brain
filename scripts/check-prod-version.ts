#!/usr/bin/env bun
/**
 * Production-vs-main version drift check.
 *
 * Reads `VERSION` from repo root and queries the production dent-brain MCP
 * server's `serverInfo.version` via the initialize handshake. If the server
 * is BEHIND main, exits 1 with a clear message that the user must run
 * `railway redeploy` before shipping more changes.
 *
 * Why this exists: the GitHub → Railway auto-deploy hook on this project
 * is broken, so merges to main don't propagate to production until someone
 * manually triggers a deploy. Without this check, a fix can sit on main
 * for days while production runs the old, buggy code (we hit exactly this
 * with the v0.34.2 zombie-reaper fix that took 4 days to reach prod).
 *
 * Usage:
 *   bun run check:prod-version           # exits 0 if in sync, 1 if drift
 *   bun run check:prod-version --quiet   # only emit on drift / error
 *
 * Reads MCP URL + bearer token from ~/.claude.json (the same place
 * `claude mcp add dent-brain ...` wrote them during onboarding).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const QUIET = process.argv.includes('--quiet');

function log(msg: string) {
  if (!QUIET) console.error(msg);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function discoverFromClaudeJson(): { url: string; token: string } {
  const path = join(homedir(), '.claude.json');
  if (!existsSync(path)) {
    fail(`Cannot find ~/.claude.json. Run /dent-onboard-teammate to register the MCP server, or set DENT_BRAIN_URL + DENT_BRAIN_TOKEN env vars.`);
  }
  const c = JSON.parse(readFileSync(path, 'utf-8'));
  const entry = c?.mcpServers?.['dent-brain'];
  if (!entry?.url || !entry?.headers?.Authorization) {
    fail(`~/.claude.json has no dent-brain MCP entry. Run /dent-onboard-teammate first.`);
  }
  const tokenMatch = /^Bearer\s+(.+)$/.exec(entry.headers.Authorization);
  if (!tokenMatch) fail(`dent-brain MCP entry has malformed Authorization header.`);
  return { url: entry.url, token: tokenMatch[1].trim() };
}

/** Compare 4-digit MAJOR.MINOR.PATCH.MICRO. Returns -1/0/1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10));
  const pb = b.split('.').map((p) => parseInt(p, 10));
  while (pa.length < 4) pa.push(0);
  while (pb.length < 4) pb.push(0);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

async function getServerVersion(url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'check-prod-version', version: '1' },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail(`MCP initialize failed: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  // Response can be plain JSON or SSE-framed; strip framing if present.
  const jsonStr = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text
    : text;
  const body = JSON.parse(jsonStr);
  const v = body?.result?.serverInfo?.version;
  if (typeof v !== 'string') fail(`MCP response missing serverInfo.version: ${jsonStr.slice(0, 200)}`);
  return v;
}

async function main() {
  const repoRoot = join(import.meta.dir, '..');
  const versionPath = join(repoRoot, 'VERSION');
  if (!existsSync(versionPath)) fail(`VERSION file not found at ${versionPath}`);
  const mainVersion = readFileSync(versionPath, 'utf-8').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$|^\d+\.\d+\.\d+$/.test(mainVersion)) {
    fail(`VERSION file does not match expected format (got "${mainVersion}")`);
  }

  const { url, token } = discoverFromClaudeJson();
  log(`[check-prod-version] main VERSION: ${mainVersion}`);
  log(`[check-prod-version] querying ${url}`);

  const serverVersion = await getServerVersion(url, token);
  log(`[check-prod-version] production:   ${serverVersion}`);

  const cmp = compareVersions(serverVersion, mainVersion);
  if (cmp === 0) {
    log(`[check-prod-version] in sync ✓`);
    process.exit(0);
  }
  if (cmp > 0) {
    log(`[check-prod-version] production is AHEAD of main (server: ${serverVersion}, main: ${mainVersion})`);
    log(`[check-prod-version] This is unusual but not a ship blocker. Verify nobody else pushed a hotfix outside the normal flow.`);
    process.exit(0);
  }

  // server < main — production is behind
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`❌ DEPLOY DRIFT: production is BEHIND main`);
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  main:       ${mainVersion}`);
  console.error(`  production: ${serverVersion}`);
  console.error('');
  console.error('  The GitHub → Railway auto-deploy hook on this project is broken,');
  console.error('  so merges to main do NOT propagate to production automatically.');
  console.error('  Until production catches up, any fixes you just merged are not live.');
  console.error('');
  console.error('  Fix:');
  console.error('    railway redeploy --yes');
  console.error('    # then wait ~90s and re-run this check');
  console.error('');
  console.error('  If you ship more changes now without redeploying, multiple');
  console.error('  releases worth of fixes will be queued behind a single redeploy');
  console.error('  — and the longer it sits, the more likely the user-visible bug');
  console.error('  pattern that motivated this check recurs.');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
}

main().catch((e) => {
  console.error(`[check-prod-version] FATAL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
