/**
 * Behavioral pin for the completed `--source` equals-spelling sweep.
 *
 * `test/cli-flag-idiom-guard.test.ts` is STRUCTURAL — it greps src/ for the
 * hand-rolled argv idiom. That proves the shape, not the behavior, and a
 * future refactor could satisfy the grep while still dropping the value. This
 * file exercises the real parsers through the equals-joined spelling and
 * asserts the resolved source, one arm per parser shape the sweep touched:
 *
 *   - a local `flagValue`-style helper delegating to readFlagValue
 *   - a parser loop normalized once with expandEqualsFlags
 *   - a DEFAULT-DENY delegation classifier, where the pre-fix behavior was a
 *     refusal ("unknown token") rather than a silent drop
 *
 * The bug this pins: `gbrain <cmd> --source=<id>` matched no space-separated
 * arm, so the value was dropped and the command fell through to the AMBIENT
 * source chain — reading, and for embed/sweep WRITING, under a source the
 * operator never named.
 */
import { describe, expect, test } from 'bun:test';
import { parseDelegatedSyncArgs } from '../src/commands/sync-delegate.ts';
import { parseDelegatedSweepArgs } from '../src/commands/sweep-delegate.ts';
import { parseFlag } from '../src/commands/code-scope.ts';
import { readFlagValue, readFlagValues, expandEqualsFlags } from '../src/core/cli-flag-value.ts';

describe('--source honors both spellings after the sweep', () => {
  test('helper shape (code-scope parseFlag): equals form resolves', () => {
    expect(parseFlag(['--source=wiki'], '--source')).toBe('wiki');
    expect(parseFlag(['--source', 'wiki'], '--source')).toBe('wiki');
    expect(parseFlag(['--json'], '--source')).toBeUndefined();
  });

  test('default-deny classifier (sync-delegate): equals form is ACCEPTED, not refused', () => {
    const eq = parseDelegatedSyncArgs(['--source=wiki']);
    expect(eq).toEqual({ ok: true, options: {}, explicitSource: 'wiki' });
    // Same answer as the spelling that always worked.
    expect(parseDelegatedSyncArgs(['--source', 'wiki'])).toEqual(eq);
  });

  test('default-deny classifier (sweep-delegate): equals form is ACCEPTED, not refused', () => {
    const eq = parseDelegatedSweepArgs(['--source=wiki']);
    expect(eq.ok).toBe(true);
    if (eq.ok) expect(eq.options.sourceId).toBe('wiki');
    expect(parseDelegatedSweepArgs(['--source', 'wiki'])).toEqual(eq);
  });

  test('a value containing "=" survives the split (first separator only)', () => {
    expect(readFlagValue(['--source=a=b'], '--source')).toBe('a=b');
    expect(expandEqualsFlags(['--source=a=b'])).toEqual(['--source', 'a=b']);
  });

  test('repeatable flags need readFlagValues — readFlagValue keeps only the first', () => {
    const argv = ['--exclude=one', '--exclude', 'two'];
    expect(readFlagValue(argv, '--exclude')).toBe('one');
    expect(readFlagValues(argv, '--exclude')).toEqual(['one', 'two']);
  });

  test('expandEqualsFlags leaves positionals and bare flags untouched', () => {
    expect(expandEqualsFlags(['sync', '--json', 'a=b', '--source=x']))
      .toEqual(['sync', '--json', 'a=b', '--source', 'x']);
  });
});
