#!/bin/bash
# Reads the last N rows of mcp_request_log. Used to confirm UI surface tests
# (Claude Desktop, Claude.ai web, Cowork) actually hit /mcp.
#
# Usage: ./scripts/tail-mcp-audit.sh [LIMIT]
#
# Pulls DATABASE_URL from Railway. Requires `railway` CLI authenticated to the
# `dent-brain` project.

set -euo pipefail
LIMIT="${1:-15}"

DATABASE_URL=$(railway variables --kv 2>/dev/null | grep '^DATABASE_URL=' | cut -d= -f2-)
if [[ -z "$DATABASE_URL" ]]; then
  echo "Could not fetch DATABASE_URL from Railway. Run: railway login" >&2
  exit 1
fi

DATABASE_URL="$DATABASE_URL" bun -e "
import postgres from 'postgres';
const url = process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, prepare: false });
const rows = await sql\`
  SELECT token_name, operation, latency_ms, status, created_at
  FROM mcp_request_log
  ORDER BY created_at DESC
  LIMIT $LIMIT
\`;
for (const r of rows.reverse()) {
  console.log(\`\${r.created_at.toISOString()}  token=\${(r.token_name || '?').padEnd(30)} op=\${(r.operation || '?').padEnd(28)} \${String(r.latency_ms).padStart(5)}ms  \${r.status}\`);
}
await sql.end();
"
