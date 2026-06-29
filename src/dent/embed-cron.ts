/**
 * Dedicated embed-stale cron (decoupled maintenance).
 *
 * WHY THIS EXISTS (incident 2026-06-27): embedding used to run ONLY as the
 * `embed` phase of the once-daily nightly cycle (`nightly-maintenance.ts`).
 * A transient failure of that phase (gateway/pool hiccup at the 09:00 UTC
 * fire) left every newly-ingested chunk un-embedded — and therefore
 * invisible to vector search — until the NEXT daily run. When the transient
 * recurred at that slot, the backlog grew unbounded (1,324 chunks / 991
 * pages stranded over ~9 days before a manual `embed --stale` cleared it).
 *
 * `embed --stale` is idempotent (`embedding IS NULL` predicate) and
 * cursor-resumable, so it is safe to run often. Running it on its own short
 * interval means a transient failure self-heals within an interval or two
 * instead of stranding data for a day-plus, and the slow nightly cycle is no
 * longer the single point of failure for search visibility.
 *
 * Mirrors the shape of `ingestors/regfox/cron.ts`: errors are caught at the
 * boundary so an interval timer never dies on a transient hiccup, and a
 * re-entrancy guard skips a tick if the previous embed run is still going
 * (an embed of a large backlog can outlast the interval).
 */

import type { BrainEngine } from '../core/engine.ts';

export const DEFAULT_EMBED_POLL_INTERVAL_SECONDS = 5400; // 90 minutes

export interface EmbedCronHandle {
  stop: () => void;
}

/** Result shape the cron cares about (subset of EmbedResult). */
export interface EmbedTickResult {
  embedded: number;
  pages_processed: number;
  skipped: number;
}

export interface EmbedCronOpts {
  /**
   * Test seam: run one embed pass. Production leaves this unset and the cron
   * calls `runEmbedCore(engine, { stale: true })`. Mirrors the `embedFn`
   * injection in `core/embed-stale.ts` — lets tests drive the timer/guard
   * logic without a real engine or gateway.
   */
  embedOnce?: () => Promise<EmbedTickResult>;
}

export function startEmbedCron(
  engine: BrainEngine,
  intervalMs: number = DEFAULT_EMBED_POLL_INTERVAL_SECONDS * 1000,
  opts: EmbedCronOpts = {},
): EmbedCronHandle {
  let stopped = false;
  let running = false;

  const embedOnce = opts.embedOnce ?? (async () => {
    const { runEmbedCore } = await import('../commands/embed.ts');
    return runEmbedCore(engine, { stale: true });
  });

  const tick = async () => {
    if (stopped || running) return; // skip if a prior embed pass is still draining
    running = true;
    try {
      const result = await embedOnce();
      // Quiet when idle (the common case): only speak up when work happened.
      if (result.embedded > 0) {
        console.error(
          `[embed-cron] tick ok: embedded=${result.embedded} pages=${result.pages_processed} skipped=${result.skipped}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A failed tick is non-fatal: stale chunks stay NULL and the NEXT tick
      // (one interval later) retries them. This is the whole point of the
      // decoupled cron — no single failure strands data until tomorrow.
      console.error(`[embed-cron] tick failed (will retry next interval): ${msg.slice(0, 300)}`);
    } finally {
      running = false;
    }
  };

  // Stagger the first tick by half the interval so the embed pass doesn't
  // fire in lockstep with the nightly cycle / hourly ingestors that all land
  // on round wall-clock boundaries.
  const offsetMs = Math.floor(intervalMs / 2);
  let handle: ReturnType<typeof setInterval>;
  const startTimer = setTimeout(() => {
    if (stopped) return;
    void tick();
    handle = setInterval(() => void tick(), intervalMs);
    if (typeof handle.unref === 'function') handle.unref();
  }, offsetMs);
  if (typeof startTimer.unref === 'function') startTimer.unref();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(startTimer);
      if (handle) clearInterval(handle);
    },
  };
}
