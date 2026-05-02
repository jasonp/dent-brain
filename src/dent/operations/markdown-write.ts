/**
 * MCP ops for the markdown-canonical write path (PLAN v2.0 Phase 1).
 *
 *   - markdown_append_to_page: 95% case. Append a fragment to a page,
 *     under an optional section heading or at EOF.
 *   - markdown_replace_page: rare case. Full rewrite with optimistic
 *     concurrency via expected_prior_hash.
 *
 * Both ops:
 *   - Are mutating (set ctx.dryRun gate).
 *   - Enforce per-token write rate limit: 30 writes/min/token. The
 *     limiter is in-handler, separate from the transport-level limiter
 *     in src/mcp/rate-limit.ts (which is per-token-per-IP, not write-
 *     specific).
 *   - Surface server errors via DentOperationError so the dispatcher's
 *     OperationError instanceof check serializes the right shape.
 */

import type { Operation } from '../../core/operations.ts';
import { DentOperationError } from '../errors.ts';
import { appendToPage } from '../markdown-writer/append.ts';
import { replacePage, hashContent } from '../markdown-writer/replace.ts';

// ---------------------------------------------------------------------------
// Per-token write rate limit
// ---------------------------------------------------------------------------

const WRITE_RATE_PER_MIN = 30;

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

/** Returns true if the call is allowed; false if the token is over the cap. */
export function checkWriteRate(tokenKey: string, now: number = Date.now()): boolean {
  const refillRatePerMs = WRITE_RATE_PER_MIN / 60_000;
  const bucket = buckets.get(tokenKey) ?? { tokens: WRITE_RATE_PER_MIN, lastRefill: now };
  const elapsed = now - bucket.lastRefill;
  const refilled = Math.min(WRITE_RATE_PER_MIN, bucket.tokens + elapsed * refillRatePerMs);
  if (refilled < 1) {
    buckets.set(tokenKey, { tokens: refilled, lastRefill: now });
    return false;
  }
  buckets.set(tokenKey, { tokens: refilled - 1, lastRefill: now });
  return true;
}

/** For tests: reset bucket state. */
export function __resetWriteRateForTests(): void {
  buckets.clear();
}

function tokenKeyFor(ctx: { tokenName?: string }): string {
  // OperationContext doesn't currently surface tokenName; fall back to a
  // shared bucket. When the dispatcher learns to thread tokenName through
  // (Phase 2-ish), this swaps to per-token. Until then, the limiter is
  // a global-server cap of 30 writes/min — still useful as a runaway-loop
  // brake, just not per-token-fair.
  return ctx.tokenName ?? '__shared__';
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

// ---------------------------------------------------------------------------
// markdown_append_to_page
// ---------------------------------------------------------------------------

const markdown_append_to_page: Operation = {
  name: 'markdown_append_to_page',
  description:
    "Append a fragment to a markdown page in dent-brain-data, then push to GitHub and re-index. Use this for individual observations/bullets — the canonical write path. The fragment is spliced under `section` (case-insensitive `## …` heading match) or at EOF if `section` is omitted. Concurrent writers commute via git pull --rebase. Per-token write cap: 30/min.",
  params: {
    slug: {
      type: 'string',
      required: true,
      description: 'Page slug (e.g. "entities/people/steve-broback"). Resolves to <repo>/<slug>.md.',
    },
    content: {
      type: 'string',
      required: true,
      description: 'Markdown fragment to append (a bullet, a paragraph, a small block).',
    },
    section: {
      type: 'string',
      description: 'Optional `## …` heading to append under. Created at EOF if missing. Omit to append at EOF.',
    },
    commit_note: {
      type: 'string',
      description: 'Optional extra context for the git commit message body.',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const slug = requireString(p.slug, 'slug');
    const content = requireString(p.content, 'content');
    const section = (p.section as string | undefined) ?? undefined;
    const commitNote = (p.commit_note as string | undefined) ?? undefined;

    if (!checkWriteRate(tokenKeyFor(ctx as { tokenName?: string }))) {
      throw new DentOperationError(
        'rate_limited',
        `Write rate limit exceeded (${WRITE_RATE_PER_MIN}/min). Slow down or wait a minute.`,
      );
    }

    if (ctx.dryRun) {
      return { dry_run: true, action: 'markdown_append_to_page', slug, section };
    }

    const result = await appendToPage(ctx.engine, { slug, content, section, commitNote });
    if (result.status === 'busy') {
      throw new DentOperationError(
        'rate_limited',
        'dent-brain-data is busy serving another writer. Retry in a moment.',
      );
    }
    if (result.status === 'error') {
      throw new DentOperationError('evidence_not_found', result.error);
    }
    return result;
  },
};

// ---------------------------------------------------------------------------
// markdown_replace_page
// ---------------------------------------------------------------------------

const markdown_replace_page: Operation = {
  name: 'markdown_replace_page',
  description:
    "Replace a markdown page in dent-brain-data with new full content, then push and re-index. Pass expected_prior_hash (sha256 of the markdown you read before synthesizing) for optimistic concurrency — if the page changed since, the op returns `page_changed` with the current text so you can re-synthesize. Omit expected_prior_hash only when creating a brand-new page. Per-token write cap: 30/min.",
  params: {
    slug: {
      type: 'string',
      required: true,
      description: 'Page slug. Resolves to <repo>/<slug>.md.',
    },
    content: {
      type: 'string',
      required: true,
      description: 'Full markdown (frontmatter + body) to write.',
    },
    expected_prior_hash: {
      type: 'string',
      description: 'sha256 of the markdown the agent read before synthesizing. Required when overwriting an existing page; omit for brand-new slugs.',
    },
    commit_note: {
      type: 'string',
      description: 'Optional extra context for the git commit message body.',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const slug = requireString(p.slug, 'slug');
    const content = requireString(p.content, 'content');
    const expected_prior_hash = (p.expected_prior_hash as string | undefined) ?? undefined;
    const commitNote = (p.commit_note as string | undefined) ?? undefined;

    if (!checkWriteRate(tokenKeyFor(ctx as { tokenName?: string }))) {
      throw new DentOperationError(
        'rate_limited',
        `Write rate limit exceeded (${WRITE_RATE_PER_MIN}/min). Slow down or wait a minute.`,
      );
    }

    if (ctx.dryRun) {
      return { dry_run: true, action: 'markdown_replace_page', slug, has_prior_hash: !!expected_prior_hash };
    }

    const result = await replacePage(ctx.engine, { slug, content, expected_prior_hash, commitNote });
    if (result.status === 'busy') {
      throw new DentOperationError(
        'rate_limited',
        'dent-brain-data is busy serving another writer. Retry in a moment.',
      );
    }
    if (result.status === 'error') {
      throw new DentOperationError('evidence_not_found', result.error);
    }
    // page_changed surfaces as a normal return so the caller can branch
    // on `result.status` instead of catch — it's not an error per se.
    return result;
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const markdownWriteOperations: Operation[] = [
  markdown_append_to_page,
  markdown_replace_page,
];

export { hashContent };
