import { describe, test, expect, mock } from 'bun:test';
import { nightlyTick } from '../../src/dent/nightly-maintenance.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

// Inject a stub `runCycle` is awkward (pure-import path), but we can
// verify the gating logic directly via nightlyTick and a mock engine
// that records getConfig/setConfig calls. The runCycle invocation
// itself is exercised by the existing dream-cycle E2E suite.

function mockEngine(initialLastRun?: string): BrainEngine {
  let lastRun = initialLastRun ?? null;
  return {
    getConfig: async (k: string) => (k === 'dent_nightly_last_run' ? lastRun : null),
    setConfig: async (k: string, v: string) => {
      if (k === 'dent_nightly_last_run') lastRun = v;
    },
    // Most BrainEngine methods are unused by nightlyTick — but runCycle
    // touches a lot. Using `as never` because we'd otherwise need to stub
    // the full surface for a test that only cares about the gating.
  } as unknown as BrainEngine;
}

describe('nightlyTick gating', () => {
  test('returns too_early when current UTC hour is before threshold', async () => {
    const engine = mockEngine();
    const result = await nightlyTick(engine, {
      brainDir: '/tmp/fake',
      hourUtc: 9,
      phases: [],
      now: () => new Date('2026-05-09T07:30:00Z'), // 07:30 UTC
    });
    expect(result).toBe('too_early');
  });

  test('returns already_today when last_run is on the same UTC date', async () => {
    const engine = mockEngine('2026-05-09T09:01:42.000Z');
    const result = await nightlyTick(engine, {
      brainDir: '/tmp/fake',
      hourUtc: 9,
      phases: [],
      now: () => new Date('2026-05-09T15:00:00Z'), // later that day
    });
    expect(result).toBe('already_today');
  });

  test('passes both gates when last_run is yesterday and hour is past threshold (would fire)', async () => {
    // Note: this test stops short of asserting 'fired' because that
    // would require a real engine + brain-data dir for runCycle to do
    // anything meaningful. We just assert that we got past the gates
    // by checking that setConfig was called BEFORE runCycle would have
    // failed — verified via the lastRun mutation.
    const engine = mockEngine('2026-05-08T09:02:00.000Z'); // yesterday
    let setCalls = 0;
    const wrapped: BrainEngine = {
      ...engine,
      getConfig: engine.getConfig,
      setConfig: async (k: string, v: string) => {
        setCalls++;
        await engine.setConfig(k, v);
      },
    } as BrainEngine;
    // Wrap nightlyTick to intercept runCycle? Easier: just verify that
    // setConfig fired (which only happens after both gates pass).
    try {
      await nightlyTick(wrapped, {
        brainDir: '/tmp/nonexistent-brain-dir-for-test',
        hourUtc: 9,
        phases: [],
        now: () => new Date('2026-05-09T09:30:00Z'),
      });
    } catch {
      // runCycle throwing is expected with a fake brainDir; we only
      // care that we got past the gates.
    }
    expect(setCalls).toBeGreaterThan(0);
  });
});
