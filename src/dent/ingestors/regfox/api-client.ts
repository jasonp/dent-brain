/**
 * Webconnex API v2 client. Auth via `apiKey: <key>` header.
 *
 * Used by the RegFox ingestor's polling loop. Handles:
 *   - Cursor-based pagination via `greaterThanId` (cleaner than
 *     dateCreatedAfter — no clock-skew, monotonic, no equal-timestamp
 *     races).
 *   - Rate-limit awareness via X-Burst-Remaining / X-Daily-Remaining
 *     headers; callers can read the parsed values to back off when
 *     near the cap.
 *
 * The `fetch` impl is injectable so tests can supply a fixture without
 * hitting the network.
 */

import type { RegfoxApiResponse, RegfoxRegistrant, RegfoxRateLimitInfo } from './types.ts';

const DEFAULT_BASE_URL = 'https://api.webconnex.com/v2/public';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RegfoxClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Identifier for the Webconnex product. Default `regfox.com`. */
  product?: string;
  fetch?: FetchLike;
}

export interface FetchRegistrantsOpts {
  /** Restrict to one form. Omit to poll all forms the API key can see. */
  formId?: number;
  /** Cursor: only return registrants with id > greaterThanId. */
  greaterThanId?: number;
  /** Page size, 1–250. Default 100. */
  limit?: number;
  /** Sort order. Default `asc` for cursor-based forward iteration. */
  sort?: 'asc' | 'desc';
}

export interface FetchRegistrantsResult {
  registrants: RegfoxRegistrant[];
  hasMore: boolean;
  rateLimit: RegfoxRateLimitInfo;
}

export class RegfoxApiError extends Error {
  constructor(
    public statusCode: number,
    public bodyText: string,
    public webconnexCode?: number,
  ) {
    super(`Webconnex API ${statusCode}: ${bodyText.slice(0, 300)}`);
    this.name = 'RegfoxApiError';
  }
}

export class RegfoxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly product: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: RegfoxClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new Error('RegfoxClient: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.product = opts.product ?? 'regfox.com';
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async fetchRegistrants(opts: FetchRegistrantsOpts = {}): Promise<FetchRegistrantsResult> {
    const params = new URLSearchParams();
    params.set('product', this.product);
    params.set('limit', String(opts.limit ?? 100));
    params.set('sort', opts.sort ?? 'asc');
    if (opts.formId !== undefined) params.set('formId', String(opts.formId));
    if (opts.greaterThanId !== undefined) params.set('greaterThanId', String(opts.greaterThanId));

    const url = `${this.baseUrl}/search/registrants?${params.toString()}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        apiKey: this.apiKey,
        Accept: 'application/json',
      },
    });

    const rateLimit = parseRateLimit(res);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let webconnexCode: number | undefined;
      try {
        const parsed = JSON.parse(text) as RegfoxApiResponse<unknown>;
        webconnexCode = parsed.error?.code;
      } catch { /* not JSON, ignore */ }
      throw new RegfoxApiError(res.status, text, webconnexCode);
    }

    const body = (await res.json()) as RegfoxApiResponse<RegfoxRegistrant>;
    return {
      registrants: body.data ?? [],
      hasMore: !!body.hasMore,
      rateLimit,
    };
  }
}

function parseRateLimit(res: Response): RegfoxRateLimitInfo {
  const num = (h: string): number | null => {
    const v = res.headers.get(h);
    if (v == null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    burstRemaining: num('X-Burst-Remaining'),
    dailyRemaining: num('X-Daily-Remaining'),
    burstReset: num('X-Burst-Limit-Reset'),
  };
}
