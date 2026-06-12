/**
 * Mirror-repo setup for the one-way DB→git exporter (single-brain Stage B).
 *
 * dent-brain-data is no longer on the write path. The server's only git
 * involvement is a nightly export that materializes live DB pages as
 * markdown files in this clone and pushes one commit. Accordingly:
 *
 *   - The `sources` row for 'dent' is upserted with config
 *     `{mirror: true, syncEnabled: false}` so NOTHING ever treats the
 *     mirror as an import source — `sync_brain` / performSync must not
 *     pick it up. local_path is kept fresh for operability/debugging only.
 *   - Failure to clone/pull is non-fatal at boot: the exporter cron
 *     retries; serving never depends on the repo.
 *
 * Deploy-key handling (materializeDeployKey) and the clone-or-pull +
 * git-identity logic moved here from markdown-writer/repo.ts.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../../core/engine.ts';
import { DENT_SOURCE_ID } from '../db-writer/page-io.ts';
import { git } from './git-helpers.ts';

export interface DataRepoEnv {
  /** GIT_SSH_COMMAND to inject when invoking git. */
  GIT_SSH_COMMAND: string;
}

export interface MirrorRepoContext {
  repoPath: string;
  headCommit: string;
  gitEnv: NodeJS.ProcessEnv;
  /** Default branch on the data repo. Defaults to `main` (set via
   *  DENT_BRAIN_DATA_BRANCH env). All git pull/push refspecs use this. */
  branch: string;
}

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`FATAL: ${name} is required for the dent-brain-data mirror but is unset.`);
}

/**
 * Write the deploy key to disk and return the env block git children
 * should use for SSH auth.
 *
 * The deploy key is delivered as the literal PEM (multi-line) via the
 * `DENT_BRAIN_DATA_DEPLOY_KEY` Railway secret. We accept either with
 * actual newlines or with `\n` placeholders (Railway secrets often
 * arrive flattened).
 */
export function materializeDeployKey(): DataRepoEnv {
  const raw = readEnv('DENT_BRAIN_DATA_DEPLOY_KEY');
  // Accept literal `\n` escapes (some secret stores flatten newlines).
  const pem = raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
    throw new Error('FATAL: DENT_BRAIN_DATA_DEPLOY_KEY does not look like a PEM private key.');
  }

  const keyPath = '/tmp/dent-brain-data-deploy-key';
  writeFileSync(keyPath, pem.endsWith('\n') ? pem : pem + '\n');
  chmodSync(keyPath, 0o600);

  const knownHostsPath = '/tmp/dent-brain-data-known-hosts';
  // accept-new lets us trust github.com on first contact; subsequent
  // sessions verify against the same file.
  const sshCmd = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsPath}`;
  return { GIT_SSH_COMMAND: sshCmd };
}

/**
 * Idempotently mark the 'dent' source as a non-syncing export mirror.
 * config.mirror=true + syncEnabled=false is the contract that keeps
 * sync_brain / performSync from ever importing FROM the mirror — the DB
 * is canonical, the repo is derived.
 */
async function upsertMirrorSource(engine: BrainEngine, repoPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path,
           name = EXCLUDED.name,
           config = EXCLUDED.config`,
    [DENT_SOURCE_ID, 'Dent Brain (export mirror)', repoPath, JSON.stringify({ mirror: true, syncEnabled: false })],
  );
}

/**
 * Clone (or pull) the dent-brain-data mirror and configure git identity.
 * Pull failures are tolerated (continue with local state); clone failures
 * throw — there's nothing to export into.
 */
export async function ensureMirrorRepo(engine: BrainEngine): Promise<MirrorRepoContext> {
  const repoUrl = readEnv('DENT_BRAIN_DATA_REPO_URL', 'git@github.com:dentthefuture/dent-brain-data.git');
  const repoPath = readEnv('DENT_BRAIN_DATA_PATH', '/app/dent-brain-data');
  const commitName = readEnv('DENT_BRAIN_GIT_NAME', 'dent-brain-server');
  const commitEmail = readEnv('DENT_BRAIN_GIT_EMAIL', 'noreply@dentthefuture.com');
  const branch = readEnv('DENT_BRAIN_DATA_BRANCH', 'main');

  const gitEnvOverlay = materializeDeployKey();
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, ...gitEnvOverlay };

  // Clone or pull.
  const dotGit = `${repoPath}/.git`;
  if (existsSync(dotGit)) {
    try {
      git(repoPath, ['pull', '--ff-only', 'origin', branch], { env: gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[dent-exporter] git pull failed (${msg.slice(0, 200)}). Continuing with local state — export will retry the pull.`);
    }
  } else {
    console.error(`[dent-exporter] cloning ${repoUrl} → ${repoPath}`);
    mkdirSync(dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', repoUrl, repoPath], {
      encoding: 'utf-8',
      timeout: 120_000,
      env: gitEnv,
    });
  }

  // Configure local git identity (--local writes .git/config, no global side effects).
  git(repoPath, ['config', '--local', 'user.name', commitName], { env: gitEnv });
  git(repoPath, ['config', '--local', 'user.email', commitEmail], { env: gitEnv });

  const headCommit = git(repoPath, ['rev-parse', 'HEAD'], { env: gitEnv });

  await upsertMirrorSource(engine, repoPath);

  console.error(`[dent-exporter] mirror ready: ${repoPath} @ ${headCommit.slice(0, 8)} branch=${branch} (source=${DENT_SOURCE_ID}, mirror=true)`);
  return { repoPath, headCommit, gitEnv, branch };
}
