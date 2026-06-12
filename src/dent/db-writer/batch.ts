/**
 * Batched DB-direct writes (Stage A of the single-Postgres-brain conversion).
 *
 * Mirrors markdown-writer/batch.ts's BatchHandle interface, DB-backed: one
 * advisory lock (`dent-db-batch`) covers the whole tick instead of the git
 * repo lock, and every append/replace lands via `importFromContent`
 * immediately (there is no staging area — each call is a committed DB write,
 * so `readSlug` inside the same batch sees earlier writes, matching the old
 * "staged file on disk" visibility).
 *
 * Differences from the git batch, by construction:
 *   - Methods are async (each one round-trips the DB).
 *   - A callback throw does NOT roll back earlier writes (no `git reset`
 *     equivalent). Callers were already idempotent on source-refs, so a
 *     partial batch replays safely on the next tick.
 *   - `setCommitMessage` is a no-op recorded into the outcome summary.
 *   - `commits: 0` / `pushed: false` always — kept in the outcome shape for
 *     caller compat.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { importFromContent } from '../../core/import-file.ts';
import { tryAcquireDbLock } from '../../core/db-lock.ts';
import {
  DENT_SOURCE_ID,
  MAX_PAGE_BYTES,
  readPageMarkdown,
  validateSlug,
  loadActivePackBestEffort,
  type ActivePackLite,
} from './page-io.ts';
import { spliceFragment, bootstrapBody, type AppendArgs } from './append.ts';
import type { ReplaceArgs } from './replace.ts';

export interface DbBatchHandle {
  /** Splice + import. Returns ok/error only. */
  appendToPage(args: AppendArgs): Promise<BatchAppendResult>;
  /** Full write + import. Honors expected_prior_hash. */
  replacePage(args: ReplaceArgs): Promise<BatchReplaceResult>;
  /** Read the current canonical markdown of a slug (sees writes made earlier
   *  in the same batch). Returns null if the page does not exist. */
  readSlug(slug: string): Promise<string | null>;
  /** No-op (no git commit anymore). The last call's title/note is recorded
   *  into the batch outcome as `commit_message` for log/audit parity. */
  setCommitMessage(title: string, note?: string): void;
}

export type BatchAppendResult =
  | { status: 'ok'; file_path: string; section_created: boolean; staged: boolean }
  | { status: 'error'; error: string };

export type BatchReplaceResult =
  | { status: 'ok'; file_path: string; created: boolean; staged: boolean }
  | { status: 'page_changed'; current_content: string; current_hash: string }
  | { status: 'error'; error: string };

export type BatchOutcome<T> =
  | { status: 'ok'; result: T; staged_files: number; commits: 0; pushed: false; commit_message?: string }
  | { status: 'busy' }
  | { status: 'error'; error: string; result?: T };

export interface BatchOptions {
  /** Kept for caller compat; recorded into the outcome's commit_message. */
  commitTitle?: string;
  commitNote?: string;
}

const DB_BATCH_LOCK_ID = 'dent-db-batch';

export async function withDbBatch<T>(
  engine: BrainEngine,
  fn: (batch: DbBatchHandle) => Promise<T>,
  opts: BatchOptions = {},
): Promise<BatchOutcome<T>> {
  const lock = await tryAcquireDbLock(engine, DB_BATCH_LOCK_ID);
  if (!lock) return { status: 'busy' };

  try {
    // Load the schema pack once per batch, never per write (codex perf #7).
    const activePack: ActivePackLite | undefined = await loadActivePackBestEffort();

    const touchedSlugs = new Set<string>();
    let dynamicTitle: string | undefined;
    let dynamicNote: string | undefined;

    const writePage = async (slug: string, body: string): Promise<string | null> => {
      const imported = await importFromContent(engine, slug, body, {
        sourceId: DENT_SOURCE_ID,
        noEmbed: true,
        activePack,
      });
      return imported.status === 'error' ? (imported.error ?? 'import failed') : null;
    };

    const batch: DbBatchHandle = {
      async appendToPage(args: AppendArgs): Promise<BatchAppendResult> {
        if (!args.content || args.content.trim().length === 0) {
          return { status: 'error', error: 'content is empty' };
        }
        try {
          validateSlug(args.slug);
        } catch (e) {
          return { status: 'error', error: e instanceof Error ? e.message : String(e) };
        }
        const prior = await readPageMarkdown(engine, args.slug);
        const priorBody = prior?.markdown ?? bootstrapBody(args.slug);
        const spliced = spliceFragment(priorBody, args.content, args.section);
        if (spliced.body === priorBody) {
          return { status: 'ok', file_path: `${args.slug}.md`, section_created: false, staged: false };
        }
        if (Buffer.byteLength(spliced.body, 'utf-8') > MAX_PAGE_BYTES) {
          // Per-call error (not a thrown DentOperationError) so one oversized
          // page doesn't abort the rest of the batch — matches the old
          // per-call error semantics.
          return { status: 'error', error: `content_too_large: page would exceed ${MAX_PAGE_BYTES} bytes` };
        }
        const err = await writePage(args.slug, spliced.body);
        if (err) return { status: 'error', error: err };
        touchedSlugs.add(args.slug);
        return { status: 'ok', file_path: `${args.slug}.md`, section_created: spliced.sectionCreated, staged: true };
      },

      async replacePage(args: ReplaceArgs): Promise<BatchReplaceResult> {
        if (typeof args.content !== 'string' || args.content.length === 0) {
          return { status: 'error', error: 'content is empty' };
        }
        try {
          validateSlug(args.slug);
        } catch (e) {
          return { status: 'error', error: e instanceof Error ? e.message : String(e) };
        }
        if (Buffer.byteLength(args.content, 'utf-8') > MAX_PAGE_BYTES) {
          return { status: 'error', error: `content_too_large: page would exceed ${MAX_PAGE_BYTES} bytes` };
        }
        const current = await readPageMarkdown(engine, args.slug);
        if (current && args.expected_prior_hash && current.hash !== args.expected_prior_hash) {
          return { status: 'page_changed', current_content: current.markdown, current_hash: current.hash };
        }
        if (current && current.markdown === args.content) {
          return { status: 'ok', file_path: `${args.slug}.md`, created: false, staged: false };
        }
        const err = await writePage(args.slug, args.content);
        if (err) return { status: 'error', error: err };
        touchedSlugs.add(args.slug);
        return { status: 'ok', file_path: `${args.slug}.md`, created: current == null, staged: true };
      },

      async readSlug(slug: string): Promise<string | null> {
        try {
          validateSlug(slug);
        } catch {
          return null;
        }
        const page = await readPageMarkdown(engine, slug);
        return page?.markdown ?? null;
      },

      setCommitMessage(title: string, note?: string): void {
        dynamicTitle = title.length > 0 ? title : undefined;
        dynamicNote = note;
      },
    };

    let userResult: T;
    try {
      userResult = await fn(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', error: `batch callback threw: ${msg.slice(0, 300)}` };
    }

    const title = dynamicTitle ?? opts.commitTitle;
    const note = dynamicNote ?? opts.commitNote;
    const commitMessage = title ? (note ? `${title}\n\n${note}` : title) : undefined;
    return {
      status: 'ok',
      result: userResult,
      staged_files: touchedSlugs.size,
      commits: 0,
      pushed: false,
      ...(commitMessage !== undefined ? { commit_message: commitMessage } : {}),
    };
  } finally {
    await lock.release();
  }
}
