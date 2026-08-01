/**
 * Structural guard: the server MUST configure the AI gateway before starting
 * any background cron that embeds.
 *
 * This is asserted against the source text rather than by booting serve.ts,
 * because serve.ts is a side-effecting entrypoint (opens a DB pool, binds a
 * port, schedules crons) that cannot be imported in a unit test.
 *
 * WHY THIS EXISTS: `cli.ts` configured the gateway; `serve.ts` never did. Every
 * `embed-cron` tick failed with "Embedding gateway is not configured." and the
 * nightly cycle's embed phase failed identically. Nothing surfaced it — chunks
 * simply stayed NULL, vector search silently missed them, and the only evidence
 * was one stderr line per tick.
 *
 * It went unnoticed twice: once as the 2026-06 embed stall (backlog grew past
 * 1K chunks before a manual backfill), and again when the tail of the
 * ZeroEntropy migration sat on a dead provider because the cron meant to finish
 * it had never once succeeded. Both times the top-level signal was green.
 *
 * The ordering assertion matters as much as the presence one: configuring the
 * gateway *after* the crons start reintroduces the same race for early ticks.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVE_PATH = join(import.meta.dir, '../../src/dent/serve.ts');
const src = readFileSync(SERVE_PATH, 'utf-8');

describe('serve.ts AI gateway configuration', () => {
  test('calls configureGateway()', () => {
    expect(src).toContain('configureGateway(');
  });

  test('builds the gateway config from the loaded brain config', () => {
    // buildGatewayConfig is the single site that folds file-plane API keys
    // (openai/anthropic/cohere/zeroentropy) into the gateway env. Calling
    // configureGateway without it would produce a gateway with no credentials.
    expect(src).toContain('buildGatewayConfig(');
  });

  test('configures the gateway BEFORE starting the embed cron', () => {
    const configureAt = src.indexOf('configureGateway(');
    const embedCronAt = src.indexOf('startEmbedCron(');
    expect(configureAt).toBeGreaterThan(-1);
    expect(embedCronAt).toBeGreaterThan(-1);
    // Ordering is the whole point: a gateway configured after the cron starts
    // still leaves the first ticks failing on an unconfigured gateway.
    expect(configureAt).toBeLessThan(embedCronAt);
  });

  test('configures the gateway BEFORE starting nightly maintenance', () => {
    const configureAt = src.indexOf('configureGateway(');
    const nightlyAt = src.indexOf('startNightlyMaintenance(');
    expect(configureAt).toBeGreaterThan(-1);
    expect(nightlyAt).toBeGreaterThan(-1);
    expect(configureAt).toBeLessThan(nightlyAt);
  });

  test('a configuration failure is reported loudly, not swallowed', () => {
    // A server that cannot embed must say so at startup. Silently continuing
    // is what let this hide for weeks at a time.
    const idx = src.indexOf('configureGateway(');
    const window = src.slice(Math.max(0, idx - 600), idx + 900);
    expect(window).toMatch(/ai-gateway: FAILED|console\.error/);
  });
});
