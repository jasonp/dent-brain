/**
 * Historical Mailchimp CSV bootstrap.
 *
 * One-shot importer that reads N Mailchimp audience export CSVs and lands
 * each member as Timeline bullets via the same markdown-writer batch path
 * the live cron will use. Idempotent on `[Source: mailchimp/<EUID>]`.
 *
 * Per member dedup flow (mirrors regfox):
 *   1. Email match → confident merge to that entity. Append the bullets
 *      (skipping any whose source-ref is already on the page).
 *   2. No email match, but slug-from-name already exists → AMBIGUOUS.
 *      Write a row to `_ingest/pending_mailchimp.md` for human review.
 *   3. No match → create new stub via batch.replacePage, then bullets are
 *      already baked into the stub body.
 *
 * Member dedup across the run: a single email can appear in subscribed AND
 * unsubscribed exports if the person re-subscribed and then unsubscribed
 * again. We process every member; idempotency on `[Source: mailchimp/<EUID>]`
 * means re-runs are safe but distinct EUIDs for the same email both land
 * (correctly — they represent two separate engagement events).
 */

import type { BrainEngine } from '../../../core/engine.ts';
import { withBatch, type BatchHandle } from '../../markdown-writer/batch.ts';
import { translateMember, MAILCHIMP_STUB_DIR, type TranslatorOptions } from './translator.ts';
import { readMailchimpCsv } from './csv-parser.ts';
import type { MailchimpMember } from './types.ts';

export interface BootstrapOptions extends TranslatorOptions {
  /** Absolute paths to Mailchimp CSV exports. The status (subscribed /
   *  unsubscribed / cleaned / nonsubscribed) is inferred from each filename. */
  csvPaths: string[];
  /** Max members to process. Used for canary runs. Default: no limit. */
  limit?: number;
  /** Plan only — no writes. Default false. */
  dryRun?: boolean;
}

export interface BootstrapOutcome {
  ok: boolean;
  /** Total members read from disk after dropped-row filtering. */
  read: number;
  /** Members translated and dispatched (regardless of outcome). */
  processed: number;
  /** Members whose bullets were appended to an existing entity by email. */
  appended: number;
  /** Members for whom we created a new stub. */
  created: number;
  /** Members deferred to `_ingest/pending_mailchimp.md` for human review. */
  pendingReview: number;
  /** Members skipped because their source-ref was already on the page (re-run). */
  skippedDuplicate: number;
  /** Members skipped because they had no email + no name (shouldn't happen
   *  given the parser already requires email+EUID, but defensive). */
  skippedUnusable: number;
  /** Pages that received at least one append/create in this run. */
  pagesTouched: number;
  error?: string;
}

export async function runMailchimpBootstrap(
  engine: BrainEngine,
  opts: BootstrapOptions,
): Promise<BootstrapOutcome> {
  const allMembers: MailchimpMember[] = [];
  for (const path of opts.csvPaths) {
    const r = readMailchimpCsv(path);
    process.stderr.write(
      `[mailchimp-bootstrap] ${r.sourceFile}: ${r.members.length} members, ${r.dropped} dropped\n`,
    );
    allMembers.push(...r.members);
  }
  const limit = opts.limit ?? Infinity;

  if (opts.dryRun) {
    return summarizeDryRun(allMembers, limit);
  }

  let read = allMembers.length;
  let processed = 0;
  let appended = 0;
  let created = 0;
  let pendingReview = 0;
  let skippedDuplicate = 0;
  let skippedUnusable = 0;
  const pagesTouched = new Set<string>();

  // Within-batch dedup: a single email appearing twice in the same run
  // (e.g. once in subscribed.csv, once in unsubscribed.csv) needs to land
  // both bullets on the same page. The first member that lands sets the
  // staged slug; subsequent members for the same email append to it.
  const stagedEmailToSlug = new Map<string, string>();

  let batchError: string | undefined;
  const batchResult = await withBatch(engine, async (batch): Promise<void> => {
    try {
      for (const m of allMembers) {
        if (processed >= limit) break;
        processed++;
        const outcome = await ingestOneInBatch(batch, engine, m, stagedEmailToSlug, opts);
        if (outcome.kind === 'appended') {
          appended++;
          pagesTouched.add(outcome.slug);
        } else if (outcome.kind === 'created') {
          created++;
          pagesTouched.add(outcome.slug);
        } else if (outcome.kind === 'pending_review') {
          pendingReview++;
        } else if (outcome.kind === 'skipped_duplicate') {
          skippedDuplicate++;
        } else if (outcome.kind === 'skipped_unusable') {
          skippedUnusable++;
        }
      }
      const summaryParts: string[] = [];
      if (created > 0) summaryParts.push(`${created} created`);
      if (appended > 0) summaryParts.push(`${appended} appended`);
      if (pendingReview > 0) summaryParts.push(`${pendingReview} pending`);
      if (skippedDuplicate > 0) summaryParts.push(`${skippedDuplicate} dup-skipped`);
      const summary = summaryParts.join(', ') || 'no-op';
      batch.setCommitMessage(
        `mailchimp-bootstrap: ${processed} members (${summary})`,
        `csvs: ${opts.csvPaths.map((p) => p.split('/').pop()).join(', ')}`,
      );
    } catch (e) {
      batchError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  });

  if (batchResult.status === 'busy') {
    return {
      ok: false, read, processed, appended, created, pendingReview, skippedDuplicate, skippedUnusable,
      pagesTouched: pagesTouched.size, error: 'batch_busy',
    };
  }
  if (batchResult.status === 'error') {
    return {
      ok: false, read, processed, appended, created, pendingReview, skippedDuplicate, skippedUnusable,
      pagesTouched: pagesTouched.size, error: batchError ?? batchResult.error,
    };
  }

  return {
    ok: true, read, processed, appended, created, pendingReview, skippedDuplicate, skippedUnusable,
    pagesTouched: pagesTouched.size,
  };
}

type IngestOutcome =
  | { kind: 'appended'; slug: string }
  | { kind: 'created'; slug: string }
  | { kind: 'pending_review' }
  | { kind: 'skipped_duplicate' }
  | { kind: 'skipped_unusable' };

async function ingestOneInBatch(
  batch: BatchHandle,
  engine: BrainEngine,
  m: MailchimpMember,
  stagedEmailToSlug: Map<string, string>,
  opts: TranslatorOptions,
): Promise<IngestOutcome> {
  const t = translateMember(m, opts);

  if (!t.email && !t.fullName) return { kind: 'skipped_unusable' };

  // 1. Email match — Postgres first, then within-batch staged map.
  const dbMatch = await findPageByEmail(engine, t.email);
  const stagedSlug = stagedEmailToSlug.get(t.email);
  const matchedSlug = dbMatch?.slug ?? stagedSlug;

  if (matchedSlug) {
    const existing = batch.readSlug(matchedSlug) ?? '';
    const refs = bulletsNotYetOnPage(existing, t.bullets, t.sourceRef);
    if (refs.length === 0) {
      stagedEmailToSlug.set(t.email, matchedSlug);
      return { kind: 'skipped_duplicate' };
    }
    const r = batch.appendToPage({
      slug: matchedSlug,
      section: '## Timeline',
      content: refs.join('\n'),
      commitNote: `mailchimp-bootstrap: euid ${m.euid}`,
    });
    if (r.status === 'error') {
      process.stderr.write(`[mailchimp-bootstrap] append to ${matchedSlug} failed: ${r.error}\n`);
      return { kind: 'pending_review' };
    }
    stagedEmailToSlug.set(t.email, matchedSlug);
    return { kind: 'appended', slug: matchedSlug };
  }

  // 2. Name match — slug exists at the proposed slug-path in EITHER
  //    entities/people/ (the attendee directory) or entities/audience/
  //    (the email-only directory). Either is ambiguous — could be the
  //    same person with a new email, or two different people with the
  //    same name. Defer to human review.
  const peopleSlug = `entities/people/${t.proposedSlug}`;
  const audienceSlug = `${MAILCHIMP_STUB_DIR}/${t.proposedSlug}`;
  const collidedSlug =
    batch.readSlug(peopleSlug) != null ? peopleSlug
    : batch.readSlug(audienceSlug) != null ? audienceSlug
    : null;
  if (collidedSlug != null) {
    const idTag = `mailchimp-euid:${m.euid}`;
    const pendingSlug = '_ingest/pending_mailchimp';
    const existingPending = batch.readSlug(pendingSlug) ?? '';
    if (existingPending.includes(idTag)) return { kind: 'pending_review' };
    const reason = `slug ${collidedSlug} already exists with a different / no email — could be the same person with a new email, or two different people with the same name. Human review.`;
    const line = `- [ ] ${idTag} — ${t.fullName ?? '(no name)'} <${t.email}> — ${reason}`;
    const r = batch.appendToPage({ slug: pendingSlug, content: line });
    if (r.status === 'error') {
      process.stderr.write(`[mailchimp-bootstrap] pending-write failed: ${r.error}\n`);
    }
    return { kind: 'pending_review' };
  }

  // 3. New stub — always goes to entities/audience/ since by definition
  //    we only get here when no email match (no engagement signal) and
  //    no name collision. The page can be promoted to entities/people/
  //    later if/when the person registers for an event.
  const proposedSlug = audienceSlug;
  const fullContent = serializeFrontmatter(t.stubFrontmatter) + '\n' + t.stubBody;
  const r = batch.replacePage({
    slug: proposedSlug,
    content: fullContent,
    commitNote: `mailchimp-bootstrap: new entity from euid ${m.euid}`,
  });
  if (r.status === 'ok') {
    stagedEmailToSlug.set(t.email, proposedSlug);
    return { kind: 'created', slug: proposedSlug };
  }
  if (r.status === 'page_changed') {
    // Race against another writer in the same batch — unlikely with one
    // bootstrap caller, but possible if the regfox cron is alive. Fall
    // back to append against the existing page.
    const ar = batch.appendToPage({
      slug: proposedSlug,
      section: '## Timeline',
      content: t.bullets.join('\n'),
      commitNote: `mailchimp-bootstrap: euid ${m.euid} (race-recovered)`,
    });
    if (ar.status === 'ok') {
      stagedEmailToSlug.set(t.email, proposedSlug);
      return { kind: 'appended', slug: proposedSlug };
    }
  }
  process.stderr.write(`[mailchimp-bootstrap] failed to land euid ${m.euid}: ${r.status === 'error' ? r.error : r.status}\n`);
  return { kind: 'pending_review' };
}

/** Filter the member's bullets against what's already on the page so a
 *  re-run doesn't double-write. The source-ref appears in every bullet,
 *  so a single substring check is sufficient. */
function bulletsNotYetOnPage(existing: string, bullets: string[], sourceRef: string): string[] {
  if (!existing.includes(`[Source: ${sourceRef}]`)) return bullets;
  // Some bullets (e.g. status) might already be on the page from a prior
  // run while others (e.g. tags after a campaign refresh) are new. Cheap
  // line-level dedup is sufficient given the bullet text is deterministic.
  return bullets.filter((b) => !existing.includes(b));
}

interface EmailMatch {
  slug: string;
}

async function findPageByEmail(engine: BrainEngine, email: string): Promise<EmailMatch | null> {
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
      const needsQuote = /[:#\n]/.test(v) || /^\s|\s$/.test(v) || /^[!&*?{}|>'"%@`]/.test(v);
      lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function summarizeDryRun(members: MailchimpMember[], limit: number): BootstrapOutcome {
  const sample = members.slice(0, Math.min(limit, members.length));
  return {
    ok: true,
    read: members.length,
    processed: sample.length,
    appended: 0,
    created: 0,
    pendingReview: 0,
    skippedDuplicate: 0,
    skippedUnusable: 0,
    pagesTouched: 0,
  };
}
