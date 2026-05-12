/**
 * Granola public REST API client.
 *
 * Replaces the old cache-reading path (Granola encrypted the local cache as of
 * 2026-05). Auth is a per-user API key minted in the Granola desktop app at
 * Settings → Connectors → API keys, stored in the macOS keychain under service
 * `dent-brain.granola-sync` / account `$USER`.
 *
 * The API only returns notes that already have a generated summary AND
 * transcript, so the old 45-min "settle delay" is no longer needed — anything
 * the API hands back is fully processed.
 *
 * Rate limit: 5 req/s sustained, 25 req / 5s burst. We sleep ~220ms between
 * calls (≈4.5 req/s) and back off on 429.
 *
 * Surface (full spec at https://docs.granola.ai/api-reference/openapi.json):
 *   GET /v1/notes?created_after=&updated_after=&cursor=&page_size=
 *   GET /v1/notes/{not_…}?include=transcript
 *   GET /v1/folders?cursor=&page_size=
 */

import type { Note, NoteSummary, ListNotesOutput, ListFoldersOutput } from './types.ts';

const BASE_URL = 'https://public-api.granola.ai/v1';
const KEYCHAIN_SERVICE = 'dent-brain.granola-sync';
const MIN_INTERVAL_MS = 220;

export function keychainAccount(): string {
  return process.env.USER ?? process.env.LOGNAME ?? 'default';
}

/** Read the API key from the macOS keychain. Returns null if missing. */
export async function readKeyFromKeychain(): Promise<string | null> {
  const proc = Bun.spawn(
    ['/usr/bin/security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(), '-w'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const key = stdout.trim();
  return key.length > 0 ? key : null;
}

export class GranolaApi {
  private apiKey: string;
  private lastCallAt = 0;

  constructor(apiKey: string) {
    if (!apiKey || !apiKey.trim()) throw new Error('GranolaApi: empty API key');
    this.apiKey = apiKey.trim();
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async fetchJson<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    await this.throttle();
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
      return this.fetchJson<T>(path, init, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Granola API ${res.status} ${res.statusText} on GET ${path}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Validate the key by attempting a 1-item list. Throws on auth failure. */
  async validate(): Promise<void> {
    await this.fetchJson<ListNotesOutput>('/notes?page_size=1');
  }

  /**
   * List note summaries. Iterates pages internally; yields one note at a time
   * so the caller can stop early (e.g. hit `--limit`) without fetching all
   * pages. Use `createdAfter` to advance from the cursor.
   */
  async *iterNotes(opts: { createdAfter?: string; updatedAfter?: string; pageSize?: number } = {}): AsyncGenerator<NoteSummary> {
    const pageSize = opts.pageSize ?? 30;
    let cursor: string | null = null;
    let pageCount = 0;
    while (true) {
      const params = new URLSearchParams({ page_size: String(pageSize) });
      if (opts.createdAfter) params.set('created_after', opts.createdAfter);
      if (opts.updatedAfter) params.set('updated_after', opts.updatedAfter);
      if (cursor) params.set('cursor', cursor);
      const page = await this.fetchJson<ListNotesOutput>(`/notes?${params.toString()}`);
      pageCount++;
      for (const n of page.notes) yield n;
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
      // Hard guard against an API bug that loops forever.
      if (pageCount > 1000) throw new Error('Granola API: refused to fetch past 1000 pages of /notes');
    }
  }

  /** Fetch one note in full. Pass `includeTranscript: true` to get the diarized transcript. */
  async getNote(noteId: string, opts: { includeTranscript?: boolean } = {}): Promise<Note> {
    const q = opts.includeTranscript ? '?include=transcript' : '';
    return this.fetchJson<Note>(`/notes/${encodeURIComponent(noteId)}${q}`);
  }
}

export { KEYCHAIN_SERVICE };
