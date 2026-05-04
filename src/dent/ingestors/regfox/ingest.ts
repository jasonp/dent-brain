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
import { replacePage, hashContent } from '../../markdown-writer/replace.ts';
import { getRepoContext } from '../../markdown-writer/repo.ts';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
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
          let outcome: 'appended' | 'created' | 'pending_review' | 'skipped' | 'transient_error';
          try {
            outcome = await ingestOne(engine, registrant, { discountFieldPath: opts.discountFieldPath });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[regfox-ingestor] exception on registrant id=${registrant.id}: ${msg}\n`);
            transientErrors++;
            // Halt the tick — cursor stays at the previous successful registrant
            // so the next tick retries this one.
            halted = true;
            break;
          }
          if (outcome === 'transient_error') {
            transientErrors++;
            // Halt — same logic as exception. Cursor does NOT advance past this registrant.
            halted = true;
            break;
          }
          if (outcome === 'created') created++;
          else if (outcome === 'appended') appended++;
          else if (outcome === 'pending_review') pendingReview++;
          else skipped++;
          // Only advance cursor on successful (or deliberately-skipped) outcomes.
          if (registrant.id > lastSeenId) lastSeenId = registrant.id;
          if (sleepBetweenWritesMs > 0 && processed < maxPerTick) {
            await new Promise((r) => setTimeout(r, sleepBetweenWritesMs));
          }
        }
        hasMore = result.hasMore && !halted;
      }
      perFormCursors[formId] = lastSeenId;
      await writeCursor(engine, formId, lastSeenId, halted ? 'halted-on-transient' : 'ok');
    }
    return { ok: true, processed, created, appended, pendingReview, skipped, transientErrors, perFormCursors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Persist whatever cursors we did advance.
    for (const [formId, lastSeenId] of Object.entries(perFormCursors)) {
      await writeCursor(engine, Number(formId), lastSeenId, `error: ${msg.slice(0, 200)}`).catch(() => { /* best effort */ });
    }
    return { ok: false, processed, created, appended, pendingReview, skipped, transientErrors, error: msg, perFormCursors };
  }
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
      const result = await appendToPage(engine, {
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
    await writePendingReview(t, registrant, `slug ${proposedSlug} already exists with a different / no email — could be the same person registering with a new email, or two different people with the same name. Human review.`);
    return 'pending_review';
  }

  // 3. No match — create new stub with the timeline bullet baked in.
  const fullContent = serializeFrontmatter(t.stubFrontmatter) + '\n' + t.stubBody;
  const result = await replacePage(engine, {
    slug: proposedSlug,
    content: fullContent,
    commitNote: `regfox-ingestor: new entity from registrant ${registrant.id}`,
  });
  if (result.status === 'ok') return 'created';

  // Fallback: if the create failed somehow (race with another writer creating
  // the same slug between our get_page check and replacePage), re-check and
  // try to append.
  if (result.status === 'page_changed') {
    const append = await appendToPage(engine, {
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

interface EmailMatch {
  slug: string;
}

async function findPageByEmail(engine: BrainEngine, email: string): Promise<EmailMatch | null> {
  // Postgres JSONB lookup against `frontmatter->>'email'`. Lowercased for
  // case-insensitive comparison since translator.normalizeEmail also lowercases.
  // If multiple pages share the email (data error), pick the most recently updated.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
       WHERE LOWER(frontmatter->>'email') = $1
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
  t: TranslatedRegistrant,
  registrant: RegfoxRegistrant,
  reason: string,
): Promise<void> {
  // Write a checklist line to <data-repo>/_ingest/pending_regfox.md.
  // No git commit here — the next scheduled git pass picks it up. Idempotent
  // by content: if the same line already exists, we don't add a duplicate.
  const repo = getRepoContext();
  const filePath = join(repo.repoPath, '_ingest', 'pending_regfox.md');
  mkdirSync(dirname(filePath), { recursive: true });
  const headerLine = '# RegFox ingestor — pending human review\n\nEach unchecked line is a registrant the ingestor could not auto-place. Review and either:\n  - tick the box (and resolve manually: edit the right entity page, or create a new one), or\n  - delete the line.\n\nThe ingestor will skip already-listed registrants on subsequent ticks.\n\n---\n';
  const idTag = `regfox-id:${registrant.id}`;
  const line = `- [ ] ${idTag} — ${t.fullName ?? '(no name)'} <${t.email ?? '(no email)'}> — ${reason}`;

  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
    if (existing.includes(idTag)) return; // already listed
  } else {
    existing = headerLine;
  }
  const next = existing.endsWith('\n') ? existing + line + '\n' : existing + '\n' + line + '\n';
  writeFileSync(filePath, next, 'utf-8');
}

// Re-export kebabize for tests.
export { kebabize };
