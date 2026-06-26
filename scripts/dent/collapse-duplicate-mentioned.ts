#!/usr/bin/env bun
/**
 * One-time cleanup: collapse duplicate `## Mentioned` sections on granola
 * meeting pages into a single clean block.
 *
 * Why this exists: an older granola-sync daemon wrote the `## Mentioned` heading
 * twice (heading-in-content + section-param), leaving two `## Mentioned` blocks
 * per enriched meeting; the v0.46.1.0 daemon then inserted its own block between
 * them on re-touch. v0.46.1.1 fixes the write path (`replace_section`), but pages
 * already enriched carry the completion sentinel, so the daemon skips them — they
 * won't self-heal. This script heals them directly.
 *
 * Mechanism: for each `type: meeting` page written by granola-sync, if the body
 * has more than one `## Mentioned` section (or one lacking the sentinel), pick the
 * best block (prefer the sentinel-bearing one, else the one with the most bullets),
 * and rewrite it via `markdown_append_to_page` with `replace_section: true` — which
 * removes every `## Mentioned` and writes exactly one. Requires the server to be on
 * v0.46.1.1+ (the op param). Reversible: pages are versioned (get_versions / revert).
 *
 * Usage:
 *   bun scripts/dent/collapse-duplicate-mentioned.ts --dry-run   # report only
 *   bun scripts/dent/collapse-duplicate-mentioned.ts             # apply
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { McpClient } from '../../tools/granola-sync/mcp-client.ts';

// Strict, full-line match — mirrors the server's spliceFragment heading regex
// (`^##\s+Mentioned\s*$`) so what this script counts as a `## Mentioned` section
// is exactly what `replace_section` will strip (no `## Mentioned Items` drift).
const MENTIONED_HEADING_RE = /^##\s+Mentioned\s*$/;
const ENRICHED_SENTINEL = '<!-- granola-sync:enriched -->';
const MENTIONED_INTRO = 'People, companies, and projects mentioned in this meeting (auto-detected from notes + transcript):';

function discoverFromClaudeJson(): { serverUrl: string; bearerToken: string } | null {
  const path = join(homedir(), '.claude.json');
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8'));
    const entry = c?.mcpServers?.['dent-brain'];
    const url = typeof entry?.url === 'string' ? entry.url : null;
    const auth = typeof entry?.headers?.Authorization === 'string' ? entry.headers.Authorization : null;
    const m = auth ? /^Bearer\s+(.+)$/.exec(auth) : null;
    if (!url || !m) return null;
    return { serverUrl: url, bearerToken: m[1].trim() };
  } catch {
    return null;
  }
}

/** Split a markdown body into `## Mentioned` blocks. Returns each block's lines
 *  (excluding the heading) plus whether it carried the sentinel. */
function extractMentionedBlocks(body: string): Array<{ lines: string[]; hasSentinel: boolean }> {
  const lines = body.split('\n');
  const blocks: Array<{ lines: string[]; hasSentinel: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (MENTIONED_HEADING_RE.test(lines[i])) {
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !/^#{1,2}\s/.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      i--; // step back; outer loop re-increments
      const hasSentinel = bodyLines.some((l) => l.includes(ENRICHED_SENTINEL));
      blocks.push({ lines: bodyLines, hasSentinel });
    }
  }
  return blocks;
}

/** Pick the winning block: prefer one with the sentinel, else the one with the
 *  most `- [[…]]` bullets. Returns clean content (intro + bullets) WITHOUT the
 *  heading or sentinel; the caller re-adds the sentinel. */
function winningContent(blocks: Array<{ lines: string[]; hasSentinel: boolean }>): string {
  if (blocks.length === 0) return '_No entities auto-detected._';
  const wikilinks = (b: { lines: string[] }) => b.lines.filter((l) => /^\s*-\s+\[\[/.test(l));
  // Pick the RICHEST block across ALL blocks (most `[[…]]` bullets); sentinel
  // presence is only a tiebreak, never an override — a sentinel sitting on an
  // empty/placeholder block must not beat a richer block and silently drop real
  // entities.
  const best = blocks.reduce((a, b) => {
    const da = wikilinks(a).length, db = wikilinks(b).length;
    if (db !== da) return db > da ? b : a;
    return b.hasSentinel && !a.hasSentinel ? b : a;
  }, blocks[0]);
  const bullets = wikilinks(best);
  if (bullets.length > 0) return [MENTIONED_INTRO, '', ...bullets].join('\n');
  // No auto-detected entities in any block — preserve any human-authored
  // non-empty content verbatim rather than clobbering it with the placeholder.
  const kept = best.lines.filter((l) => l.trim() && !l.includes(ENRICHED_SENTINEL));
  return kept.length > 0 ? kept.join('\n') : '_No entities auto-detected._';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = discoverFromClaudeJson();
  if (!cfg) {
    console.error('No dent-brain MCP entry in ~/.claude.json. Run `claude mcp add dent-brain ...` first.');
    process.exit(1);
  }
  const client = new McpClient({ serverUrl: cfg.serverUrl, bearerToken: cfg.bearerToken });
  const init = await client.initialize();
  console.error(`[collapse-mentioned] mode=${dryRun ? 'DRY RUN' : 'APPLY'} server=${init.serverInfo.name} v${init.serverInfo.version}`);

  const pages = await client.tool<Array<{ slug: string }>>('list_pages', { type: 'meeting', limit: 5000 });
  console.error(`[collapse-mentioned] ${pages.length} meeting page(s) to scan`);

  let scanned = 0, affected = 0, fixed = 0, failed = 0;
  for (const { slug } of pages) {
    scanned++;
    let page: { compiled_truth?: string; frontmatter?: Record<string, unknown> } | null;
    try {
      page = await client.tool('get_page', { slug });
    } catch (e) {
      console.error(`  ERR get_page ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
      continue;
    }
    if (!page || page.frontmatter?.['created_via'] !== 'granola-sync') continue;
    const body = page.compiled_truth ?? '';
    const blocks = extractMentionedBlocks(body);
    // Affected = more than one Mentioned section, OR exactly one that lacks the
    // sentinel (old-format — collapsing it stamps the sentinel so the daemon
    // recognizes it as done).
    const isAffected = blocks.length > 1 || (blocks.length === 1 && !blocks[0].hasSentinel);
    if (!isAffected) continue;
    affected++;

    const content = winningContent(blocks) + '\n\n' + ENRICHED_SENTINEL;
    if (dryRun) {
      console.error(`  WOULD FIX ${slug} — ${blocks.length} Mentioned block(s) → 1`);
      continue;
    }
    try {
      await client.tool('markdown_append_to_page', { slug, section: '## Mentioned', content, replace_section: true });
      fixed++;
      console.error(`  FIXED ${slug} — ${blocks.length} → 1`);
    } catch (e) {
      failed++;
      console.error(`  ERR write ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.error(
    `\n[collapse-mentioned] done: scanned=${scanned} affected=${affected} ${dryRun ? '(dry run — no writes)' : `fixed=${fixed}`} failed=${failed}`,
  );
}

main().catch((e) => {
  console.error('[collapse-mentioned] FATAL', e);
  process.exit(1);
});
