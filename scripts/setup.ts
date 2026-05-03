#!/usr/bin/env bun
/**
 * Guided fork-and-deploy setup for the dbrain template.
 *
 *   bun run setup
 *
 * Walks the admin through customizing this fork for their organization:
 * org prefix, org name, server URL, data repo, code repo (THIS fork).
 * Rewrites:
 *   - plugin/manifest.json  (the canonical config)
 *   - skills/<old-prefix>/  →  skills/<new-prefix>/  (rename if changed)
 *
 * Then runs the plugin build to regenerate:
 *   - .claude-plugin/marketplace.json (top-level, repo-root)
 *   - plugin/marketplace/.claude-plugin/plugin.json
 *   - plugin/marketplace/.claude/skills/<prefix>-<name>/SKILL.md (×N)
 *   - plugin/marketplace/install-local.sh
 *   - …etc.
 *
 * After setup the admin commits and pushes; their repo is then a real
 * Cowork-installable marketplace at `github:<owner>/<repo>`.
 *
 * NOT in scope here:
 *   - Provisioning Supabase or Railway (out-of-band — see SETUP.md).
 *   - Generating SSH deploy keys (see SETUP.md §3 for the openssh recipe).
 *
 * Idempotent: re-runnable. Pre-fills answers from the existing manifest.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createInterface } from 'readline';

const REPO_ROOT = join(import.meta.dir, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'plugin', 'manifest.json');

interface Manifest {
  manifest_version: string;
  deploy: {
    org_prefix: string;
    org_full_name: string;
    org_email_domain: string;
    deploy_id: string;
    server_url: string;
    server_url_dev?: string;
    data_repo: string;
    code_repo?: string;
  };
  skills: { templates: string[] };
  fm_mcp?: { enabled?: boolean };
  [k: string]: unknown;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
}

function writeManifest(m: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt: string, fallback: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `, (a) => {
      const trimmed = a.trim();
      resolve(trimmed.length === 0 ? fallback : trimmed);
    });
  });
}

function tryGitOriginRepo(): string | undefined {
  try {
    const url = execFileSync('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git@github.com:owner/repo.git  OR  https://github.com/owner/repo.git
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function isValidPrefix(p: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(p);
}

async function main() {
  const m = readManifest();

  console.log('');
  console.log('━━━ dbrain fork setup ━━━');
  console.log('Customize this fork for your organization. Press Enter to keep the bracketed default.');
  console.log('');

  const orgPrefix = (await ask(
    'Org prefix (lowercase, letters+digits+hyphens — becomes /<prefix>-append-evidence etc.)',
    m.deploy.org_prefix,
  )).toLowerCase();
  if (!isValidPrefix(orgPrefix)) {
    rl.close();
    console.error(`FATAL: '${orgPrefix}' is not a valid prefix (must match [a-z][a-z0-9-]*).`);
    process.exit(1);
  }

  const orgFullName = await ask('Org full name (shown in plugin metadata)', m.deploy.org_full_name);
  const orgEmailDomain = await ask('Org email domain (used in default git author email + URLs)', m.deploy.org_email_domain);
  const deployId = await ask(
    'Deploy id (Railway service identifier, lowercase + hyphens)',
    m.deploy.deploy_id || `${orgPrefix}-brain-prod`,
  );
  const serverUrl = await ask(
    'MCP server URL (your deployed dbrain endpoint)',
    m.deploy.server_url || `https://${orgPrefix}-brain.${orgEmailDomain}/mcp`,
  );
  const dataRepo = await ask(
    'Markdown data repo (github.com/owner/repo — where entity pages live)',
    m.deploy.data_repo || `github.com/${orgEmailDomain.split('.')[0]}/${orgPrefix}-brain-data`,
  );
  const detectedCodeRepo = m.deploy.code_repo ?? tryGitOriginRepo() ?? `<your-github-handle>/${orgPrefix}-brain`;
  const codeRepo = await ask(
    'Code repo (THIS fork; owner/repo on github — used in plugin metadata)',
    detectedCodeRepo,
  );

  rl.close();

  // Confirm and write.
  console.log('');
  console.log('Summary:');
  console.log(`  org_prefix       = ${orgPrefix}`);
  console.log(`  org_full_name    = ${orgFullName}`);
  console.log(`  org_email_domain = ${orgEmailDomain}`);
  console.log(`  deploy_id        = ${deployId}`);
  console.log(`  server_url       = ${serverUrl}`);
  console.log(`  data_repo        = ${dataRepo}`);
  console.log(`  code_repo        = ${codeRepo}`);
  console.log('');

  // 1. Rewrite manifest.
  m.deploy.org_prefix = orgPrefix;
  m.deploy.org_full_name = orgFullName;
  m.deploy.org_email_domain = orgEmailDomain;
  m.deploy.deploy_id = deployId;
  m.deploy.server_url = serverUrl;
  m.deploy.data_repo = dataRepo;
  m.deploy.code_repo = codeRepo;
  writeManifest(m);
  console.log(`✓ wrote plugin/manifest.json`);

  // 2. Rename skills/<old-prefix>/ → skills/<new-prefix>/ if needed.
  const oldSkillsDir = join(REPO_ROOT, 'skills', readManifestOrigPrefixFromDisk());
  const newSkillsDir = join(REPO_ROOT, 'skills', orgPrefix);
  if (oldSkillsDir !== newSkillsDir) {
    if (existsSync(oldSkillsDir) && !existsSync(newSkillsDir)) {
      renameSync(oldSkillsDir, newSkillsDir);
      console.log(`✓ renamed skills/${readManifestOrigPrefixFromDisk()}/ → skills/${orgPrefix}/`);
    } else if (!existsSync(newSkillsDir)) {
      console.warn(`⚠ skills/${orgPrefix}/ doesn't exist and no source dir to rename — build will fail until you populate it.`);
    } else {
      console.log(`✓ skills/${orgPrefix}/ already in place`);
    }
  }

  // 3. Run the plugin build to regenerate plugin/marketplace/ + .claude-plugin/marketplace.json.
  console.log('');
  console.log('Running plugin build...');
  try {
    execFileSync('bun', ['run', 'build:plugin'], { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error('Plugin build failed. Fix the error above and re-run `bun run build:plugin`.');
    process.exit(2);
  }

  // 4. Next steps.
  console.log('');
  console.log('━━━ setup complete ━━━');
  console.log('');
  console.log('Next steps:');
  console.log('');
  console.log('  1. Review changes:');
  console.log('       git status');
  console.log('       git diff plugin/manifest.json');
  console.log('');
  console.log('  2. Commit and push:');
  console.log(`       git add -A && git commit -m "fork: customize for ${orgFullName}"`);
  console.log('       git push origin master');
  console.log('');
  console.log('  3. Provision the server (Supabase + Railway + deploy keys):');
  console.log('       Open docs/dent-brain/SETUP.md and follow §2-§4.');
  console.log('');
  console.log('  4. Once the server is live, install the plugin in Cowork:');
  console.log(`       Open Cowork and ask: "Add a custom marketplace from github:${codeRepo} and install ${orgPrefix}-brain"`);
  console.log('');
  console.log(`  5. Onboard teammates with /${orgPrefix}-onboard-teammate.`);
  console.log('');
}

/** Re-read the manifest BEFORE the in-flight write to discover the
 *  pre-existing prefix on disk (so we can detect a rename target). */
function readManifestOrigPrefixFromDisk(): string {
  // The manifest was already rewritten above when this is called from the
  // post-write rename step. Read git's HEAD copy via `git show :plugin/manifest.json`
  // to get the on-disk-staged-or-committed value. Fallback to the in-memory value.
  try {
    const blob = execFileSync('git', ['-C', REPO_ROOT, 'show', ':plugin/manifest.json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(blob) as Manifest;
    return parsed.deploy.org_prefix;
  } catch {
    // Not in git index (initial run on a checkout that's never been committed) —
    // fall back to scanning skills/ for an existing single dir.
    return 'dent';
  }
}

main().catch((e) => {
  rl.close();
  console.error('setup failed:', e instanceof Error ? e.message : String(e));
  process.exit(99);
});
