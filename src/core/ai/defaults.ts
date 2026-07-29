/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// v0.36.0 chose ZeroEntropy as the system default after evals showed
// 11/20 wins vs OpenAI (6) and Voyage (4) on real-corpus benchmarks. That
// default is retired here: ZeroEntropy was acquired by Notion and sunsets
// ALL products on September 4th, 2026, so a fresh install pointed at
// zembed-1 would provision a brain against a dead endpoint.
//
// OpenAI text-embedding-3-large is the replacement, at its native 1536.
//
// These constants govern FRESH INSTALLS ONLY. A brain migrating off
// zembed-1 keeps whatever `embedding_dimensions` it already has (1280 for
// ZE-era brains) so it can re-embed in place — same vector column, same
// HNSW index, no schema migration. That path reads the brain's own config,
// never these defaults, so there is nothing to gain by holding the default
// at 1280 and a little recall to lose. 1280 remains listed in the openai
// recipe's `dims_options` (enforced by embedding-dim-check.ts) precisely so
// those migrated brains stay valid at their existing width.
export const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
