/**
 * Nightly brain maintenance — runs deterministic gbrain dream-cycle
 * phases (backlinks, extract, embed) once per UTC day from inside the
 * dent-brain Railway container. Sibling of `markdown-writer/cron.ts`
 * (scheduled-pull) and `ingestors/regfox/cron.ts` (regfox-ingestor).
 *
 * Why server-side: every teammate adding their own laptop cron would
 * stomp on each other (duplicate work, race for the cycle lock), and
 * skipping when laptops are off is unreliable. The Railway container
 * runs 24/7, has DATABASE_URL, has the brain-data git checkout, has
 * tini-reaped subprocess hygiene as of v0.36.1. One cron, one source
 * of truth.
 *
 * What runs:
 *   - `backlinks` — recompute the backlink table from the link graph
 *   - `extract` — walk pages, re-extract typed links + timeline entries
 *     (db source — no filesystem walk; mutation-immune snapshot iter)
 *   - `embed` — re-embed any chunks where embedded_at < updated_at
 *
 * What DOESN'T run (intentionally):
 *   - `synthesize` / `patterns` / `recompute_emotional_weight` — all
 *     LLM-driven; each subagent call is real $$$. Schedule those
 *     separately when budget is signed off.
 *   - `purge` — destructive (hard-deletes soft-deleted pages past 72h).
 *     Fine to run, but worth its own decision.
 *   - `sync` — already covered by `markdown-writer/cron.ts` every 5 min.
 *   - `lint` — runs locally before commits; cron-side noise.
 *   - `orphans` — listing only; not actionable nightly.
 *
 * Deduplication: brain config `dent_nightly_last_run` records the ISO
 * date of the last successful fire. Once-per-UTC-day semantics — if the
 * container restarts after the run, the second start sees the existing
 * record and waits for tomorrow. `acquirePostgresLock` inside `runCycle`
 * provides a second layer (pg_advisory_xact_lock) against concurrent
 * fires.
 *
 * Environment:
 *   DENT_BRAIN_NIGHTLY_HOUR_UTC    Hour-of-day to fire (default 9 = 09:00 UTC = 02:00 PT).
 *                                  Set to -1 to disable.
 *   DENT_BRAIN_NIGHTLY_PHASES      Comma-separated phase list (default `backlinks,extract,embed`).
 */

import type { BrainEngine } from '../core/engine.ts';
import { runCycle, type CyclePhase } from '../core/cycle.ts';

export const DEFAULT_NIGHTLY_HOUR_UTC = 9;
export const DEFAULT_NIGHTLY_PHASES: CyclePhase[] = ['backlinks', 'extract', 'embed'];
const TICK_INTERVAL_MS = 60_000; // check every minute

const LAST_RUN_KEY = 'dent_nightly_last_run';

export interface NightlyMaintenanceHandle {
  /** Stop the scheduler. Idempotent. */
  stop: () => void;
}

export interface NightlyMaintenanceOpts {
  brainDir: string;
  hourUtc?: number;
  phases?: CyclePhase[];
  /** Override for tests — defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Override for tests — defaults to () => new Date(). */
  now?: () => Date;
}

/**
 * One nightly tick. Pure orchestration — exported for tests.
 *
 * Returns:
 *   - `'fired'`   if the cycle started this tick
 *   - `'too_early'` if the current UTC hour is before the threshold
 *   - `'already_today'` if a prior tick today already fired
 *   - `'failed'`  if the cycle errored (logged, but the scheduler stays alive)
 */
export async function nightlyTick(
  engine: BrainEngine,
  opts: { brainDir: string; hourUtc: number; phases: CyclePhase[]; now: () => Date },
): Promise<'fired' | 'too_early' | 'already_today' | 'failed'> {
  const now = opts.now();
  const hourUtcNow = now.getUTCHours();
  const todayUtc = now.toISOString().slice(0, 10);

  if (hourUtcNow < opts.hourUtc) return 'too_early';

  const lastRun = (await engine.getConfig(LAST_RUN_KEY)) ?? '';
  if (lastRun.startsWith(todayUtc)) return 'already_today';

  // Mark the slot taken BEFORE running, so a multi-tick race during the
  // run itself can't double-fire. acquirePostgresLock inside runCycle is
  // the second line of defense.
  await engine.setConfig(LAST_RUN_KEY, now.toISOString());

  console.error(`[dent-brain] nightly-maintenance: firing for ${todayUtc} (phases=${opts.phases.join(',')})`);
  try {
    const report = await runCycle(engine, {
      brainDir: opts.brainDir,
      phases: opts.phases,
      // pull=false: scheduled-pull cron handles git pulls every 5 min.
      pull: false,
    });
    const failed = report.phases.filter((p) => p.status === 'fail').length;
    console.error(
      `[dent-brain] nightly-maintenance: done (status=${report.status}, ${report.duration_ms}ms, failed=${failed}/${report.phases.length})`,
    );
    return 'fired';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dent-brain] nightly-maintenance: cycle threw: ${msg.slice(0, 300)}`);
    // Don't roll back the last-run mark — better to skip a day than to
    // hot-loop on a persistent failure.
    return 'failed';
  }
}

export function startNightlyMaintenance(
  engine: BrainEngine,
  opts: NightlyMaintenanceOpts,
): NightlyMaintenanceHandle {
  const hourUtc = opts.hourUtc ?? DEFAULT_NIGHTLY_HOUR_UTC;
  const phases = opts.phases ?? DEFAULT_NIGHTLY_PHASES;
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;
  const now = opts.now ?? (() => new Date());

  let stopped = false;
  let inflight = false;

  const handle = setIntervalFn(async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      await nightlyTick(engine, { brainDir: opts.brainDir, hourUtc, phases, now });
    } finally {
      inflight = false;
    }
  }, TICK_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      clearIntervalFn(handle);
    },
  };
}
