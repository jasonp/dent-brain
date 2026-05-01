/**
 * Phase 1 evidence: get_provenance test cases per PLAN.md.
 *
 * Coverage:
 *   - full source attribution returned (author lives in mcp_request_log,
 *     not on the row — Option B retrofit, v1.8)
 *   - EVIDENCE_NOT_FOUND on missing id
 *   - quarantine state surfaces correctly
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { DentOperationError } from '../../../src/dent/errors.ts';
import {
  setupEvidenceEngine,
  truncateEvidence,
  seedEntityPages,
  makeCtx,
  findOp,
} from './_helpers.ts';

const STEVE = 'entities/people/steve-broback';
const BATCH = 'feedface-1234-5678-90ab-cdef01234567';

let engine: PGLiteEngine;

beforeAll(async () => {
  ({ engine } = await setupEvidenceEngine());
  await seedEntityPages(engine, [STEVE]);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await truncateEvidence(engine);
});

describe('get_provenance', () => {
  const append = findOp('append_evidence');
  const provenance = findOp('get_provenance');
  const quarantine = findOp('quarantine_batch');

  test('returns full source attribution (no author field)', async () => {
    const ctx = makeCtx(engine);
    const inserted = (await append.handler(ctx, {
      content: 'Steve hosted Dent 2025 attendees in Whistler.',
      entity_refs: [STEVE],
      source_type: 'meeting',
      source_ref: 'meetings/whistler-2025',
      observed_at: '2025-12-08T14:00:00Z',
      batch_id: BATCH,
      metadata: { confidence: 0.9, classifier_rule: 'meeting-notes-v1' },
    })) as { id: string; content_hash: string };

    const result = (await provenance.handler(ctx, { evidence_id: inserted.id })) as {
      id: string;
      content_hash: string;
      entity_refs: string[];
      source_type: string;
      source_ref: string;
      observed_at: string;
      appended_at: string;
      batch_id: string;
      quarantined: boolean;
      quarantined_at: string | null;
      metadata: Record<string, unknown>;
    };

    expect(result.id).toBe(inserted.id);
    expect(result.content_hash).toBe(inserted.content_hash);
    expect(result.entity_refs).toEqual([STEVE]);
    expect(result.source_type).toBe('meeting');
    expect(result.source_ref).toBe('meetings/whistler-2025');
    expect(result.observed_at.startsWith('2025-12-08')).toBe(true);
    expect(result.appended_at).toBeString();
    expect(result.batch_id).toBe(BATCH);
    expect(result.quarantined).toBe(false);
    expect(result.quarantined_at).toBeNull();
    expect(result.metadata.confidence).toBe(0.9);
    expect(result.metadata.classifier_rule).toBe('meeting-notes-v1');
    // Author column dropped in dent migration v2 — provenance no longer
    // returns it. Per-call author lives in mcp_request_log.
    expect(result).not.toHaveProperty('author');
  });

  test('quarantine state visible after batch quarantine', async () => {
    const ctx = makeCtx(engine);
    const inserted = (await append.handler(ctx, {
      content: 'doomed claim',
      entity_refs: [STEVE],
      source_type: 'observation',
      batch_id: BATCH,
    })) as { id: string };

    await quarantine.handler(ctx, { batch_id: BATCH, reason: 'wrong attribution' });

    const result = (await provenance.handler(ctx, { evidence_id: inserted.id })) as {
      quarantined: boolean;
      quarantined_at: string | null;
      metadata: Record<string, unknown>;
    };
    expect(result.quarantined).toBe(true);
    expect(result.quarantined_at).not.toBeNull();
    expect(result.metadata.quarantine_reason).toBe('wrong attribution');
  });

  test('EVIDENCE_NOT_FOUND on unknown id', async () => {
    const ctx = makeCtx(engine);
    let thrown: unknown;
    try {
      await provenance.handler(ctx, { evidence_id: '00000000-0000-0000-0000-000000000000' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DentOperationError);
    expect((thrown as DentOperationError).code).toBe('evidence_not_found');
  });
});
