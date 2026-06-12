/**
 * Nightly DB→git export cron (single-brain Stage B).
 *
 * Once-per-UTC-day pattern cloned from src/dent/nightly-maintenance.ts:
 * a 60s tick checks the UTC hour and the `dent_export_last_run` config
 * key; the first tick at/after the threshold hour that hasn't fired
 * today runs `exportBrainToGit`. Started by serve.ts only when
 * `DENT_BRAIN_DATA_DEPLOY_KEY` is set (no key → no mirror → no export).
 *
 * The mirror clone is ensured lazily per fire (ensureMirrorRepo handles
 * clone-or-pull + identity + the mirror `sources` upsert) and once,
 * best-effort, at startup so the clone exists for nightly-maintenance's
 * filesystem phases even before the first export fires.
 *
 * Environment:
 *   DENT_BRAIN_EXPORT_HOUR_UTC   Hour-of-day to fire (default 10 — one
 *                                hour after nightly maintenance).
 */

import type { BrainEngine } from '../../core/engine.ts';
import { ensureMirrorRepo, type MirrorRepoContext } from './repo.ts';
import { exportBrainToGit } from './export.ts';

export const DEFAULT_EXPORT_HOUR_UTC = 10;
const TICK_INTERVAL_MS = 60_000; // check every minute

const LAST_RUN_KEY = 'dent_export_last_run';

export interface ExportCronHandle {
  /** Stop the scheduler. Idempotent. */
  stop: () => void;
}

export interface ExportCronOpts {
  hourUtc?: number;
  /** Override for tests — defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Override for tests — defaults to () => new Date(). */
  now?: () => Date;
  /** Override for tests — defaults to ensureMirrorRepo. */
  ensureRepoImpl?: (engine: BrainEngine) => Promise<MirrorRepoContext>;
}

/**
 * One export tick. Pure orchestration — exported for tests.
 */
export async function exportTick(
  engine: BrainEngine,
  opts: {
    hourUtc: number;
    now: () => Date;
    ensureRepoImpl?: (engine: BrainEngine) => Promise<MirrorRepoContext>;
  },
): Promise<'fired' | 'too_early' | 'already_today' | 'failed'> {
  const now = opts.now();
  const hourUtcNow = now.getUTCHours();
  const todayUtc = now.toISOString().slice(0, 10);

  if (hourUtcNow < opts.hourUtc) return 'too_early';

  const lastRun = (await engine.getConfig(LAST_RUN_KEY)) ?? '';
  if (lastRun.startsWith(todayUtc)) return 'already_today';

  // Mark the slot taken BEFORE running, so a multi-tick race during the
  // run itself can't double-fire. The dent-export DB lock inside
  // exportBrainToGit is the second line of defense.
  await engine.setConfig(LAST_RUN_KEY, now.toISOString());

  console.error(`[dent-exporter] nightly export firing for ${todayUtc}`);
  try {
    const ensure = opts.ensureRepoImpl ?? ensureMirrorRepo;
    const repoCtx = await ensure(engine);
    const result = await exportBrainToGit(engine, repoCtx);
    if (result.status === 'ok') {
      console.error(
        `[dent-exporter] nightly export done: ${result.written} changed, ${result.deleted} deleted, committed=${result.committed}`,
      );
      return 'fired';
    }
    console.error(`[dent-exporter] nightly export ${result.status}${result.status === 'error' ? `: ${result.error}` : ''}`);
    return 'failed';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dent-exporter] nightly export threw: ${msg.slice(0, 300)}`);
    // Don't roll back the last-run mark — better to skip a day than to
    // hot-loop on a persistent failure.
    return 'failed';
  }
}

export function startExportCron(
  engine: BrainEngine,
  opts: ExportCronOpts = {},
): ExportCronHandle {
  const hourUtcRaw = process.env.DENT_BRAIN_EXPORT_HOUR_UTC;
  let hourUtc =
    opts.hourUtc ??
    (hourUtcRaw !== undefined ? Number.parseInt(hourUtcRaw, 10) : DEFAULT_EXPORT_HOUR_UTC);
  if (!Number.isFinite(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    console.error(`[dent-exporter] DENT_BRAIN_EXPORT_HOUR_UTC=${hourUtcRaw} invalid; using default ${DEFAULT_EXPORT_HOUR_UTC}`);
    hourUtc = DEFAULT_EXPORT_HOUR_UTC;
  }
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;
  const now = opts.now ?? (() => new Date());

  let stopped = false;
  let inflight = false;

  // Best-effort initial clone so the mirror exists from boot (nightly
  // maintenance's backlinks/extract phases walk it). Never fatal.
  const ensure = opts.ensureRepoImpl ?? ensureMirrorRepo;
  ensure(engine).catch((e) => {
    console.error(`[dent-exporter] initial mirror clone failed (will retry at export time): ${e instanceof Error ? e.message : String(e)}`);
  });

  const handle = setIntervalFn(async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      await exportTick(engine, { hourUtc, now, ensureRepoImpl: opts.ensureRepoImpl });
    } finally {
      inflight = false;
    }
  }, TICK_INTERVAL_MS);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearIntervalFn(handle);
    },
  };
}
