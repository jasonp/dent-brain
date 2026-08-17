/**
 * Cohere recipe shape tests. Cohere replaced zerank-2 as the default
 * reranker ahead of ZeroEntropy's 2026-09-04 sunset.
 *
 * The recipe carries no adapter code — it works only because Cohere's v2
 * rerank wire shape happens to match what `gateway.rerank()` already builds
 * and parses. These tests pin the handful of literals that silently break
 * that match, since a wrong base URL or path produces a 404 that the
 * reranker's fail-open contract swallows into "search just got worse" with
 * no loud error.
 */

import { describe, test, expect } from 'bun:test';
import { cohere } from '../../src/core/ai/recipes/cohere.ts';
import { RECIPES, getRecipe } from '../../src/core/ai/recipes/index.ts';
import { MODE_BUNDLES } from '../../src/core/search/mode.ts';

describe('cohere recipe shape', () => {
  test('registered in ALL[] via index.ts', () => {
    expect(RECIPES.has('cohere')).toBe(true);
    expect(getRecipe('cohere')).toBe(cohere);
  });

  test('implementation literal is "openai-compatible"', () => {
    expect(cohere.implementation).toBe('openai-compatible');
  });

  test('base_url + touchpoint path compose to Cohere v2 rerank URL', () => {
    // Mirrors the concatenation in gateway.rerank():
    //   `${baseURL.replace(/\/$/, '')}${tp.path ?? '/models/rerank'}`
    // Cohere serves rerank under /v2, NOT /v1, and NOT the ZeroEntropy
    // legacy /models/rerank default — so both halves must be explicit.
    const tp = cohere.touchpoints.reranker!;
    const url = `${cohere.base_url_default!.replace(/\/$/, '')}${tp.path ?? '/models/rerank'}`;
    expect(url).toBe('https://api.cohere.com/v2/rerank');
  });

  test('declares a reranker touchpoint and no embedding touchpoint', () => {
    // Reranker-only by design: the embedding default went to OpenAI in the
    // same cut, so a Cohere embedding touchpoint would be dead surface.
    expect(cohere.touchpoints.reranker).toBeDefined();
    expect(cohere.touchpoints.embedding).toBeUndefined();
  });

  test('default_model is in the allowlist', () => {
    // gateway.rerank() rejects any modelId not in `models` when the list is
    // non-empty. A default outside its own allowlist fails every call.
    const tp = cohere.touchpoints.reranker!;
    expect(tp.models).toContain(tp.default_model);
    expect(tp.default_model).toBe('rerank-v3.5');
  });

  test('requires COHERE_API_KEY', () => {
    expect(cohere.auth_env!.required).toEqual(['COHERE_API_KEY']);
  });

  test('mode bundles reference a reranker model SOME registered recipe can serve', () => {
    // Guards the split-brain where mode.ts points at a provider:model no
    // recipe actually allowlists. v0.46.3 split-default: the mode-bundle
    // default is zeroentropyai:zerank-2 (LEGACY fallback), not cohere —
    // cohere:rerank-v3.5 is still a valid explicit `search.reranker.model`
    // choice (see the base_url/allowlist tests above), just not what the
    // bundles reference today. Resolve dynamically instead of hardcoding
    // a provider so this test survives the next reranker-default flip.
    for (const bundle of Object.values(MODE_BUNDLES)) {
      const [provider, modelId] = bundle.reranker_model.split(':');
      const recipe = getRecipe(provider);
      expect(recipe, `no recipe registered for provider "${provider}"`).toBeDefined();
      const tp = recipe!.touchpoints.reranker;
      expect(tp, `recipe "${provider}" has no reranker touchpoint`).toBeDefined();
      expect(tp!.models, `"${modelId}" not in ${provider}'s reranker allowlist`).toContain(modelId);
    }
  });
});
