import { describe, test, expect } from 'bun:test';
import { startEmbedCron, type EmbedTickResult } from '../../src/dent/embed-cron.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

// nightlyTick-style: the engine is unused on the injected-fake path.
const fakeEngine = {} as unknown as BrainEngine;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (embedded: number): EmbedTickResult => ({ embedded, pages_processed: embedded, skipped: 0 });

describe('startEmbedCron', () => {
  test('fires the first tick after the staggered offset (interval/2), then on interval', async () => {
    let calls = 0;
    const handle = startEmbedCron(fakeEngine, 40, { embedOnce: async () => { calls++; return ok(0); } });
    await sleep(10);
    expect(calls).toBe(0);           // before the interval/2 (=20ms) offset
    await sleep(25);
    expect(calls).toBe(1);           // first staggered tick fired (~20ms)
    await sleep(45);
    expect(calls).toBeGreaterThanOrEqual(2); // interval ticks following
    handle.stop();
  });

  test('re-entrancy guard: a slow embed pass is not overlapped by the next interval', async () => {
    let active = 0;
    let maxActive = 0;
    let starts = 0;
    const handle = startEmbedCron(fakeEngine, 30, {
      embedOnce: async () => {
        starts++;
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(80); // outlasts several intervals
        active--;
        return ok(0);
      },
    });
    await sleep(140);
    handle.stop();
    expect(maxActive).toBe(1);       // never two embed passes at once
    expect(starts).toBeGreaterThanOrEqual(1);
  });

  test('a throwing tick is non-fatal — the cron keeps ticking', async () => {
    let calls = 0;
    const handle = startEmbedCron(fakeEngine, 30, {
      embedOnce: async () => { calls++; throw new Error('transient gateway blip'); },
    });
    await sleep(90);
    handle.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // recovered after the first throw
  });

  test('stop() halts further ticks', async () => {
    let calls = 0;
    const handle = startEmbedCron(fakeEngine, 20, { embedOnce: async () => { calls++; return ok(0); } });
    await sleep(35);
    handle.stop();
    const after = calls;
    await sleep(60);
    expect(calls).toBe(after);       // no ticks after stop()
  });
});
