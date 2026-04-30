/**
 * Phase 1 evidence: append_evidence test cases per PLAN.md.
 *
 * Coverage:
 *   - happy path (writes a row, returns it)
 *   - content-hash idempotency (same content + entities + source = same row)
 *   - EVIDENCE_ENTITY_UNKNOWN rejection (any unknown entity_ref → throw)
 *   - invalid auth (missing author in context → throw)
 *   - concurrent-append-doesn't-race (Promise.all with same hash → one row)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { DentOperationError } from '../../../src/dent/errors.ts';
import { evidenceContentHash } from '../../../src/dent/operations/evidence.ts';
import {
  setupEvidenceEngine,
  truncateEvidence,
  seedEntityPages,
  makeCtx,
  findOp,
} from './_helpers.ts';

const STEVE = 'entities/people/steve-broback';
const JASON = 'entities/people/jason-preston';

let engine: PGLiteEngine;

beforeAll(async () => {
  ({ engine } = await setupEvidenceEngine());
  await seedEntityPages(engine, [STEVE, JASON]);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await truncateEvidence(engine);
});

describe('append_evidence', () => {
  const op = findOp('append_evidence');

  test('happy path: writes a row, returns it with id+content_hash', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const result = (await op.handler(ctx, {
      content: 'Steve confirmed Dent 2026 dates in our 1:1.',
      entity_refs: [STEVE],
      source_type: 'meeting',
      source_ref: 'meetings/2026-04-29-jason-steve',
      observed_at: '2026-04-29T15:00:00Z',
    })) as Record<string, unknown>;

    expect(result.id).toBeString();
    expect(result.content_hash).toBeString();
    expect(result.author).toBe('jason-test');
    expect((result.entity_refs as string[]).includes(STEVE)).toBe(true);
    expect(result.source_type).toBe('meeting');

    const rows = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM evidence');
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  test('content_hash is deterministic for same input', () => {
    const a = evidenceContentHash({
      content: 'X',
      entity_refs: [STEVE, JASON],
      source_type: 'meeting',
      source_ref: 'r1',
    });
    const b = evidenceContentHash({
      content: 'X',
      entity_refs: [JASON, STEVE], // order swapped — should still match (sorted internally)
      source_type: 'meeting',
      source_ref: 'r1',
    });
    expect(a).toBe(b);
  });

  test('content_hash differs when source_type changes', () => {
    const a = evidenceContentHash({ content: 'X', entity_refs: [STEVE], source_type: 'meeting' });
    const b = evidenceContentHash({ content: 'X', entity_refs: [STEVE], source_type: 'email' });
    expect(a).not.toBe(b);
  });

  test('idempotency: same payload twice returns same id, only one row', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const payload = {
      content: 'Idempotent claim',
      entity_refs: [STEVE],
      source_type: 'observation',
      source_ref: 'test:1',
      observed_at: '2026-04-29T15:00:00Z',
    };
    const first = (await op.handler(ctx, payload)) as Record<string, unknown>;
    const second = (await op.handler(ctx, payload)) as Record<string, unknown>;

    expect(first.id).toBe(second.id as string);
    expect(first.content_hash).toBe(second.content_hash as string);

    const rows = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM evidence');
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  test('EVIDENCE_ENTITY_UNKNOWN: rejects unknown entity slug', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    let thrown: unknown;
    try {
      await op.handler(ctx, {
        content: 'X',
        entity_refs: ['entities/people/nobody'],
        source_type: 'observation',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect((thrown as DentOperationError).code).toBe('evidence_entity_unknown');
    expect((thrown as DentOperationError).message).toContain('entities/people/nobody');
  });

  test('EVIDENCE_ENTITY_UNKNOWN: rejects mixed known + unknown', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    let thrown: unknown;
    try {
      await op.handler(ctx, {
        content: 'X',
        entity_refs: [STEVE, 'entities/people/ghost'],
        source_type: 'observation',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect((thrown as DentOperationError).code).toBe('evidence_entity_unknown');
    // Known one should NOT appear in the missing list.
    expect((thrown as DentOperationError).message).not.toContain(STEVE);
    expect((thrown as DentOperationError).message).toContain('entities/people/ghost');
  });

  test('auth_invalid: missing author in context rejects', async () => {
    const ctx = makeCtx(engine, ''); // empty author
    let thrown: unknown;
    try {
      await op.handler(ctx, {
        content: 'X',
        entity_refs: [STEVE],
        source_type: 'observation',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect((thrown as DentOperationError).code).toBe('auth_invalid');
  });

  test('rejects empty entity_refs array', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    let thrown: unknown;
    try {
      await op.handler(ctx, {
        content: 'X',
        entity_refs: [],
        source_type: 'observation',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
  });

  test('concurrent-append-doesnt-race: 5 parallel identical appends → 1 row', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const payload = {
      content: 'Concurrent claim',
      entity_refs: [STEVE],
      source_type: 'meeting',
      source_ref: 'meetings/race',
      observed_at: '2026-04-29T15:00:00Z',
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => op.handler(ctx, payload)),
    );
    const ids = new Set(results.map((r) => (r as { id: string }).id));
    expect(ids.size).toBe(1);

    const rows = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM evidence');
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  test('dry_run: returns preview, writes nothing', async () => {
    const ctx = makeCtx(engine, 'jason-test', /* dryRun */ true);
    const result = (await op.handler(ctx, {
      content: 'preview',
      entity_refs: [STEVE],
      source_type: 'observation',
    })) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);

    const rows = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM evidence');
    expect(parseInt(rows[0].count, 10)).toBe(0);
  });
});
