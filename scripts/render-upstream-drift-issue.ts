#!/usr/bin/env bun
/**
 * Renders drift.json (from check-upstream-drift.ts --json) into the markdown
 * body for the upstream-sync-check.yml tracking issue. Kept separate from
 * check-upstream-drift.ts so the drift-detection script stays single-purpose
 * and testable without pulling in GitHub-issue-specific formatting.
 *
 * Usage: bun run scripts/render-upstream-drift-issue.ts <drift.json>
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: render-upstream-drift-issue.ts <drift.json>');
  process.exit(2);
}
const d = JSON.parse(readFileSync(path, 'utf8'));

const subjectLines = (d.subjects as { sha: string; subject: string }[])
  .map((s) => `- \`${s.sha}\` ${s.subject.replace(/`/g, "'")}`)
  .join('\n');

console.log(`<!-- upstream-sync-check:tracking-issue -->

**Automated check** — opened/updated by \`.github/workflows/upstream-sync-check.yml\`. It does **not** merge anything; the sync stays human/agent-driven.

## Status (as of ${d.checkedAt.slice(0, 10)})

- Commits behind \`upstream/master\` (garrytan/gbrain): **${d.commitsBehind}**
- Date range covered: ${d.oldestDate} → ${d.newestDate}
- Local \`main\`: \`${d.localHead}\` · Upstream \`master\`: \`${d.upstreamHead}\`

## Recent upstream commits (newest first, ${d.subjectsShown} of ${d.commitsBehind} shown)

${subjectLines}

## To sync

\`\`\`
bun run sync:upstream
\`\`\`

Past syncs have needed real judgment calls (conflict volume has ranged from a
handful of files to 100+). See [\`TODOS.md\`](https://github.com/jasonp/dent-brain/blob/main/TODOS.md)
("Upstream sync" section) and
[\`docs/dent-brain/UPSTREAM_NOTES.md\`](https://github.com/jasonp/dent-brain/blob/main/docs/dent-brain/UPSTREAM_NOTES.md)
for conflict history and standing divergences to preserve (e.g.
\`DEFAULT_EMBEDDING_MODEL\` must stay \`openai:text-embedding-3-large\`).

---
_This issue updates in place on each scheduled/dispatched check. Close it once a sync lands._`);
