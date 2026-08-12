/**
 * Guards the email-sync install manifest against drift.
 *
 * `install.ts` copies a hardcoded list of modules into
 * `~/.dent-brain/email-sync/`. Add a module to the collector, forget the list,
 * and you ship a daemon that cannot start: the copied `collect.ts` imports a
 * file that was never copied, and every scheduled fire dies on the import.
 *
 * Nothing else catches that. The repo typechecks (all files present locally),
 * the unit suite passes, and the break only surfaces on someone else's machine
 * after `/dent-update`. This test closes the module graph instead of trusting
 * anyone to remember — it starts at the daemon entrypoint and walks every
 * relative import transitively.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RUNTIME_FILES } from '../tools/email-sync/install.ts';

const DIR = join(import.meta.dir, '..', 'tools', 'email-sync');
const ENTRYPOINTS = ['collect.ts', 'oauth-flow.ts'];

/** Relative-import specifiers in a file, normalized to bare filenames. */
function localImports(file: string): string[] {
  const src = readFileSync(join(DIR, file), 'utf-8');
  const out: string[] = [];
  // Covers `import ... from './x.ts'`, `export ... from './x.ts'`, and
  // `await import('./x.ts')` — all three appear in this tree.
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
    out.push(m[1].replace(/^\.\//, ''));
  }
  return out;
}

/** Everything reachable from the daemon entrypoints, transitively. */
function reachableModules(): Set<string> {
  const seen = new Set<string>();
  const queue = [...ENTRYPOINTS];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of localImports(file)) {
      // `recipe/` and `user/` are copied separately / owned by the teammate.
      if (dep.includes('/')) continue;
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

describe('email-sync install manifest', () => {
  test('every module the daemon imports is in RUNTIME_FILES', () => {
    const missing = [...reachableModules()].filter((m) => !RUNTIME_FILES.includes(m as never)).sort();
    expect(missing).toEqual([]);
  });

  test('RUNTIME_FILES has no entries the daemon never imports', () => {
    const reachable = reachableModules();
    const orphans = RUNTIME_FILES.filter((f) => !reachable.has(f)).sort();
    expect(orphans).toEqual([]);
  });

  test('gmail-state.ts specifically is shipped (the module that motivated this guard)', () => {
    expect(RUNTIME_FILES).toContain('gmail-state.ts');
  });

  test('the manifest has no duplicates', () => {
    expect(new Set(RUNTIME_FILES).size).toBe(RUNTIME_FILES.length);
  });

  test('every listed file actually exists on disk', () => {
    for (const f of RUNTIME_FILES) {
      expect(() => readFileSync(join(DIR, f), 'utf-8')).not.toThrow();
    }
  });
});
