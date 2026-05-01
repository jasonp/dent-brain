/**
 * Shared test setup for dent evidence operations.
 *
 * Spins up an in-memory PGLite engine, applies gbrain core schema + dent
 * migrations, seeds entity pages, and exposes a context factory used by
 * each test file.
 */

import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../../src/core/engine.ts';
import type { OperationContext } from '../../../src/core/operations.ts';
import { runDentMigrations } from '../../../src/dent/migrate.ts';
import { dentOperations } from '../../../src/dent/operations/evidence.ts';

export async function setupEvidenceEngine(): Promise<{ engine: PGLiteEngine }> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runDentMigrations(engine);
  return { engine };
}

export async function truncateEvidence(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('DELETE FROM evidence');
}

export async function seedEntityPages(
  engine: BrainEngine,
  slugs: string[],
): Promise<void> {
  for (const slug of slugs) {
    await engine.putPage(slug, {
      type: 'person',
      title: slug.split('/').pop() ?? slug,
      compiled_truth: `Seeded entity page for ${slug} (test fixture).`,
    });
  }
}

export function makeCtx(engine: BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    dryRun,
    remote: true,
  };
}

export function findOp(name: string) {
  const op = dentOperations.find((o) => o.name === name);
  if (!op) throw new Error(`dent op not found: ${name}`);
  return op;
}
