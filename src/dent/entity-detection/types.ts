/**
 * Phase 4 entity-detection types.
 *
 * Detection runs in two tiers:
 *   - Tier 1 (server, this module): mechanical name-match against the
 *     brain's existing pages table. Returns confirmed brain entities and
 *     name-like strings the brain hasn't seen.
 *   - Tier 2 (Cowork-side, /dent-append-evidence skill): for each unknown,
 *     the skill calls fm_find_records via the FM MCP to apply A5's
 *     escalation rule. The dent-brain server does NOT proxy to FM.
 */

/** A name in the input text resolved to a brain entity page. */
export interface EntityMatch {
  /** Slug of the matched page (e.g. "entities/people/steve-broback"). */
  slug: string;
  /** Page title. */
  title: string;
  /** Page type (person | company | project | ...). */
  type: string;
  /**
   * filemaker_record_id from page frontmatter when the page is already
   * linked to FM. null when the page exists in the brain but isn't linked.
   */
  fm_id: string | null;
  /**
   * 0.0–1.0. 1.0 = full-name exact match. 0.7 = first-name-only fallback.
   * Aliases match at the same confidence as the alias's anchor (full or
   * single-word).
   */
  confidence: number;
  /** Why this matched: 'exact-title' | 'alias' | 'first-name-fallback'. */
  rule: string;
  /** The substring from the input text that produced the match. */
  matched_text: string;
}

export interface EntityDetectionResult {
  matches: EntityMatch[];
  /**
   * Capitalized name-like substrings from the input text that did NOT
   * match any brain entity. Tier 2 (skill prose) takes these and runs
   * fm_find_records against the FM People layout for each one.
   */
  unknowns: string[];
}
