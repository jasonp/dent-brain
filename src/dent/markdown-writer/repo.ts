/**
 * Boot-time setup for the dent-brain-data working clone.
 *
 * Called from `src/dent/serve.ts` after the schema-drift guard, before
 * `Bun.serve` binds the port. If any step fails, we fail boot — writes
 * are required to function and there's no degraded mode.
 *
 * Responsibilities:
 *   1. Materialize the deploy key from `DENT_BRAIN_DATA_DEPLOY_KEY` env
 *      to a 0600 file and stage `GIT_SSH_COMMAND` for git children.
 *   2. Clone `DENT_BRAIN_DATA_REPO_URL` into `DENT_BRAIN_DATA_PATH`
 *      (default `/app/dent-brain-data`) if absent, else `git pull --ff-only`.
 *   3. Configure local git identity for commits the server makes.
 *   4. Upsert a `sources` row (`id='dent'`) so `performSync({sourceId: 'dent'})`
 *      reads the right local_path and tracks last_commit per-source.
 *
 * The env vars are documented in DEPLOY.md (Phase 1 update lands alongside).
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../../core/engine.ts';
import { git, tryGit } from './git-helpers.ts';

export const DENT_SOURCE_ID = 'dent';

export interface DataRepoEnv {
  /** GIT_SSH_COMMAND to inject when invoking git. */
  GIT_SSH_COMMAND: string;
}

export interface EnsureDataRepoResult {
  repoPath: string;
  headCommit: string;
  gitEnv: NodeJS.ProcessEnv;
}

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`FATAL: ${name} is required for the dent-brain-data clone but is unset.`);
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
function materializeDeployKey(): DataRepoEnv {
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
  // sessions verify against the same file. StrictHostKeyChecking=no would
  // be slightly looser; accept-new is the modern OpenSSH equivalent.
  const sshCmd = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsPath}`;
  return { GIT_SSH_COMMAND: sshCmd };
}

/**
 * Idempotently register the dent-brain-data repo as a `sources` row so
 * `performSync({sourceId: 'dent'})` works. ON CONFLICT DO UPDATE keeps
 * `local_path` fresh in case the runtime path changes between deploys.
 */
async function upsertDentSource(engine: BrainEngine, repoPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path,
           name = EXCLUDED.name`,
    [DENT_SOURCE_ID, 'Dent Brain markdown', repoPath, JSON.stringify({ federated: true, syncEnabled: true, strategy: 'markdown' })],
  );
}

export async function ensureDataRepo(engine: BrainEngine): Promise<EnsureDataRepoResult> {
  const repoUrl = readEnv('DENT_BRAIN_DATA_REPO_URL', 'git@github.com:dentthefuture/dent-brain-data.git');
  const repoPath = readEnv('DENT_BRAIN_DATA_PATH', '/app/dent-brain-data');
  const commitName = readEnv('DENT_BRAIN_GIT_NAME', 'dent-brain-server');
  const commitEmail = readEnv('DENT_BRAIN_GIT_EMAIL', 'noreply@dentthefuture.com');

  const gitEnvOverlay = materializeDeployKey();
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, ...gitEnvOverlay };

  // Clone or pull.
  const dotGit = `${repoPath}/.git`;
  if (existsSync(dotGit)) {
    console.error(`[dent-brain] data repo present at ${repoPath}; running git pull --ff-only`);
    try {
      git(repoPath, ['pull', '--ff-only', 'origin', 'master'], { env: gitEnv });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[dent-brain] git pull failed (${msg.slice(0, 200)}). Continuing with local state — next write will retry.`);
    }
  } else {
    console.error(`[dent-brain] cloning ${repoUrl} → ${repoPath}`);
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

  await upsertDentSource(engine, repoPath);

  console.error(`[dent-brain] data repo ready: ${repoPath} @ ${headCommit.slice(0, 8)} (source=${DENT_SOURCE_ID})`);
  return { repoPath, headCommit, gitEnv };
}

/** Singleton holder so the writer ops can reach the resolved env without
 * threading it through every call site. Set by `ensureDataRepo` at boot. */
let cachedRepo: EnsureDataRepoResult | null = null;

export function setRepoContext(ctx: EnsureDataRepoResult): void {
  cachedRepo = ctx;
}

export function getRepoContext(): EnsureDataRepoResult {
  if (!cachedRepo) {
    throw new Error('dent-brain-data repo context not initialized — ensureDataRepo() must run before any markdown_* op.');
  }
  return cachedRepo;
}

/** For tests: inject a synthetic context (local repo, no deploy key). */
export function __setRepoContextForTests(ctx: EnsureDataRepoResult): void {
  cachedRepo = ctx;
}

/** For tests: clear the cached context. */
export function __resetRepoContextForTests(): void {
  cachedRepo = null;
}

/** Sanity probe used by tests. */
export function repoIsReady(repoPath: string, gitEnv: NodeJS.ProcessEnv): boolean {
  return tryGit(repoPath, ['rev-parse', 'HEAD'], { env: gitEnv }) !== null;
}
