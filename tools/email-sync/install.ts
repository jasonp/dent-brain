#!/usr/bin/env bun
/**
 * Email → Dent Brain sync installer (cross-platform: macOS + Windows).
 *
 * Bun port of the original install.sh. Structure: one linear OS-agnostic core
 * (verify → discover MCP → collect config → copy runtime → write config →
 * OAuth → probe Gmail → stage schedule → print next steps), calling a small
 * platform module only at three branch points:
 *   1. schedule staging  — launchd plist vs Task Scheduler XML (via scheduler/)
 *   2. secrets ACL        — chmod 0600 (POSIX) vs icacls (Windows)
 *   3. (path expansion is handled by os.homedir(), already cross-platform)
 *
 * Privacy contract (unchanged): nothing reaches the brain until the teammate
 * authors user/filter.ts (setup), previews, and explicitly arms. This installer
 * stages the schedule definition but never registers it — `dent-extensions arm`
 * does that.
 *
 * Granola-sync stays on install.sh (macOS-only). This is email-sync only.
 *
 * Shared Google OAuth creds come from env so they're never pasted into chat:
 *   DENT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
 *   DENT_GOOGLE_CLIENT_SECRET=GOCSPX-... \
 *   DENT_EMAIL_WORK_EMAIL=you@example.com \
 *     bun tools/email-sync/install.ts
 * Missing values are prompted for.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { GoogleClient } from './google-client.ts';
import { findExtension } from '../extensions/registry.ts';
import { getScheduler, buildSpec } from '../extensions/scheduler/index.ts';

const SCRIPT_DIR = import.meta.dir;
const HOME = homedir();
const INSTALL_DIR = join(HOME, '.dent-brain', 'email-sync');
const TOKENS_PATH = join(INSTALL_DIR, 'google-tokens.json');
const CONFIG_PATH = join(INSTALL_DIR, 'config.json');
const BUN_PATH = process.execPath;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ── Platform module ─────────────────────────────────────────────────────────
// The only OS-specific behavior beyond scheduling. Everything else is portable.

/** Restrict a sensitive file to the current user only.
 *  POSIX: chmod 0600. Windows: break ACL inheritance + grant only this user.
 *  Best-effort on Windows — warns rather than failing the install. */
function restrictToUser(path: string): void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || process.env.USER || '';
    if (!user) {
      console.error(`    WARN: cannot resolve username to lock ${path}. Verify its permissions manually.`);
      return;
    }
    // /inheritance:r removes inherited ACEs; /grant:r replaces this user's ACE with Full.
    const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { encoding: 'utf-8' });
    if (r.status !== 0) {
      console.error(`    WARN: icacls could not lock ${path} (exit ${r.status}). It may be readable by other users — check manually.`);
    }
  } else {
    chmodSync(path, 0o600);
  }
}

// ── Prompt helpers ──────────────────────────────────────────────────────────

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await new Promise<string>((res) => rl.question(`  ${label}: `, res))).trim();
    return ans;
  } finally {
    rl.close();
  }
}

/** Env wins (unless empty or a REPLACE_ placeholder); otherwise prompt. */
async function required(envVar: string, label: string): Promise<string> {
  const cur = process.env[envVar];
  if (cur && !cur.startsWith('REPLACE_')) return cur;
  const val = await prompt(label);
  if (!val) die(`ERROR: ${label} is required.`);
  return val;
}

// ── MCP discovery (port of the inlined bash JS) ─────────────────────────────

function discoverMcpUrl(): string {
  const claudeJson = join(HOME, '.claude.json');
  if (!existsSync(claudeJson)) {
    die('ERROR: ~/.claude.json not found.\nRun /dent-onboard-teammate first to register the MCP server.');
  }
  let c: any;
  try { c = JSON.parse(readFileSync(claudeJson, 'utf-8')); }
  catch { die('ERROR: ~/.claude.json is not valid JSON.'); }
  const projects = c?.projects ? Object.values(c.projects) : [];
  for (const cand of [c, ...projects]) {
    const e = (cand as any)?.mcpServers?.['dent-brain'];
    if (e?.url && typeof e?.headers?.Authorization === 'string' && e.headers.Authorization.startsWith('Bearer ')) {
      return e.url;
    }
  }
  die('ERROR: ~/.claude.json has no dent-brain MCP entry with a Bearer token.\nRun /dent-onboard-teammate first, then re-run this installer.');
}

// ── Gmail probe (in-process; replaces the bash `bun -e` subprocess) ──────────

async function probeGmail(clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const gc = new GoogleClient({ tokensPath: TOKENS_PATH, clientId, clientSecret });
    const { emailAddress } = await gc.health();
    return emailAddress;
  } catch {
    return null;
  }
}

// ── Linear core ─────────────────────────────────────────────────────────────

async function main() {
  console.log('==> Email-sync installer (cross-platform)');
  console.log(`    platform: ${process.platform}`);
  console.log(`    source:   ${SCRIPT_DIR}`);
  console.log(`    target:   ${INSTALL_DIR}`);
  console.log(`    bun:      ${BUN_PATH}`);

  // 1. Verify MCP registration.
  const mcpUrl = discoverMcpUrl();
  console.log(`    dent-brain MCP discovered: ${mcpUrl}`);

  // 2. Collect config. Env wins; otherwise prompt.
  const workEmail = await required('DENT_EMAIL_WORK_EMAIL', 'Your work email (e.g. you@example.com)');
  const clientId = await required('DENT_GOOGLE_CLIENT_ID', 'Dent Brain Google OAuth Client ID (...apps.googleusercontent.com)');
  const clientSecret = await required('DENT_GOOGLE_CLIENT_SECRET', 'Dent Brain Google OAuth Client Secret (GOCSPX-...)');
  const authUser = process.env.DENT_EMAIL_AUTHUSER || '0';
  console.log(`    workEmail:      ${workEmail}`);
  console.log(`    googleClientId: ${clientId.slice(0, 24)}...`);
  console.log(`    authUser:       ${authUser}`);

  // 3. Copy runtime files + recipe + version stamp. `user/` is left untouched —
  //    owned by the teammate, authored via /dent-extensions setup.
  mkdirSync(join(INSTALL_DIR, 'recipe'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'user'), { recursive: true });
  const runtimeFiles = ['collect.ts', 'types.ts', 'mcp-client.ts', 'google-client.ts', 'oauth-flow.ts', 'noise-filter.ts', 'link-gen.ts', 'digest.ts'];
  for (const f of runtimeFiles) copyFileSync(join(SCRIPT_DIR, f), join(INSTALL_DIR, f));
  copyFileSync(join(SCRIPT_DIR, 'recipe', 'filter.example.ts'), join(INSTALL_DIR, 'recipe', 'filter.example.ts'));
  const recipeMd = join(SCRIPT_DIR, 'recipe', 'RECIPE.md');
  if (existsSync(recipeMd)) copyFileSync(recipeMd, join(INSTALL_DIR, 'recipe', 'RECIPE.md'));

  const bundleRoot = join(SCRIPT_DIR, '..', '..');
  const bundleVersion = join(bundleRoot, 'VERSION');
  writeFileSync(join(INSTALL_DIR, '.installed-version'), existsSync(bundleVersion) ? readFileSync(bundleVersion, 'utf-8') : 'unknown\n');
  console.log(`    copied ${runtimeFiles.length} runtime files.`);

  // 3b. Layer-2 skill body to a stable location (resolve {{prefix}} → dent).
  const skillSrc = join(bundleRoot, 'skills', 'dent', 'process-inbox', 'SKILL.md');
  const skillDir = join(HOME, '.dent-brain', 'skills');
  const skillDst = join(skillDir, 'process-inbox.md');
  if (existsSync(skillSrc)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillDst, readFileSync(skillSrc, 'utf-8').replace(/\{\{prefix\}\}/g, 'dent'));
    console.log(`    installed Layer-2 skill: ${skillDst}`);
  } else {
    console.log(`    WARNING: process-inbox SKILL.md not found at ${skillSrc}; skipping Layer-2 install.`);
  }

  // 4. Write config.json, locked to the current user.
  writeFileSync(CONFIG_PATH, JSON.stringify({
    workEmail,
    googleClientId: clientId,
    googleClientSecret: clientSecret,
    googleTokensPath: TOKENS_PATH,
    authUser,
    cursorPath: join(INSTALL_DIR, 'cursor.json'),
    cacheDir: join(INSTALL_DIR, 'cache'),
  }, null, 2) + '\n');
  restrictToUser(CONFIG_PATH);
  console.log(`    wrote config: ${CONFIG_PATH} (user-only)`);

  // 5. OAuth dance — skip if existing tokens already match workEmail.
  let needOauth = true;
  if (existsSync(TOKENS_PATH)) {
    console.log(`\n==> Found existing OAuth tokens at ${TOKENS_PATH}.`);
    const who = await probeGmail(clientId, clientSecret);
    if (who === workEmail) { console.log(`    Tokens valid for ${who} — skipping OAuth dance.`); needOauth = false; }
    else if (who) console.log(`    Existing tokens are for ${who} but workEmail is ${workEmail}. Re-running OAuth flow.`);
    else console.log(`    Existing tokens did not validate — re-running OAuth flow.`);
  }
  if (needOauth) {
    console.log(`\n==> Running one-time Google OAuth dance...`);
    console.log(`    A browser tab will open. Expect an "app isn't verified" warning (test mode):`);
    console.log(`    Advanced → "Go to Dent Brain (unsafe)" → Allow.`);
    const r = spawnSync(BUN_PATH, [join(INSTALL_DIR, 'oauth-flow.ts'), '--client-id', clientId, '--client-secret', clientSecret, '--tokens-path', TOKENS_PATH], { stdio: 'inherit' });
    if (r.status !== 0) die(`ERROR: OAuth flow failed (exit ${r.status}).`);
    restrictToUser(TOKENS_PATH);
  }

  // 6. Probe Gmail — confirms tokens work AND match workEmail.
  console.log(`\n==> Probing Gmail with the issued token...`);
  const who = await probeGmail(clientId, clientSecret);
  if (!who) {
    die(`ERROR: Gmail probe failed.\nCheck that ${workEmail} is on the Google Cloud test-user list and the OAuth client is a "Desktop app".`);
  }
  if (who !== workEmail) {
    rmSync(TOKENS_PATH, { force: true });
    die(`ERROR: OAuth tokens are for ${who} but config.workEmail is ${workEmail}.\nYou may have authorized a different Google account. Re-run the installer.`);
  }
  console.log(`    Gmail: reachable as ${who}`);

  // 7. Stage the schedule definition (plist / task XML) — INERT, not registered.
  //    `dent-extensions arm email-sync` registers it after setup + preview.
  const ext = findExtension('email-sync');
  if (!ext) die('ERROR: email-sync not found in the extensions registry.');
  const expand = (p: string | undefined) => p?.replace(/\$\{HOME\}/g, HOME);
  const spec = buildSpec(ext, expand, BUN_PATH, HOME);
  if (!spec) die('ERROR: could not build schedule spec for email-sync (registry misconfigured).');
  let scheduler;
  try { scheduler = getScheduler(); }
  catch (e) { die(`ERROR: ${e instanceof Error ? e.message : String(e)}`); }

  let disarmed = false;
  if (scheduler.isLoaded(spec)) {
    console.log(`    tearing down prior registration for re-install…`);
    scheduler.disarm(spec);
    disarmed = true;
  }
  mkdirSync(dirname(spec.definitionPath), { recursive: true });
  scheduler.stage(spec);
  console.log(`    staged schedule (not registered): ${spec.definitionPath}`);

  // 8. Next steps.
  console.log();
  if (disarmed) {
    console.log(`==> ⚠  DAEMON DISARMED. The prior schedule was torn down for this re-install.`);
    console.log(`    Re-run \`dent-extensions arm email-sync\` to resume syncing.\n`);
  }
  console.log(`==> Plumbing installed. Daemon is INERT — nothing will reach the brain yet.\n`);
  console.log(`    Next: tell Claude Code 'set up email-sync' (or run /dent-extensions setup email-sync).`);
  console.log(`    It samples your senders, helps you author user/filter.ts, previews what would`);
  console.log(`    be filed, and only arms the daemon after you approve.\n`);
  console.log(`    Manual paths:`);
  console.log(`      Copy example:  cp ${join(INSTALL_DIR, 'recipe', 'filter.example.ts')} ${join(INSTALL_DIR, 'user', 'filter.ts')}`);
  console.log(`      Preview:       dent-extensions preview email-sync`);
  console.log(`      Arm:           dent-extensions arm email-sync`);
  console.log(`      Uninstall:     dent-extensions uninstall email-sync`);
}

main().catch((e) => die(`ERROR: ${e instanceof Error ? e.stack || e.message : String(e)}`));
