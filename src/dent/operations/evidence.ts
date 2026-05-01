/**
 * Phase 1 evidence-log operations.
 *
 * Implements append_evidence, get_evidence, quarantine_batch, get_provenance
 * per PLAN.md Phase 1 + Eng-Review decisions A2 (GIN index), A3 (audit log
 * fields via mcp_request_log), CQ1 (entity-detection — Phase 4 plugs in here),
 * CQ5 (error taxonomy).
 *
 * These operations are exported as `dentOperations: Operation[]` and merged
 * with gbrain's core `operations` array by `src/dent/serve.ts`. They run
 * against the same Postgres engine gbrain uses, sharing the connection pool.
 *
 * Per-row author attribution lives in upstream's `mcp_request_log` (v0.22.7
 * HTTP transport audit row), not in evidence rows. Dent ops use the plain
 * OperationContext.
 */

import { createHash } from 'node:crypto';
import type { Operation, OperationContext } from '../../core/operations.ts';
import { DentOperationError } from '../errors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  id: string;
  content_hash: string;
  entity_refs: string[];
  content: string;
  source_type: string;
  source_ref: string | null;
  observed_at: string;
  appended_at: string;
  batch_id: string | null;
  quarantined_at: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Idempotency key for evidence rows.
 *
 * Same content + same entity set + same source = same record. Different
 * entities or different sources for the same words = distinct records (per
 * design call #4 sign-off 2026-04-29).
 */
export function evidenceContentHash(input: {
  content: string;
  entity_refs: string[];
  source_type: string;
  source_ref?: string | null;
}): string {
  const refs = [...input.entity_refs].sort().join(',');
  const ref = input.source_ref ?? '';
  const key = `${input.content}\n--\n${refs}\n--\n${input.source_type}\n--\n${ref}`;
  return createHash('sha256').update(key).digest('hex');
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new DentOperationError(
      'evidence_entity_unknown',
      `${name} is required and must be a non-empty string`,
    );
  }
  return v;
}

function requireStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    throw new DentOperationError(
      'evidence_entity_unknown',
      `${name} must be a non-empty array of slug strings`,
    );
  }
  return v as string[];
}

/**
 * Verify every entity_ref slug resolves to an existing page.
 *
 * Phase 1 contract: append_evidence rejects unknown entities. Phase 4 will
 * add an entity-detection service (CQ1) that creates stub pages first, then
 * appends. For Phase 1 the expectation is that callers pre-seed entity pages.
 */
async function assertEntitiesExist(
  ctx: OperationContext,
  refs: string[],
): Promise<void> {
  // Distinct + non-empty by validation; one query covers all.
  const rows = await ctx.engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE slug = ANY($1::text[])`,
    [refs],
  );
  const found = new Set(rows.map((r) => r.slug));
  const missing = refs.filter((r) => !found.has(r));
  if (missing.length > 0) {
    throw new DentOperationError(
      'evidence_entity_unknown',
      `Unknown entity slug(s): ${missing.join(', ')}`,
      'Create the entity page(s) first via put_page, or wait for the Phase 4 entity-detection service to auto-stub.',
    );
  }
}

// ---------------------------------------------------------------------------
// append_evidence
// ---------------------------------------------------------------------------

const append_evidence: Operation = {
  name: 'append_evidence',
  description:
    "Append an evidence record to the dent-brain evidence log. Every record references one or more entity slugs and carries a content hash for idempotency. Re-appending the same content + entity set + source returns the existing row instead of creating a duplicate. Per-call attribution (which token wrote it, when) lives in mcp_request_log.",
  params: {
    content: {
      type: 'string',
      required: true,
      description: 'The evidence text (observation, claim, snippet) being recorded.',
    },
    entity_refs: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Slugs of entity pages this evidence is about (e.g. ["entities/people/steve-broback"]).',
    },
    source_type: {
      type: 'string',
      required: true,
      description: "Where this evidence came from (e.g. 'meeting', 'email', 'document', 'observation', 'tweet').",
    },
    source_ref: {
      type: 'string',
      description: 'Stable pointer back to the source: meeting URL, email message-id, dropbox path, tweet ID, etc.',
    },
    observed_at: {
      type: 'string',
      description: 'When the underlying event happened (ISO-8601). Defaults to now() if omitted.',
    },
    batch_id: {
      type: 'string',
      description: 'Groups bulk-imported evidence so the entire batch can be quarantined as a unit.',
    },
    metadata: {
      type: 'object',
      description: 'Free-form JSON metadata (e.g. confidence score, classifier rule that fired).',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const content = requireString(p.content, 'content');
    const entity_refs = requireStringArray(p.entity_refs, 'entity_refs');
    const source_type = requireString(p.source_type, 'source_type');
    const source_ref = (p.source_ref as string | undefined) ?? null;
    const observed_at = (p.observed_at as string | undefined) ?? new Date().toISOString();
    const batch_id = (p.batch_id as string | undefined) ?? null;
    const metadata = (p.metadata as Record<string, unknown> | undefined) ?? {};

    await assertEntitiesExist(ctx, entity_refs);

    const content_hash = evidenceContentHash({
      content,
      entity_refs,
      source_type,
      source_ref,
    });

    if (ctx.dryRun) {
      return {
        dry_run: true,
        would_insert: { content_hash, entity_refs, source_type, source_ref },
      };
    }

    // Idempotent insert: ON CONFLICT on content_hash returns the existing row's id.
    // The two-statement pattern (INSERT ... ON CONFLICT DO NOTHING + SELECT) is
    // race-safe under transaction-mode PgBouncer because content_hash is UNIQUE.
    await ctx.engine.executeRaw(
      `INSERT INTO evidence (content_hash, entity_refs, content, source_type, source_ref, observed_at, batch_id, metadata)
       VALUES ($1, $2::text[], $3, $4, $5, $6::timestamptz, $7::uuid, $8::jsonb)
       ON CONFLICT (content_hash) DO NOTHING`,
      [content_hash, entity_refs, content, source_type, source_ref, observed_at, batch_id, JSON.stringify(metadata)],
    );

    const rows = await ctx.engine.executeRaw<EvidenceRow>(
      `SELECT id, content_hash, entity_refs, content, source_type, source_ref,
              observed_at::text AS observed_at,
              appended_at::text AS appended_at,
              batch_id, quarantined_at::text AS quarantined_at, metadata
       FROM evidence WHERE content_hash = $1`,
      [content_hash],
    );
    if (rows.length === 0) {
      throw new DentOperationError('evidence_not_found', 'append_evidence inserted but row not found on read-back (transient)');
    }
    return rows[0];
  },
};

// ---------------------------------------------------------------------------
// get_evidence
// ---------------------------------------------------------------------------

const get_evidence: Operation = {
  name: 'get_evidence',
  description:
    'Retrieve evidence records referencing an entity slug, reverse-chronological. Quarantined records excluded by default.',
  params: {
    entity_ref: {
      type: 'string',
      required: true,
      description: 'Entity slug to fetch evidence for (e.g. "entities/people/steve-broback").',
    },
    limit: {
      type: 'number',
      description: 'Max results (default 50, cap 200).',
    },
    include_quarantined: {
      type: 'boolean',
      description: 'Include soft-deleted records. Default false.',
    },
  },
  handler: async (ctx, p) => {
    const entity_ref = requireString(p.entity_ref, 'entity_ref');
    const requested = typeof p.limit === 'number' ? p.limit : 50;
    const limit = Math.max(1, Math.min(200, Math.floor(requested)));
    const includeQuarantined = !!p.include_quarantined;

    const sql = includeQuarantined
      ? `SELECT id, content_hash, entity_refs, content, source_type, source_ref,
                observed_at::text AS observed_at,
                appended_at::text AS appended_at,
                batch_id, quarantined_at::text AS quarantined_at, metadata
         FROM evidence
         WHERE $1 = ANY(entity_refs)
         ORDER BY appended_at DESC
         LIMIT $2`
      : `SELECT id, content_hash, entity_refs, content, source_type, source_ref,
                observed_at::text AS observed_at,
                appended_at::text AS appended_at,
                batch_id, quarantined_at::text AS quarantined_at, metadata
         FROM evidence
         WHERE $1 = ANY(entity_refs) AND quarantined_at IS NULL
         ORDER BY appended_at DESC
         LIMIT $2`;

    const rows = await ctx.engine.executeRaw<EvidenceRow>(sql, [entity_ref, limit]);
    return { evidence: rows, count: rows.length, entity_ref, limit, include_quarantined: includeQuarantined };
  },
};

// ---------------------------------------------------------------------------
// quarantine_batch
// ---------------------------------------------------------------------------

const quarantine_batch: Operation = {
  name: 'quarantine_batch',
  description:
    'Soft-delete all evidence records sharing a batch_id by setting quarantined_at = now(). Reversible — pass un_quarantine=true to restore.',
  params: {
    batch_id: {
      type: 'string',
      required: true,
      description: 'UUID of the batch to quarantine (or un-quarantine).',
    },
    un_quarantine: {
      type: 'boolean',
      description: 'Set to true to clear quarantined_at instead of setting it.',
    },
    reason: {
      type: 'string',
      description: 'Free-form note recorded on each affected row\'s metadata.quarantine_reason.',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const batch_id = requireString(p.batch_id, 'batch_id');
    const un_quarantine = !!p.un_quarantine;
    const reason = (p.reason as string | undefined) ?? null;

    if (ctx.dryRun) {
      const peek = await ctx.engine.executeRaw<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM evidence WHERE batch_id = $1`,
        [batch_id],
      );
      return { dry_run: true, batch_id, un_quarantine, would_affect: parseInt(peek[0]?.count || '0', 10) };
    }

    if (un_quarantine) {
      const rows = await ctx.engine.executeRaw<{ id: string }>(
        `UPDATE evidence
            SET quarantined_at = NULL,
                metadata = metadata - 'quarantine_reason'
          WHERE batch_id = $1 AND quarantined_at IS NOT NULL
        RETURNING id`,
        [batch_id],
      );
      return { batch_id, un_quarantined: true, affected: rows.length };
    }

    // Quarantine: stamp quarantined_at + (optionally) record reason in metadata.
    const rows = reason
      ? await ctx.engine.executeRaw<{ id: string }>(
          `UPDATE evidence
              SET quarantined_at = now(),
                  metadata = metadata || jsonb_build_object('quarantine_reason', $2::text)
            WHERE batch_id = $1 AND quarantined_at IS NULL
          RETURNING id`,
          [batch_id, reason],
        )
      : await ctx.engine.executeRaw<{ id: string }>(
          `UPDATE evidence
              SET quarantined_at = now()
            WHERE batch_id = $1 AND quarantined_at IS NULL
          RETURNING id`,
          [batch_id],
        );
    return { batch_id, quarantined: true, affected: rows.length, reason };
  },
};

// ---------------------------------------------------------------------------
// get_provenance
// ---------------------------------------------------------------------------

const get_provenance: Operation = {
  name: 'get_provenance',
  description:
    'Return full source attribution for one evidence record by id: source_type, source_ref, observed_at, batch_id, content_hash, quarantine state, and metadata. Per-call author attribution lives in mcp_request_log, not on the row.',
  params: {
    evidence_id: {
      type: 'string',
      required: true,
      description: 'UUID of the evidence row.',
    },
  },
  handler: async (ctx, p) => {
    const evidence_id = requireString(p.evidence_id, 'evidence_id');

    const rows = await ctx.engine.executeRaw<EvidenceRow>(
      `SELECT id, content_hash, entity_refs, content, source_type, source_ref,
              observed_at::text AS observed_at,
              appended_at::text AS appended_at,
              batch_id, quarantined_at::text AS quarantined_at, metadata
       FROM evidence WHERE id = $1`,
      [evidence_id],
    );
    if (rows.length === 0) {
      throw new DentOperationError(
        'evidence_not_found',
        `No evidence record with id ${evidence_id}`,
      );
    }
    const row = rows[0];
    return {
      id: row.id,
      content_hash: row.content_hash,
      entity_refs: row.entity_refs,
      source_type: row.source_type,
      source_ref: row.source_ref,
      observed_at: row.observed_at,
      appended_at: row.appended_at,
      batch_id: row.batch_id,
      quarantined: row.quarantined_at !== null,
      quarantined_at: row.quarantined_at,
      metadata: row.metadata,
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const dentOperations: Operation[] = [
  append_evidence,
  get_evidence,
  quarantine_batch,
  get_provenance,
];
