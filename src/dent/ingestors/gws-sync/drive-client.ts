/**
 * Drive + Sheets REST client for gws-sync. Self-contained (no dependency on
 * the tools/ tree) but mirrors the OAuth-refresh shape of
 * tools/email-sync/google-client.ts: a long-lived refresh token mints
 * short-lived access tokens, refreshed in-process on demand.
 *
 * Metadata-only by construction:
 *   - Drive calls use the `drive.metadata.readonly` scope, which CANNOT read
 *     file content — the no-body invariant is enforced at the OAuth scope.
 *   - Sheets is different: `spreadsheets.readonly` is the narrowest scope and it
 *     CAN read cell values, so there is no scope-level guarantee for sheets. The
 *     no-cell-values invariant is enforced by `getSpreadsheetSchema` requesting a
 *     `fields` mask of only `sheets.properties(...)` with `includeGridData=false`.
 *     Keep that mask narrow — widening it would exfiltrate cell data into cards.
 *
 * Runs server-side (in serve.ts), so the access token is cached in memory
 * across ticks; a cold start re-mints from the refresh token.
 */

import {
  MIME_DOC,
  MIME_SHEET,
  type DriveFile,
  type DriveChange,
  type FolderNode,
  type SheetSchema,
} from './types.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Minimal Drive `files` field mask we depend on. */
const FILE_FIELDS =
  'id,name,mimeType,parents,owners(emailAddress,displayName),modifiedTime,webViewLink,driveId,trashed';

/** Hard runaway cap on total pages walked in one call. */
const MAX_PAGES = 200;

export interface DriveClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

export class DriveClientError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = 'DriveClientError';
  }
}

export class DriveClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private fetchImpl: typeof fetch;

  constructor(private opts: DriveClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * List every untrashed Doc + Sheet the authenticated user can see, across My
   * Drive and all shared drives. Paginated; folder metadata is fetched
   * separately (see getFolder) for path resolution.
   */
  async listAllDocsAndSheets(): Promise<DriveFile[]> {
    const q = `(mimeType='${MIME_DOC}' or mimeType='${MIME_SHEET}') and trashed=false`;
    const all: DriveFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${DRIVE_BASE}/files`);
      url.searchParams.set('q', q);
      url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('corpora', 'allDrives');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('orderBy', 'modifiedTime desc');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const json = await this.getJson<{ files?: DriveFile[]; nextPageToken?: string }>(url.toString());
      if (Array.isArray(json.files)) all.push(...json.files);
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    // No-silent-caps: if we exhausted MAX_PAGES with a token still pending, the
    // corpus is larger than the cap and the result is PARTIAL. Announce it so a
    // truncated seed isn't mistaken for a complete one.
    if (pageToken) {
      console.error(`[gws-sync] WARN: listAllDocsAndSheets hit MAX_PAGES (${MAX_PAGES}) cap with more pages pending — result is partial (${all.length} files).`);
    }
    return all;
  }

  /** Seed a changes cursor covering the user's whole corpus. */
  async getStartPageToken(): Promise<string> {
    const url = new URL(`${DRIVE_BASE}/changes/startPageToken`);
    url.searchParams.set('supportsAllDrives', 'true');
    const json = await this.getJson<{ startPageToken: string }>(url.toString());
    return json.startPageToken;
  }

  /**
   * Drain the changes feed from `pageToken`. Returns every change plus the next
   * start token to persist. Includes removed + trashed so we can tombstone.
   */
  async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
    const changes: DriveChange[] = [];
    let token: string | undefined = pageToken;
    let newStartPageToken = pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${DRIVE_BASE}/changes`);
      url.searchParams.set('pageToken', token!);
      url.searchParams.set('fields', `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('includeRemoved', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      url.searchParams.set('supportsAllDrives', 'true');
      const json = await this.getJson<{
        changes?: DriveChange[];
        nextPageToken?: string;
        newStartPageToken?: string;
      }>(url.toString());
      if (Array.isArray(json.changes)) changes.push(...json.changes);
      if (json.newStartPageToken) newStartPageToken = json.newStartPageToken;
      if (json.nextPageToken) {
        token = json.nextPageToken;
        if (page === MAX_PAGES - 1) {
          // About to exit on the loop bound with pages still pending. Drive only
          // returns newStartPageToken on the final page, so a truncated batch
          // banks the original start token and re-reads from here next tick
          // (idempotent upserts). Log it so an unusually large backlog is visible.
          console.error(`[gws-sync] WARN: listChanges hit MAX_PAGES (${MAX_PAGES}) cap; ${changes.length} changes processed, batch re-reads next tick.`);
        }
      } else {
        break;
      }
    }
    return { changes, newStartPageToken };
  }

  /** Fetch a folder node (name + parents) for path resolution. */
  async getFolder(id: string): Promise<FolderNode> {
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(id)}`);
    url.searchParams.set('fields', 'id,name,parents');
    url.searchParams.set('supportsAllDrives', 'true');
    const json = await this.getJson<FolderNode>(url.toString());
    return { id: json.id, name: json.name, parents: json.parents };
  }

  /**
   * Structural sheet schema: tab titles + grid dimensions. Requests NO ranges
   * and NO includeGridData, so the response carries zero cell values.
   */
  async getSpreadsheetSchema(id: string): Promise<SheetSchema> {
    const url = new URL(`${SHEETS_BASE}/${encodeURIComponent(id)}`);
    url.searchParams.set('fields', 'sheets.properties(title,gridProperties(rowCount,columnCount))');
    url.searchParams.set('includeGridData', 'false');
    const json = await this.getJson<{
      sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
    }>(url.toString());
    const tabs: string[] = [];
    const dimensions: SheetSchema['dimensions'] = {};
    for (const s of json.sheets ?? []) {
      const title = s.properties?.title;
      if (!title) continue;
      tabs.push(title);
      dimensions[title] = {
        rows: s.properties?.gridProperties?.rowCount ?? 0,
        cols: s.properties?.gridProperties?.columnCount ?? 0,
      };
    }
    return { tabs, dimensions };
  }

  // --- internal ---

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.authedFetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new DriveClientError(res.status, body, `Drive/Sheets GET failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  private async authedFetch(url: string): Promise<Response> {
    const token = await this.getAccessToken();
    return this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  }

  private async getAccessToken(): Promise<string> {
    // 60s buffer so a token about to expire mid-request is refreshed first.
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.opts.refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new DriveClientError(res.status, errBody, `Token refresh failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}
