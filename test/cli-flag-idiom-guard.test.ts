/**
 * Guard: every command that reads `--source` out of argv must honor BOTH the
 * space-separated and the equals-joined spelling.
 *
 * Commands used to read long flags with hand-rolled argv scanning that matched
 * only the space-separated spelling, so an equals-joined value was silently
 * dropped and the command fell back to its AMBIENT source. That is a
 * wrong-source read, and on a write path a wrong-source WRITE: pre-fix,
 * `gbrain capture "note" --source=nosuchsource` filed the page under the
 * ambient source and reported success.
 *
 * `--source` is singled out because it is the flag with cross-source data
 * consequences. The same hand-rolled shape exists for other flags across ~75
 * files; widening this guard to all of them is filed as a P1 in TODOS.md, and
 * would be a repo-wide change, not a release.
 *
 * A file is COMPLIANT when it either routes through the readers in
 * `src/core/cli-flag-value.ts` (`readFlagValue` / `readFlagValues`) or
 * normalizes its argv once with `expandEqualsFlags` before its parser loop.
 *
 * PENDING is the honest, named list of what is not converted yet. It may only
 * SHRINK. A new entry means a new command shipped the bug, so the guard fails
 * and the author has to either convert it or consciously add it here.
 */
import { describe, test, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** Not yet converted — see the P1 "finish the --source sweep" in TODOS.md. */
const PENDING = new Set([
  // Refreshed in the v0.46.28.0->v0.48.2.0 upstream sync. Removed:
  // code-callees.ts / code-callers.ts (upstream converted them). Added, all
  // new upstream commands that arrived reading --source positionally:
  // code-scope.ts, connectors/sync.ts, loops.ts, think.ts. The guard is the
  // count of record; see the P1 in TODOS.md.
  'src/commands/auth.ts',
  'src/commands/call.ts',
  'src/commands/claw-test.ts',
  'src/commands/code-scope.ts',
  'src/commands/compile-context.ts',
  'src/commands/connectors/sync.ts',
  'src/commands/dream.ts',
  'src/commands/embed.ts',
  'src/commands/frontmatter-install-hook.ts',
  'src/commands/loops.ts',
  'src/commands/schema.ts',
  'src/commands/sweep-delegate.ts',
  'src/commands/sync-delegate.ts',
  'src/commands/takes.ts',
  'src/commands/thin-client-routing.ts',
  'src/commands/think.ts',
  'src/commands/transcripts.ts',
  'src/commands/watch.ts',
]);

/** Routes through the shared readers, or normalizes argv up front. */
const COMPLIANT = /readFlagValue\(|readFlagValues\(|expandEqualsFlags\(/;
/** Reads a flag's value by argv position — the shape that drops the equals spelling. */
const POSITIONAL = /args\[\+\+i\]|args\[i \+ 1\]|args\[i - 1\] ===/;
/** Compares an argv token against the `--source` flag literal. */
const READS_SOURCE = /=== '--source'|'--source'\s*(\)|,|\|\|)/;

function offenders(): string[] {
  const files = execSync(`grep -rl "'--source'" src/`, { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => f && !f.includes('generated'));

  return files.filter((f) => {
    // test-reads-source-ok: this guard's whole job is to enumerate how src/ reads
    // argv. Hand-counting this bug class under-counted it three times, so the
    // count has to come from the source text itself, not from a maintained list.
    const text = readFileSync(resolve(ROOT, f), 'utf8');
    return POSITIONAL.test(text) && !COMPLIANT.test(text) && READS_SOURCE.test(text);
  });
}

describe('--source is read the same way in every command', () => {
  test('no NEW command reads --source positionally without honoring both spellings', () => {
    const unexpected = offenders().filter((f) => !PENDING.has(f));
    expect(
      unexpected,
      'These read --source by argv position, so `--source=<id>` is silently dropped and the\n' +
        'command falls back to the AMBIENT source. Route through readFlagValue, or call\n' +
        'expandEqualsFlags(args) once before the parser loop:\n' +
        unexpected.join('\n'),
    ).toEqual([]);
  });

  test('PENDING only shrinks — every entry still offends', () => {
    const current = new Set(offenders());
    const stale = [...PENDING].filter((f) => !current.has(f));
    expect(
      stale,
      `Converted — delete these from PENDING (and from the P1 in TODOS.md):\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * Guards for the two values that honoring the equals spelling made REACHABLE
 * for the first time. Source-text assertions rather than CLI runs: the commands
 * they live in need a brain, a registered source and (for the webhook path) a
 * configured remote, which is far more setup than the one-line guard is worth.
 */
describe('values newly reachable via the equals spelling are guarded', () => {
  test('an empty --secret is rejected rather than persisted as a blank credential', () => {
    // test-reads-source-ok: reaching this branch needs a brain, a registered source
    // and a configured webhook remote; the one-line guard is not worth that setup.
    const src = readFileSync(resolve(ROOT, 'src/commands/sources.ts'), 'utf8');
    // `??` only falls back on null/undefined, so "" would sail through and be
    // written as webhook_secret. Verification is fail-closed, so every delivery
    // would 401 while `sources webhook show` reported "(not set)".
    expect(src).toMatch(/explicitSecret !== undefined && explicitSecret\.length === 0/);
    expect(src).toMatch(/--secret was given an empty value/);
  });

  test('--strategy is validated before the cast, not blind-cast', () => {
    // test-reads-source-ok: the CLI-level case is already covered in
    // sync-source-flag-forms.serial.test.ts; this pins that the validation itself
    // does not get refactored away from in front of the cast.
    const src = readFileSync(resolve(ROOT, 'src/commands/sync.ts'), 'utf8');
    // isAllowedByStrategy's fallback is the WIDEST admission set, so an
    // unrecognized value broadens ingest and embed spend instead of narrowing.
    expect(src).toMatch(/\['markdown', 'code', 'auto'\]\.includes\(strategyRaw\)/);
    expect(src).toMatch(/Invalid --strategy value/);
  });
});
