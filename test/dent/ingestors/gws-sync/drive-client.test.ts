/**
 * DriveClient tests with an injected fake fetch. No network, no credentials.
 * Covers token refresh + caching, pagination (files + changes), sheet schema
 * parsing (structural only), and error propagation.
 */

import { describe, test, expect } from 'bun:test';
import { DriveClient, DriveClientError } from '../../../../src/dent/ingestors/gws-sync/drive-client.ts';
import { MIME_DOC, MIME_SHEET } from '../../../../src/dent/ingestors/gws-sync/types.ts';

interface Route {
  match: (url: string) => boolean;
  body: unknown;
  status?: number;
}

function makeFetch(routes: Route[], counters: Record<string, number> = {}) {
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      counters.token = (counters.token ?? 0) + 1;
      return new Response(JSON.stringify({ access_token: `tok-${counters.token}`, expires_in: 3600 }), { status: 200 });
    }
    for (const r of routes) {
      if (r.match(url)) {
        counters.api = (counters.api ?? 0) + 1;
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

const opts = (fetchImpl: typeof fetch) => ({
  clientId: 'cid',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  fetchImpl,
});

describe('DriveClient auth', () => {
  test('refreshes once and caches the access token across calls', async () => {
    const counters: Record<string, number> = {};
    const fetchImpl = makeFetch(
      [{ match: (u) => u.includes('/drive/v3/files'), body: { files: [] } }],
      counters,
    );
    const c = new DriveClient(opts(fetchImpl));
    await c.listAllDocsAndSheets();
    await c.listAllDocsAndSheets();
    expect(counters.token).toBe(1); // cached, not re-minted
  });

  test('throws DriveClientError on non-ok', async () => {
    const fetchImpl = makeFetch([{ match: (u) => u.includes('/drive/v3/files'), body: { error: 'nope' }, status: 403 }]);
    const c = new DriveClient(opts(fetchImpl));
    await expect(c.listAllDocsAndSheets()).rejects.toBeInstanceOf(DriveClientError);
  });

  test('throws DriveClientError when the token endpoint rejects (bad refresh token)', async () => {
    const fetchImpl = (async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = new DriveClient(opts(fetchImpl));
    await expect(c.listAllDocsAndSheets()).rejects.toBeInstanceOf(DriveClientError);
  });

  test('re-mints the access token after expiry (expires_in:0)', async () => {
    let tokenCalls = 0;
    const fetchImpl = (async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('oauth2')) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new DriveClient(opts(fetchImpl));
    await c.listAllDocsAndSheets();
    await c.listAllDocsAndSheets();
    expect(tokenCalls).toBe(2); // expired immediately → re-minted on the 2nd call
  });
});

describe('listAllDocsAndSheets', () => {
  test('paginates and aggregates', async () => {
    let call = 0;
    const fetchImpl = (async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ files: [{ id: 'a', name: 'A', mimeType: MIME_DOC }], nextPageToken: 'p2' }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [{ id: 'b', name: 'B', mimeType: MIME_SHEET }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new DriveClient(opts(fetchImpl));
    const files = await c.listAllDocsAndSheets();
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('listChanges', () => {
  test('drains pages and returns the final newStartPageToken', async () => {
    let call = 0;
    const fetchImpl = (async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ changes: [{ fileId: 'a', file: { id: 'a', name: 'A', mimeType: MIME_DOC } }], nextPageToken: 'n2' }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [{ fileId: 'b', removed: true }], newStartPageToken: 'FINAL' }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new DriveClient(opts(fetchImpl));
    const { changes, newStartPageToken } = await c.listChanges('start');
    expect(changes.length).toBe(2);
    expect(newStartPageToken).toBe('FINAL');
  });
});

describe('getSpreadsheetSchema', () => {
  test('parses tabs + dimensions, no cell values requested', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          sheets: [
            { properties: { title: 'Summary', gridProperties: { rowCount: 120, columnCount: 8 } } },
            { properties: { title: 'Pipeline', gridProperties: { rowCount: 50, columnCount: 4 } } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const c = new DriveClient(opts(fetchImpl));
    const schema = await c.getSpreadsheetSchema('sheet1');
    expect(schema.tabs).toEqual(['Summary', 'Pipeline']);
    expect(schema.dimensions.Summary).toEqual({ rows: 120, cols: 8 });
    // no grid data — the field mask never asks for values
    expect(requestedUrl).toContain('includeGridData=false');
    expect(requestedUrl).not.toContain('ranges');
  });
});

describe('getFolder', () => {
  test('returns id/name/parents', async () => {
    const fetchImpl = makeFetch([
      { match: (u) => u.includes('/drive/v3/files/'), body: { id: 'f1', name: 'Strategy', parents: ['root'] } },
    ]);
    const c = new DriveClient(opts(fetchImpl));
    const node = await c.getFolder('f1');
    expect(node).toEqual({ id: 'f1', name: 'Strategy', parents: ['root'] });
  });
});
