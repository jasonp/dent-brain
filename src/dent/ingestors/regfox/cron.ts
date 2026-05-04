/**
 * RegFox ingestor cron. Mirrors the shape of
 * `src/dent/markdown-writer/cron.ts` (scheduled-pull). Errors at the
 * boundary so an interval timer never dies on transient hiccups.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import { runIngestTick, type IngestOptions } from './ingest.ts';

export const DEFAULT_REGFOX_POLL_INTERVAL_SECONDS = 300; // 5 minutes

export interface RegfoxCronHandle {
  stop: () => void;
}

export function startRegfoxCron(
  engine: BrainEngine,
  ingestOptions: IngestOptions,
  intervalMs: number = DEFAULT_REGFOX_POLL_INTERVAL_SECONDS * 1000,
): RegfoxCronHandle {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runIngestTick(engine, ingestOptions);
      if (result.ok) {
        if (result.processed > 0) {
          console.error(
            `[regfox-ingestor] tick ok: processed=${result.processed} created=${result.created} appended=${result.appended} pendingReview=${result.pendingReview} skipped=${result.skipped} transientErrors=${result.transientErrors}`,
          );
        }
      } else {
        console.error(`[regfox-ingestor] tick error: ${result.error} (processed=${result.processed} transientErrors=${result.transientErrors})`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[regfox-ingestor] tick threw: ${msg}`);
    }
  };

  // Stagger: scheduled-pull and regfox both fire every 300s and were
  // colliding on the repo lock at every tick. Delay regfox's first tick
  // by half the interval so the two crons interleave (scheduled-pull at
  // 300s/600s/..., regfox at 450s/750s/...) instead of racing.
  const offsetMs = Math.floor(intervalMs / 2);
  let handle: ReturnType<typeof setInterval>;
  const startTimer = setTimeout(() => {
    if (stopped) return;
    tick(); // first regfox tick at offset
    handle = setInterval(tick, intervalMs);
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
