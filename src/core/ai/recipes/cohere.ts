import type { Recipe } from '../types.ts';

/**
 * Cohere Rerank — the managed replacement for ZeroEntropy's zerank-2 after
 * ZE's September 4th, 2026 sunset (ZE was acquired by Notion; their own
 * migration guide names Cohere `rerank-v3.5` as the self-serve swap).
 *
 * Reranker-only recipe. Cohere also ships Embed 4, but gbrain's embedding
 * default moved to OpenAI text-embedding-3-large in the same cut — adding a
 * second embedding provider here would be speculative surface with no caller.
 *
 * WIRE SHAPE — no adapter shim needed. Cohere v2 is a drop-in for the
 * existing `gateway.rerank()` HTTP path:
 *
 *   request   {model, query, documents: string[], top_n?}
 *   response  {results: [{index, relevance_score}]}
 *   auth      Authorization: Bearer <key>
 *
 * That matches what gateway.rerank() already builds and parses (it maps
 * `r.index` / `r.relevance_score` directly), which is why this recipe is
 * pure config. Verified against the v2 OpenAPI spec at
 * https://docs.cohere.com/reference/rerank — `index` and `relevance_score`
 * are both declared `required` on the results item schema.
 *
 * SCORE SCALE — this is the one behavioral difference from zerank-2, and it
 * matters. Cohere normalizes `relevance_score` to [0, 1], and the spec warns
 * the scale is NOT linear (a 0.9 is not "twice as relevant" as a 0.45). Any
 * absolute cutoff tuned against zerank-2's scores has to be re-tuned; see
 * the autocut/rerank-audit thresholds.
 *
 * COST — deliberately omitted. Cohere bills rerank per *search* (one query +
 * its documents), not per token, so there is no honest value for
 * `cost_per_1m_tokens_usd`. Publishing a converted guess would feed
 * budget-tracker a number that drifts with documents-per-query. The field is
 * optional; leaving it unset routes through the existing unknown-price
 * warn-once path rather than silently under-reporting spend.
 */
export const cohere: Recipe = {
  id: 'cohere',
  name: 'Cohere',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // Cohere's rerank lives under /v2 (not /v1). Combined with the leaf path
  // below this resolves to https://api.cohere.com/v2/rerank.
  base_url_default: 'https://api.cohere.com/v2',
  auth_env: {
    required: ['COHERE_API_KEY'],
    setup_url: 'https://dashboard.cohere.com/api-keys',
  },
  touchpoints: {
    reranker: {
      // Only model ids verified against Cohere's published docs are listed.
      // `rerank-v3.5` is the id given in the v2 request schema and the one
      // ZE's migration guide points at; `rerank-v4.0-pro` appears in the v2
      // docs code samples. Cohere's pricing page also advertises a "Rerank 4
      // Fast" tier whose exact API id we have not confirmed — left out
      // rather than guessed, since an unlisted id fails the allowlist check
      // in gateway.rerank() with a clear error.
      models: ['rerank-v3.5', 'rerank-v4.0-pro'],
      default_model: 'rerank-v3.5',
      // Defensive ceiling matching the ZE/llama-server convention, NOT a
      // verified upstream limit. Cohere documents a soft guidance of <=1000
      // documents per request rather than a byte cap; the pre-flight guard
      // in gateway.rerank() turns an over-cap payload into a fail-open
      // `payload_too_large` instead of a wasted round trip.
      max_payload_bytes: 5_000_000,
      // Leaf-only path appended to base_url_default (which already carries
      // the /v2 prefix), mirroring how llama-server-reranker composes its URL.
      path: '/rerank',
    },
  },
  setup_hint:
    'Get an API key at https://dashboard.cohere.com/api-keys, then ' +
    '`export COHERE_API_KEY=...`. Trial keys are free but rate-limited and ' +
    'not licensed for production use — provision a Production key before cutover.',
};
