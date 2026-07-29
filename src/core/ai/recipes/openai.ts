import type { Recipe } from '../types.ts';

export const openai: Recipe = {
  id: 'openai',
  name: 'OpenAI',
  tier: 'native',
  implementation: 'native-openai',
  auth_env: {
    required: ['OPENAI_API_KEY'],
    optional: ['OPENAI_ORG_ID', 'OPENAI_PROJECT'],
    setup_url: 'https://platform.openai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      default_dims: 1536,
      // OpenAI accepts ANY dimension in 1..3072 for the text-embedding-3
      // family (Matryoshka); this list is gbrain's curated subset, not an
      // upstream constraint, and IS enforced by embedding-dim-check.ts.
      // 1280 is listed so brains migrating off ZeroEntropy's zembed-1 (which
      // defaulted to 1280d) can switch provider WITHOUT a vector column
      // change or an HNSW rebuild — the expensive part of an embedding
      // migration. Note 3072 exceeds pgvector's 2000-dim index ceiling for
      // the `vector` type, so it is usable only without an HNSW/IVFFlat index.
      dims_options: [256, 512, 768, 1024, 1280, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-04-20',
      // OpenAI per-request hard cap is 300K tokens. Free/Tier-1 TPM is 1M.
      // Cap batches conservatively at 100K to handle token-dense content
      // (Discord/Slack markdown+JSON tokenizes at ~chars/2.7, not the chars/4
      // estimate the batcher uses). 100K estimated = ~150K real tokens worst-case,
      // safely under both the 300K per-request and 1M TPM ceilings.
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 1.25, // gpt-5.2 baseline
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
