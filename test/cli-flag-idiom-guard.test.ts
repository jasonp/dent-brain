/**
 * Source-text guard: the space-only flag-reading idioms must not creep back.
 *
 * Every CLI_ONLY command used to read long-flag values with a hand-rolled
 * idiom that matched ONLY the space-separated spelling, so `--source=wiki` was
 * silently dropped and the command fell through to ambient defaults. For sync
 * that meant writing pages and taking the per-source lock under a source the
 * operator never named.
 *
 * Unit tests cover `readFlagValue` itself and CLI tests cover the sync wiring,
 * but neither would catch a NEW call site (or a revert of an existing one) that
 * reintroduces the raw idiom — reverting any of the converted sites passes the
 * whole suite otherwise. This guard is the cheap backstop for all of them at
 * once.
 *
 * ALLOWLIST is the honest record of what has not been converted yet, tracked as
 * a P2 in TODOS.md. Shrink it; never grow it without a TODO entry.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..', 'src');

/** Not yet converted — see the P2 "finish the equals-form sweep" in TODOS.md. */
const ALLOWLIST = new Set([
  'commands/schema.ts',      // --pack, plus multi-flag `args[++i]` parser loops
  'commands/skillpack.ts',   // --url
  'commands/sources-demo.ts', // --dir, --limit
]);

/** The file that legitimately implements the correct readers. */
const IMPLEMENTATION = 'core/cli-flag-value.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Both spellings of the bug. Kept as source text, not flag literals, so this
// file stays free of tokens the flag-registry generator would scrape.
const IDIOMS: Array<{ label: string; re: RegExp }> = [
  { label: 'args.find((a, i) => args[i - 1] === <flag>)', re: /args\[i - 1\] ===\s*'-/ },
  { label: "hand loop: args[i] === '<flag>'", re: /args\[i\] ===\s*'-/ },
];

describe('space-only flag-reading idioms do not come back', () => {
  for (const { label, re } of IDIOMS) {
    test(`no unallowlisted source file uses the ${label} idiom`, () => {
      const offenders: string[] = [];
      for (const file of walk(SRC)) {
        const rel = relative(SRC, file);
        if (rel === IMPLEMENTATION || ALLOWLIST.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const [n, line] of text.split('\n').entries()) {
          if (re.test(line)) offenders.push(`${rel}:${n + 1}: ${line.trim()}`);
        }
      }
      expect(
        offenders,
        `These read a long flag space-only, so the '<flag>=value' spelling is silently dropped.\n` +
          `Use readFlagValue (or readFlagValues for a repeatable flag) from src/core/cli-flag-value.ts:\n` +
          offenders.join('\n'),
      ).toEqual([]);
    });
  }

  test('the allowlist stays honest — every entry still exists and still offends', () => {
    for (const rel of ALLOWLIST) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      const stillOffends = IDIOMS.some(({ re }) => text.split('\n').some((l) => re.test(l)));
      expect(stillOffends, `${rel} is allowlisted but no longer uses the idiom — drop it from ALLOWLIST`).toBe(true);
    }
  });
});

/**
 * Guards for the two values that honoring the equals spelling made REACHABLE
 * for the first time. Both are source-text assertions rather than CLI runs: the
 * commands they live in need a brain, a registered source and (for the webhook
 * path) a configured remote, which is far more setup than the one-line guard
 * being pinned is worth.
 */
describe('values newly reachable via the equals spelling are guarded', () => {
  test('an empty --secret is rejected rather than persisted as a blank credential', () => {
    const src = readFileSync(join(SRC, 'commands/sources.ts'), 'utf8');
    // `??` only falls back on null/undefined, so `""` would sail through and be
    // written as webhook_secret. Verification is fail-closed, so every delivery
    // would 401 while `sources webhook show` reported "(not set)".
    expect(src).toMatch(/explicitSecret !== undefined && explicitSecret\.length === 0/);
    expect(src).toMatch(/--secret was given an empty value/);
  });

  test('--strategy is validated before the cast, not blind-cast', () => {
    const src = readFileSync(join(SRC, 'commands/sync.ts'), 'utf8');
    // isAllowedByStrategy's fallback is the WIDEST admission set, so an
    // unrecognized value broadens ingest and embed spend instead of narrowing.
    expect(src).toMatch(/\['markdown', 'code', 'auto'\]\.includes\(strategyRaw\)/);
    expect(src).toMatch(/Invalid --strategy value/);
  });
});
