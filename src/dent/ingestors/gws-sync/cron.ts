/**
 * gws-sync cron. Hourly tick; errors at the boundary so a transient Drive
 * hiccup never kills the interval timer (same shape as the regfox cron).
 */

import type { BrainEngine } from '../../../core/engine.ts';
import { runGwsSyncTick, type GwsSyncOptions } from './ingest.ts';

export const DEFAULT_GWS_SYNC_INTERVAL_SECONDS = 3600; // hourly

export interface GwsSyncCronHandle {
  stop: () => void;
}

export function startGwsSyncCron(
  engine: BrainEngine,
  options: GwsSyncOptions,
  intervalMs: number = DEFAULT_GWS_SYNC_INTERVAL_SECONDS * 1000,
): GwsSyncCronHandle {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runGwsSyncTick(engine, options);
      if (r.ok) {
        if (r.upserted > 0 || r.tombstoned > 0 || r.errors > 0 || r.mode === 'seed') {
          console.error(
            `[gws-sync] tick ok: mode=${r.mode} scanned=${r.scanned} upserted=${r.upserted} skipped=${r.skipped} tombstoned=${r.tombstoned} errors=${r.errors}`,
          );
        }
      } else {
        console.error(`[gws-sync] tick error: ${r.error}`);
      }
    } catch (e) {
      console.error(`[gws-sync] tick threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Delay the first tick a minute past boot so startup isn't competing with the
  // seed full-walk, then run hourly.
  const offsetMs = 60_000;
  let handle: ReturnType<typeof setInterval>;
  const startTimer = setTimeout(() => {
    if (stopped) return;
    tick();
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
