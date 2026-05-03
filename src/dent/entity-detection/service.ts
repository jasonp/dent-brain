/**
 * Phase 4 entity-detection — tier 1, server-side.
 *
 * Public API: `detectEntities(text, ctx)`.
 *
 * Runs three passes against the brain's existing pages table:
 *   1. Exact-title match (full multi-word name in the input text).
 *   2. Alias match (frontmatter.aliases array on entity pages).
 *   3. First-name fallback for person-type pages — only fires when the
 *      first name has no full-name match in the same text. Lower
 *      confidence (0.7) so consumers can decide whether to act.
 *
 * Then collects unknown name-like strings: capitalized 1-3-word sequences
 * that didn't resolve to any entity. The /dent-append-evidence skill
 * takes the unknowns and runs FM lookups (tier 2). Server does not call
 * FM.
 */

import type { OperationContext } from '../../core/operations.ts';
import type { EntityMatch, EntityDetectionResult } from './types.ts';

/** Page types that count as "entities" for detection purposes. */
const ENTITY_TYPES = ['person', 'company', 'project'] as const;

/**
 * Cap on how many entity rows we load per detect call. The brain is
 * expected to be small in MVP (<5000 entity pages). If this gets hit in
 * practice, swap to an indexed approach.
 */
const ENTITY_LOAD_CAP = 5000;

/**
 * Words that look capitalized but should never be treated as candidate
 * person/company names in unknowns extraction. Conservative — prevents
 * "Tuesday" or "Dent" from polluting the unknowns list every call.
 */
const STOPWORDS = new Set([
  'I', 'A', 'An', 'The',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
  'Yes', 'No', 'OK', 'Okay',
  'Dent', // Always a known reference in this brain — don't treat as unknown name.
]);

interface EntityRow {
  slug: string;
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
}

interface IndexedEntity {
  slug: string;
  title: string;
  type: string;
  fm_id: string | null;
  /** Surface forms that should match: title + aliases. Lowercased. */
  fullNames: string[];
  /** First-token-only forms (lowercased), used for the fallback pass. */
  firstNames: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readFmId(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter.filemaker_record_id;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'null') return null;
  return s;
}

function readAliases(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.aliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(s => s.trim());
}

function buildIndex(rows: EntityRow[]): IndexedEntity[] {
  return rows.map(r => {
    const aliases = readAliases(r.frontmatter);
    const fullNames = [r.title, ...aliases].map(normalize);
    const firstNames =
      r.type === 'person'
        ? fullNames
            .map(n => n.split(/\s+/)[0])
            .filter(n => n.length >= 2)
        : [];
    return {
      slug: r.slug,
      title: r.title,
      type: r.type,
      fm_id: readFmId(r.frontmatter),
      fullNames,
      firstNames,
    };
  });
}

/**
 * Find every occurrence of `needle` in `haystack` as a whole word
 * (case-insensitive). Returns an array of matched substrings preserving
 * the source casing.
 */
function findWholeWordOccurrences(haystack: string, needle: string): string[] {
  if (needle.length === 0) return [];
  const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Capitalized 1–3-word sequences from text — candidate name-like strings.
 * Used to populate `unknowns` after the matched ranges are subtracted.
 */
function extractCapitalizedSpans(text: string): Array<{ span: string; start: number; end: number }> {
  // Word starts with uppercase, followed by lowercase. May chain up to 3
  // such words separated by single spaces. Excludes ALL-CAPS acronyms
  // (those rarely indicate person/company names in the dent context).
  const re = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;
  const out: Array<{ span: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const span = m[0];
    if (STOPWORDS.has(span) || STOPWORDS.has(span.split(' ')[0])) continue;
    out.push({ span, start: m.index, end: m.index + span.length });
  }
  return out;
}

/**
 * Tier-1 entity detection. Mechanical name-match against the brain's
 * existing person/company/project pages.
 */
export async function detectEntities(
  text: string,
  ctx: OperationContext,
): Promise<EntityDetectionResult> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { matches: [], unknowns: [] };
  }

  // Load the entity index. Per-call load is fine for MVP brain size.
  // Filter to entity types and only ask for the columns we need.
  const rows = await ctx.engine.listPages({ limit: ENTITY_LOAD_CAP });
  const entityRows: EntityRow[] = rows
    .filter(p => (ENTITY_TYPES as readonly string[]).includes(p.type))
    .map(p => ({
      slug: p.slug,
      title: p.title,
      type: p.type,
      frontmatter: p.frontmatter,
    }));

  const index = buildIndex(entityRows);

  const matches: EntityMatch[] = [];
  // Track which character ranges of `text` were already consumed by a
  // match so the unknowns extractor doesn't re-flag them.
  const consumedRanges: Array<[number, number]> = [];

  // Pass 1+2: exact title and alias match (multi-word forms first).
  // Sort by name length descending so "Alice Example" wins over "Mike"
  // when both could match.
  const fullNameTargets: Array<{ entity: IndexedEntity; name: string }> = [];
  for (const e of index) {
    for (const name of e.fullNames) {
      fullNameTargets.push({ entity: e, name });
    }
  }
  fullNameTargets.sort((a, b) => b.name.length - a.name.length);

  for (const { entity, name } of fullNameTargets) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip if this range overlaps a longer match already consumed.
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = consumedRanges.some(([s, e]) => start < e && end > s);
      if (overlaps) continue;

      const isAlias = name !== normalize(entity.title);
      matches.push({
        slug: entity.slug,
        title: entity.title,
        type: entity.type,
        fm_id: entity.fm_id,
        confidence: 1.0,
        rule: isAlias ? 'alias' : 'exact-title',
        matched_text: m[0],
      });
      consumedRanges.push([start, end]);
    }
  }

  // Pass 3: first-name fallback for person pages, ONLY when no full-name
  // hit for the same person already exists in `matches`. Lower confidence.
  const matchedSlugs = new Set(matches.map(m => m.slug));
  const firstNameTargets: Array<{ entity: IndexedEntity; name: string }> = [];
  for (const e of index) {
    if (matchedSlugs.has(e.slug)) continue;
    for (const fn of e.firstNames) {
      // Avoid first names that collide with another person's full name —
      // those should have been caught in pass 1.
      firstNameTargets.push({ entity: e, name: fn });
    }
  }

  for (const { entity, name } of firstNameTargets) {
    if (matchedSlugs.has(entity.slug)) continue; // already added (de-dup across loop)
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = consumedRanges.some(([s, e]) => start < e && end > s);
      if (overlaps) continue;

      matches.push({
        slug: entity.slug,
        title: entity.title,
        type: entity.type,
        fm_id: entity.fm_id,
        confidence: 0.7,
        rule: 'first-name-fallback',
        matched_text: m[0],
      });
      matchedSlugs.add(entity.slug);
      consumedRanges.push([start, end]);
      break; // one fallback hit per entity is enough; don't spam
    }
  }

  // Unknowns: capitalized name-like spans not consumed by any match.
  const spans = extractCapitalizedSpans(text);
  const unknownsSet = new Set<string>();
  for (const { span, start, end } of spans) {
    const overlaps = consumedRanges.some(([s, e]) => start < e && end > s);
    if (overlaps) continue;
    unknownsSet.add(span);
  }

  return {
    matches,
    unknowns: [...unknownsSet],
  };
}
