/**
 * RegFox ingest orchestrator. One tick = one polling pass per form.
 *
 * Per registrant the dedup flow (Q1=B with name-match guard rail):
 *
 *   1. Email match → confident merge to that entity. Append the bullet.
 *   2. No email match, but slug-from-name already exists → AMBIGUOUS.
 *      Do NOT auto-merge (could be two real people sharing a name).
 *      Write to the data repo's `_ingest/pending_regfox.md` for human review.
 *   3. No match → create a new stub via markdown_replace_page, then append.
 *
 * Slug collision handling: if the proposed slug is taken by an entity
 * with a DIFFERENT email (i.e. case 2 above), the pending-review path
 * fires. If it's taken by an entity with NO email and we have one,
 * that's also case 2. Numeric-suffix collision avoidance (`alice-2`)
 * happens inside markdown_replace_page only when we've decided to
 * create a new stub at a slug that would collide.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import { appendToPage } from '../../markdown-writer/append.ts';
import { replacePage } from '../../markdown-writer/replace.ts';
import { withBatch, type BatchHandle } from '../../markdown-writer/batch.ts';
import { RegfoxClient } from './api-client.ts';
import { translateRegistrant, kebabize, type TranslatedRegistrant, type TranslatorOptions } from './translator.ts';
import { readCursor, writeCursor, ALL_FORMS_CURSOR_KEY } from './state.ts';
import type { RegfoxRegistrant } from './types.ts';

export interface IngestOptions {
  apiKey: string;
  product?: string;
  /** Restrict polling to these form IDs. Empty = poll all forms (uses cursor 0). */
  formIds?: number[];
  /** Pages of 100 per fetch. Higher uses fewer requests but burns bigger chunks of the burst limit per call. */
  pageLimit?: number;
  /** Override path inside fieldData where the discount code lives. */
  discountFieldPath?: string;
  /** Hard-stop tick processing if burst-remaining drops below this. */
  burstFloor?: number;
  /** Maximum registrants processed per tick (across all forms). Cap for safety. */
  maxPerTick?: number;
  /** Optional sleep (ms) between per-registrant writes. Smooths fork bursts on small containers. Default 100. */
  sleepBetweenWritesMs?: number;
}

export type IngestTickOutcome =
  | { ok: true; processed: number; created: number; appended: number; pendingReview: number; skipped: number; transientErrors: number; perFormCursors: Record<number, number> }
  | { ok: false; processed: number; created: number; appended: number; pendingReview: number; skipped: number; transientErrors: number; error: string; perFormCursors: Record<number, number> };

export async function runIngestTick(
  engine: BrainEngine,
  opts: IngestOptions,
): Promise<IngestTickOutcome> {
  const client = new RegfoxClient({
    apiKey: opts.apiKey,
    product: opts.product,
  });

  const formIds = opts.formIds && opts.formIds.length > 0 ? opts.formIds : [ALL_FORMS_CURSOR_KEY];
  const pageLimit = opts.pageLimit ?? 100;
  const burstFloor = opts.burstFloor ?? 10;
  const maxPerTick = opts.maxPerTick ?? 50;
  const sleepBetweenWritesMs = opts.sleepBetweenWritesMs ?? 100;

  let processed = 0;
  let created = 0;
  let appended = 0;
  let pendingReview = 0;
  let skipped = 0;
  let transientErrors = 0;
  const perFormCursors: Record<number, number> = {};
  let batchError: string | undefined;

  // Run the entire tick inside one repo-lock-batch: lock, pull, splice every
  // edit, single commit, single push, single Postgres re-sync. That collapses
  // 50 tick-internal git commits into 1 and removes the contention window
  // with the scheduled-pull cron.
  //
  // Within-batch dedup: if registrant A and B share an email, the email
  // lookup against Postgres for B won't see the page A just created (no
  // sync yet). We track newly-staged email→slug locally so the second one
  // appends instead of duplicating.
  const stagedEmailToSlug = new Map<string, string>();

  // Busy-retry around the batch lock acquisition — the scheduled-pull cron
  // and any human edit window can hold the lock for a few seconds. Bail
  // after BATCH_BUSY_RETRIES attempts so we don't tie up the tick forever.
  const BATCH_BUSY_RETRIES = 5;
  const BATCH_BUSY_BACKOFF_MS = 3000;
  let batchResult: Awaited<ReturnType<typeof withBatch<void>>> = { status: 'busy' };
  for (let attempt = 0; attempt < BATCH_BUSY_RETRIES; attempt++) {
    batchResult = await runOneBatchAttempt();
    if (batchResult.status !== 'busy') break;
    if (attempt < BATCH_BUSY_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, BATCH_BUSY_BACKOFF_MS));
    }
  }

  async function runOneBatchAttempt(): Promise<Awaited<ReturnType<typeof withBatch<void>>>> {
    // Reset per-attempt state — counts accumulate across the tick, but a
    // retry that finds the lock free starts the loop fresh.
    processed = 0; created = 0; appended = 0; pendingReview = 0; skipped = 0; transientErrors = 0;
    stagedEmailToSlug.clear();
    for (const k of Object.keys(perFormCursors)) delete perFormCursors[Number(k)];
    return withBatch(engine, async (batch): Promise<void> => {
    try {
      for (const formId of formIds) {
        const cursor = await readCursor(engine, formId);
        let lastSeenId = cursor.lastSeenId;
        let hasMore = true;
        let halted = false;
        while (hasMore && processed < maxPerTick && !halted) {
          const result = await client.fetchRegistrants({
            formId: formId === ALL_FORMS_CURSOR_KEY ? undefined : formId,
            greaterThanId: lastSeenId,
            limit: pageLimit,
            sort: 'asc',
          });

          if (result.rateLimit.burstRemaining != null && result.rateLimit.burstRemaining < burstFloor) {
            process.stderr.write(`[regfox-ingestor] burst-remaining ${result.rateLimit.burstRemaining} < floor ${burstFloor}; halting tick early\n`);
            break;
          }

          for (const registrant of result.registrants) {
            if (processed >= maxPerTick) break;
            processed++;
            let outcome: IngestOneOutcome;
            try {
              outcome = await ingestOneInBatch(batch, engine, registrant, stagedEmailToSlug, { discountFieldPath: opts.discountFieldPath });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              process.stderr.write(`[regfox-ingestor] exception on registrant id=${registrant.id}: ${msg}\n`);
              transientErrors++;
              halted = true;
              break;
            }
            if (outcome === 'transient_error') {
              transientErrors++;
              halted = true;
              break;
            }
            if (outcome === 'created') created++;
            else if (outcome === 'appended') appended++;
            else if (outcome === 'pending_review') pendingReview++;
            else skipped++;
            if (registrant.id > lastSeenId) lastSeenId = registrant.id;
            if (sleepBetweenWritesMs > 0 && processed < maxPerTick) {
              await new Promise((r) => setTimeout(r, sleepBetweenWritesMs));
            }
          }
          hasMore = result.hasMore && !halted;
        }
        perFormCursors[formId] = lastSeenId;
      }
      // Set the final commit message now that we have real counts.
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} created`);
      if (appended > 0) parts.push(`${appended} appended`);
      if (pendingReview > 0) parts.push(`${pendingReview} pending`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      const summary = parts.join(', ') || 'no-op';
      batch.setCommitMessage(
        `regfox-ingestor: ${processed} registrants (${summary})`,
        `cursors: ${Object.entries(perFormCursors).map(([f, id]) => `form=${f} → id=${id}`).join('; ')}`,
      );
    } catch (e) {
      batchError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  });
  }

  if (batchResult.status === 'busy') {
    return { ok: false, processed, created, appended, pendingReview, skipped, transientErrors, error: 'batch_busy', perFormCursors };
  }
  if (batchResult.status === 'error') {
    // Cursors NOT persisted — next tick replays the same registrants.
    return { ok: false, processed, created, appended, pendingReview, skipped, transientErrors, error: batchError ?? batchResult.error, perFormCursors };
  }

  // Commit + push succeeded. Persist cursors.
  for (const [formIdStr, lastSeenId] of Object.entries(perFormCursors)) {
    const formId = Number(formIdStr);
    await writeCursor(engine, formId, lastSeenId, transientErrors > 0 ? 'halted-on-transient' : 'ok').catch(() => { /* best effort */ });
  }
  return { ok: true, processed, created, appended, pendingReview, skipped, transientErrors, perFormCursors };
}

type IngestOneOutcome = 'appended' | 'created' | 'pending_review' | 'skipped' | 'transient_error';

/**
 * In-batch variant of ingestOne. Same dedup logic, but writes go through
 * the batch handle (no commit/push/sync per call). Tracks an
 * email→staged-slug map so two registrants in the same tick that share
 * an email merge instead of producing duplicate stubs.
 */
async function ingestOneInBatch(
  batch: BatchHandle,
  engine: BrainEngine,
  registrant: RegfoxRegistrant,
  stagedEmailToSlug: Map<string, string>,
  opts: TranslatorOptions = {},
): Promise<IngestOneOutcome> {
  const t = translateRegistrant(registrant, opts);

  if (t.email == null && t.fullName == null) {
    process.stderr.write(`[regfox-ingestor] skip registrant id=${registrant.id}: no email and no name\n`);
    return 'skipped';
  }

  // 1. Email match — DB first, then within-batch staged map.
  if (t.email) {
    const dbMatch = await findPageByEmail(engine, t.email);
    const stagedSlug = stagedEmailToSlug.get(t.email);
    const matchedSlug = dbMatch?.slug ?? stagedSlug;
    if (matchedSlug) {
      const r = batch.appendToPage({
        slug: matchedSlug,
        section: '## Timeline',
        content: t.bullet,
        commitNote: `regfox-ingestor: registrant ${registrant.id}`,
      });
      if (r.status === 'error') {
        process.stderr.write(`[regfox-ingestor] batch append to ${matchedSlug} failed: ${r.error}\n`);
        return 'transient_error';
      }
      stagedEmailToSlug.set(t.email, matchedSlug);
      return 'appended';
    }
  }

  // 2. Name match — slug existence check via filesystem (post-pull, post-stage).
  const proposedSlug = `entities/people/${t.proposedSlug}`;
  const existingByName = batch.readSlug(proposedSlug);
  if (existingByName != null) {
    // Pending-review row goes through the same batch.
    const idTag = `regfox-id:${registrant.id}`;
    const pendingSlug = '_ingest/pending_regfox';
    const existingPending = batch.readSlug(pendingSlug);
    if (existingPending && existingPending.includes(idTag)) {
      return 'pending_review';
    }
    const reason = `slug ${proposedSlug} already exists with a different / no email — could be the same person registering with a new email, or two different people with the same name. Human review.`;
    const line = `- [ ] ${idTag} — ${t.fullName ?? '(no name)'} <${t.email ?? '(no email)'}> — ${reason}`;
    const r = batch.appendToPage({ slug: pendingSlug, content: line });
    if (r.status === 'error') {
      process.stderr.write(`[regfox-ingestor] batch pending-write failed: ${r.error}\n`);
      return 'transient_error';
    }
    return 'pending_review';
  }

  // 3. Create new stub.
  const fullContent = serializeFrontmatter(t.stubFrontmatter) + '\n' + t.stubBody;
  const r = batch.replacePage({
    slug: proposedSlug,
    content: fullContent,
    commitNote: `regfox-ingestor: new entity from registrant ${registrant.id}`,
  });
  if (r.status === 'ok') {
    if (t.email) stagedEmailToSlug.set(t.email, proposedSlug);
    return 'created';
  }
  if (r.status === 'page_changed') {
    // Race: between our slug check and replace, another writer landed.
    // Fall back to append.
    const ar = batch.appendToPage({
      slug: proposedSlug,
      section: '## Timeline',
      content: t.bullet,
      commitNote: `regfox-ingestor: registrant ${registrant.id} (race-recovered)`,
    });
    if (ar.status === 'ok') {
      if (t.email) stagedEmailToSlug.set(t.email, proposedSlug);
      return 'appended';
    }
  }
  process.stderr.write(`[regfox-ingestor] failed to land registrant id=${registrant.id}: ${r.status === 'error' ? r.error : r.status}\n`);
  return 'transient_error';
}

/**
 * Ingest one registrant. Returns the outcome:
 *   - 'appended'        → matched by email, bullet appended to existing page
 *   - 'created'         → no match, new stub + bullet
 *   - 'pending_review'  → name-match-without-email-match, written to pending file
 *   - 'skipped'         → permanent no-op (no email AND no name) — cursor advances
 *   - 'transient_error' → write failed (fork limit, push reject after retry, etc.) —
 *                         caller halts the tick and the cursor does NOT advance past
 *                         this registrant, so the next tick retries it
 */
export async function ingestOne(
  engine: BrainEngine,
  registrant: RegfoxRegistrant,
  opts: TranslatorOptions = {},
): Promise<'appended' | 'created' | 'pending_review' | 'skipped' | 'transient_error'> {
  const t = translateRegistrant(registrant, opts);

  // Hard skip if we have neither email nor name — can't do anything safe.
  if (t.email == null && t.fullName == null) {
    process.stderr.write(`[regfox-ingestor] skip registrant id=${registrant.id}: no email and no name\n`);
    return 'skipped';
  }

  // 1. Email match.
  if (t.email) {
    const emailMatch = await findPageByEmail(engine, t.email);
    if (emailMatch) {
      const result = await appendWithBusyRetry(engine, {
        slug: emailMatch.slug,
        section: '## Timeline',
        content: t.bullet,
        commitNote: `regfox-ingestor: registrant ${registrant.id}`,
      });
      if (result.status === 'ok') return 'appended';
      const errMsg = result.status === 'error' ? result.error : `status=${result.status}`;
      process.stderr.write(`[regfox-ingestor] append to ${emailMatch.slug} failed: ${errMsg}\n`);
      return 'transient_error';
    }
  }

  // 2. Name match (slug exists at the proposed slug). Ambiguous — pending review.
  const proposedSlug = `entities/people/${t.proposedSlug}`;
  const existingByName = await engine.getPage(proposedSlug);
  if (existingByName != null) {
    // The slug exists, but we got here because no email match took us in case 1.
    // Could be: same person registered with new email, OR two different people
    // with same kebab-cased name. Defer to human review.
    await writePendingReview(engine, t, registrant, `slug ${proposedSlug} already exists with a different / no email — could be the same person registering with a new email, or two different people with the same name. Human review.`);
    return 'pending_review';
  }

  // 3. No match — create new stub with the timeline bullet baked in.
  const fullContent = serializeFrontmatter(t.stubFrontmatter) + '\n' + t.stubBody;
  const result = await replaceWithBusyRetry(engine, {
    slug: proposedSlug,
    content: fullContent,
    commitNote: `regfox-ingestor: new entity from registrant ${registrant.id}`,
  });
  if (result.status === 'ok') return 'created';

  // Fallback: if the create failed somehow (race with another writer creating
  // the same slug between our get_page check and replacePage), re-check and
  // try to append.
  if (result.status === 'page_changed') {
    const append = await appendWithBusyRetry(engine, {
      slug: proposedSlug,
      section: '## Timeline',
      content: t.bullet,
      commitNote: `regfox-ingestor: registrant ${registrant.id} (race-recovered)`,
    });
    if (append.status === 'ok') return 'appended';
  }
  const errMsg = result.status === 'error' ? result.error : `status=${result.status}`;
  process.stderr.write(`[regfox-ingestor] failed to land registrant id=${registrant.id}: ${errMsg}\n`);
  return 'transient_error';
}

/**
 * Wrappers that retry on the markdown-writer's `busy` status (lock held
 * by another writer — typically the scheduled-pull cron when its tick
 * collides with the regfox cron tick). Up to 5 attempts with 2s linear
 * backoff. Other statuses pass through unchanged.
 */
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BACKOFF_MS = 2000;

async function appendWithBusyRetry(
  engine: BrainEngine,
  args: Parameters<typeof appendToPage>[1],
): Promise<Awaited<ReturnType<typeof appendToPage>>> {
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
    const result = await appendToPage(engine, args);
    if (result.status !== 'busy') return result;
    if (attempt === BUSY_RETRY_ATTEMPTS - 1) return result;
    await new Promise((r) => setTimeout(r, BUSY_RETRY_BACKOFF_MS));
  }
  // unreachable
  return appendToPage(engine, args);
}

async function replaceWithBusyRetry(
  engine: BrainEngine,
  args: Parameters<typeof replacePage>[1],
): Promise<Awaited<ReturnType<typeof replacePage>>> {
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
    const result = await replacePage(engine, args);
    if (result.status !== 'busy') return result;
    if (attempt === BUSY_RETRY_ATTEMPTS - 1) return result;
    await new Promise((r) => setTimeout(r, BUSY_RETRY_BACKOFF_MS));
  }
  return replacePage(engine, args);
}

interface EmailMatch {
  slug: string;
}

async function findPageByEmail(engine: BrainEngine, email: string): Promise<EmailMatch | null> {
  // Postgres JSONB lookup against the page's frontmatter. Two shapes supported:
  //   1. `email: <string>`           — single primary email (most pages).
  //   2. `emails: [<a>, <b>, ...]`   — array of all addresses for people with
  //                                    multiple emails (Jason added these
  //                                    during the manual backfill).
  // Both are checked, lowercased for case-insensitive comparison since
  // translator.normalizeEmail also lowercases. If multiple pages share an
  // email (data error), pick the most recently updated.
  //
  // Why not just `emails:`-everywhere: the single-string `email:` is what
  // most pages have today + matches the canonical CRM convention of "primary
  // email is THE email." `emails:` is an additive list that exists only for
  // people who actually have multiple. Pages without `emails:` skip the
  // array check via the jsonb_typeof guard.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
       WHERE LOWER(frontmatter->>'email') = $1
          OR (
            jsonb_typeof(frontmatter->'emails') = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(frontmatter->'emails') AS e
              WHERE LOWER(e) = $1
            )
          )
       ORDER BY updated_at DESC
       LIMIT 1`,
    [email],
  );
  if (rows.length === 0) return null;
  return { slug: rows[0].slug };
}

function serializeFrontmatter(fm: Record<string, string | number | boolean>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') {
      // Quote if it contains a colon, leading/trailing whitespace, or starts with a YAML special char.
      const needsQuote = /[:#\n]/.test(v) || /^\s|\s$/.test(v) || /^[!&*?{}|>'"%@`]/.test(v);
      lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

async function writePendingReview(
  engine: BrainEngine,
  t: TranslatedRegistrant,
  registrant: RegfoxRegistrant,
  reason: string,
): Promise<void> {
  // Append a checklist line to <data-repo>/_ingest/pending_regfox.md via the
  // markdown-writer infrastructure — gets locking + git commit + push for
  // free, same way agent writes do.
  //
  // Idempotency: pre-check the existing page (via Postgres index, refreshed
  // every time the page is written via performSync inside appendToPage) for
  // the registrant's ID tag. If already listed, skip silently. The id tag
  // is unique per registrant.
  const idTag = `regfox-id:${registrant.id}`;
  const slug = '_ingest/pending_regfox';
  const existing = await engine.getPage(slug);
  if (existing && (existing.compiled_truth ?? '').includes(idTag)) {
    return;
  }
  const line = `- [ ] ${idTag} — ${t.fullName ?? '(no name)'} <${t.email ?? '(no email)'}> — ${reason}`;
  await appendToPage(engine, {
    slug,
    content: line,
    commitNote: `regfox-ingestor: pending review for registrant ${registrant.id}`,
  });
}

// Re-export kebabize for tests.
export { kebabize };
