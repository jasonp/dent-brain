/**
 * Deterministic helpers for the /dent-enrich skill.
 *
 * The skill itself (skills/dent/enrich/SKILL.md) is markdown executed by an
 * agent at runtime — it can't be unit-tested directly. The bits below are
 * the pure-TS pieces of the enrich orchestration (frontmatter parsing,
 * compiled-truth detection, FM-id resolution) that ARE testable. Tests live
 * at test/dent/enrich/.
 */

const FRONTMATTER_FENCE = '---';

/**
 * Pull `filemaker_record_id` out of YAML frontmatter, if present.
 *
 * Accepts the full markdown source of a page (frontmatter + body). Returns
 * the FM record id as a string when present and non-empty, otherwise null.
 *
 * Matching is intentionally loose: `filemaker_record_id` may be quoted
 * (`"12345"` or `'12345'`), unquoted (`12345`), or wrapped in whitespace.
 * Numeric values are returned as strings — FM record ids are opaque keys.
 *
 * Returns null when:
 *   - No frontmatter block exists
 *   - The key is absent
 *   - The value is empty / whitespace-only / a YAML null
 */
export function extractFmRecordId(pageContent: string): string | null {
  const fm = extractFrontmatter(pageContent);
  if (fm === null) return null;

  // Match `filemaker_record_id:` followed by an optional value on the
  // same line. Use `[^\S\n]` for horizontal whitespace so the regex
  // doesn't eat the newline and capture the next key's value when this
  // key has no value (e.g. `filemaker_record_id:\ntype: person`).
  const lineRe = /^[^\S\n]*filemaker_record_id[^\S\n]*:[^\S\n]*([^\n#]*?)[^\S\n]*(?:#.*)?$/m;
  const match = fm.match(lineRe);
  if (!match) return null;

  let raw = match[1].trim();
  // Strip surrounding quotes (single or double).
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }

  if (raw === '' || raw === '~' || raw.toLowerCase() === 'null') return null;
  return raw;
}

/**
 * Convenience predicate for skill orchestration: "should this page get an
 * FM-injection pass?"
 */
export function pageHasFmId(pageContent: string): boolean {
  return extractFmRecordId(pageContent) !== null;
}

/**
 * Carve a markdown page into its top-level frontmatter and the body that
 * follows. Returns null frontmatter if the page lacks the leading `---`
 * fence. Used by the enrich skill to read the prior synthesis verbatim
 * before generating a new one.
 */
export function extractFrontmatter(pageContent: string): string | null {
  // Frontmatter must start at the very first line (no leading whitespace,
  // no BOM-stripping here — callers are expected to pass clean input).
  if (!pageContent.startsWith(FRONTMATTER_FENCE)) return null;

  // Find the closing fence on its own line, after the opening one.
  const afterOpen = pageContent.indexOf('\n', FRONTMATTER_FENCE.length);
  if (afterOpen === -1) return null;

  const closeIdx = pageContent.indexOf(`\n${FRONTMATTER_FENCE}`, afterOpen);
  if (closeIdx === -1) return null;

  return pageContent.slice(afterOpen + 1, closeIdx);
}

/**
 * Split a page into `{frontmatter, body}` for the merge-on-rerun pattern.
 *
 * The skill passes `body` to the synthesis prompt as "prior synthesis —
 * preserve any human-written content verbatim, only refine where new
 * evidence adds material." Trusting the LLM with the whole body (rather
 * than parsing out compiled-truth headings) matches the v1.8 FM-as-truth
 * posture: simpler primitives, accept residual risk.
 *
 * If the page has no frontmatter (raw markdown), `frontmatter` is null and
 * the entire content is `body`.
 */
export function splitPage(pageContent: string): {
  frontmatter: string | null;
  body: string;
} {
  const fm = extractFrontmatter(pageContent);
  if (fm === null) {
    return { frontmatter: null, body: pageContent };
  }
  // Skip past `---\n<fm>\n---\n`. extractFrontmatter already validated
  // the fences; the body starts after the second fence's newline (or at
  // string-end if the page is fm-only).
  const closeFenceLine = `\n${FRONTMATTER_FENCE}`;
  const closeIdx = pageContent.indexOf(closeFenceLine, FRONTMATTER_FENCE.length);
  // Body begins after the closing fence; may be followed by `\n` or be EOF.
  const bodyStart = closeIdx + closeFenceLine.length;
  const body =
    pageContent.charAt(bodyStart) === '\n'
      ? pageContent.slice(bodyStart + 1)
      : pageContent.slice(bodyStart);
  return { frontmatter: fm, body };
}
