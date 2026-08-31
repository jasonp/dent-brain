/**
 * Reading a long flag's value out of raw argv.
 *
 * Deliberately its own module rather than living in `cli-options.ts`: the
 * flag-registry generator follows imports to decide which flags a command can
 * see, so importing the global-option module into a command that only needs
 * this helper would attribute every global flag to that command and leave a
 * false-permissive row in `cli-flag-registry.generated.ts`. This file mentions
 * no flags, so importing it costs nothing.
 */

/**
 * Read a long flag's value, accepting BOTH the space-separated and the
 * equals-joined spelling (`<name> value` and `<name>=value`).
 *
 * Drop-in for the `args.find((a, i) => args[i - 1] === <name>)` idiom spread
 * across the CLI-only commands: same `string | undefined` return, but it no
 * longer silently misses the equals spelling. That miss was not cosmetic — a
 * source passed in the equals spelling fell through to the AMBIENT source
 * chain, so sync wrote pages and took the per-source lock under a source the
 * operator never named, while printing a nudge telling them to pass the very
 * flag they had just passed.
 *
 * The CLI-only commands never reach `parseOpArgs`'s key=value handling, so
 * this is the only place the equals spelling gets honored for them.
 *
 * Pass several names when one flag has aliases. Scans argv once in order, so
 * the FIRST occurrence wins regardless of which spelling or alias it used.
 *
 * That is a deliberate, and slightly different, rule from what it replaced: the
 * old idiom took the first SPACE-separated occurrence and ignored the equals
 * spelling entirely, so a duplicated flag could resolve differently. Nothing in
 * this repo builds argv by appending flags after caller-supplied input (job
 * argv is built from structured data, and the global flags are stripped by
 * parseGlobalFlags before a command ever sees args), but an external wrapper
 * that appends a constraining flag would now lose to an earlier one.
 *
 * NOTE: keep literal double-dash tokens OUT of this file AND out of the
 * comments at every call site. The flag-registry
 * generator scrapes source text and attributes anything flag-shaped to the
 * importing commands, silently drifting the generated registry (caught by
 * test/cli-flag-validation.test.ts, which `bun run verify` does NOT run).
 */
export function readFlagValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const flag of flags) {
      if (a === flag) return args[i + 1];
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Collect EVERY occurrence of a repeatable flag, in both spellings.
 *
 * `readFlagValue` is first-occurrence-wins by design, so it is not a drop-in
 * for a repeatable flag: using it would silently discard every value after the
 * first. Faithful to the hand-rolled loops it replaces, a bare name whose next
 * token is missing contributes nothing, and the scan does not skip over the
 * consumed value (so a name immediately followed by another name yields that
 * name as a value, exactly as before).
 */
export function readFlagValues(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const flag of flags) {
      if (a === flag) {
        if (i + 1 < args.length) out.push(args[i + 1]);
        break;
      }
      if (a.startsWith(`${flag}=`)) {
        out.push(a.slice(flag.length + 1));
        break;
      }
    }
  }
  return out;
}

/**
 * Normalize an argv so an equals-joined flag becomes two tokens.
 *
 * The readers above suit a command that pulls a few named values out of argv.
 * A command with a full parser LOOP (`const a = args[i]` then a chain of
 * `a === <name>` arms consuming `args[++i]`) is better served by normalizing
 * ONCE at the top: every flag in that loop then accepts both spellings without
 * touching a single arm, which is far less invasive — and less risky — than
 * rewriting a long else-if chain.
 *
 * Splits on the FIRST separator only, so a value that itself contains one
 * survives intact. A token that is not flag-shaped passes through untouched, so
 * this is safe to apply to a whole argv including positionals.
 */
export function expandEqualsFlags(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 2) {
      out.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}
