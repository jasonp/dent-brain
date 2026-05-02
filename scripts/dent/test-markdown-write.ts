#!/usr/bin/env bun
/**
 * Phase 1 gate test for markdown_append_to_page (PLAN v2.0).
 *
 * Calls the dent-brain HTTP MCP endpoint over the wire, appends a bullet
 * to a test page, and prints the resulting commit SHA + file path. Then
 * fetches the page back via `query` to confirm the Postgres index
 * surfaces the new content.
 *
 * Usage:
 *   DENT_BRAIN_URL=https://dent-brain.dentthefuture.com \
 *   DENT_BRAIN_TOKEN=dbk_xxx \
 *   bun run scripts/dent/test-markdown-write.ts
 *
 * Optional env:
 *   DENT_TEST_SLUG  override the test page slug (default: entities/people/test-phase1)
 *   DENT_TEST_NOTE  override the appended bullet text
 */

const URL_ = process.env.DENT_BRAIN_URL;
const TOKEN = process.env.DENT_BRAIN_TOKEN;
const SLUG = process.env.DENT_TEST_SLUG ?? 'entities/people/test-phase1';
const NOTE = process.env.DENT_TEST_NOTE ?? `- ${new Date().toISOString().slice(0, 19)}Z phase-1 gate test from CI`;

if (!URL_ || !TOKEN) {
  console.error('FATAL: DENT_BRAIN_URL and DENT_BRAIN_TOKEN must be set.');
  console.error('  export DENT_BRAIN_URL=https://dent-brain.dentthefuture.com');
  console.error('  export DENT_BRAIN_TOKEN=dbk_<your-token>');
  process.exit(1);
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(`${URL_}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result as T;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await call('tools/call', { name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? '';
  // Try to parse — most ops return JSON in the text field.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  console.log(`→ ${URL_}`);
  console.log(`  slug: ${SLUG}`);
  console.log(`  note: ${NOTE}`);
  console.log('');

  // 1. Sanity: /health is reachable.
  const health = await fetch(`${URL_}/health`).then((r) => r.json());
  console.log('health:', health);

  // 2. Confirm the new tool is in the list.
  const tools = (await call('tools/list')) as { tools: Array<{ name: string }> };
  const hasAppend = tools.tools.some((t) => t.name === 'markdown_append_to_page');
  console.log(`tools/list: ${tools.tools.length} tools, markdown_append_to_page present: ${hasAppend}`);
  if (!hasAppend) {
    console.error('FATAL: markdown_append_to_page not in tools/list. Server is on stale code.');
    process.exit(2);
  }

  // 3. Append.
  console.log('\n→ markdown_append_to_page ...');
  const appendResult = await callTool('markdown_append_to_page', {
    slug: SLUG,
    section: '## Timeline',
    content: NOTE,
    commit_note: 'Phase 1 gate test',
  });
  console.log('append result:', JSON.stringify(appendResult, null, 2));

  if ((appendResult as { status?: string }).status !== 'ok') {
    console.error('FATAL: append did not return status=ok.');
    process.exit(3);
  }

  // 4. Read the page back via get_page.
  console.log('\n→ get_page (readback) ...');
  const page = await callTool('get_page', { slug: SLUG });
  const compiled = (page as { compiled_truth?: string }).compiled_truth ?? '';
  console.log('page compiled_truth excerpt:');
  console.log(compiled.slice(0, 600));

  if (!compiled.includes(NOTE.replace(/^- /, ''))) {
    console.error('\nFATAL: appended note not found in Postgres-indexed page body.');
    process.exit(4);
  }

  // 5. Query (hybrid search) — should surface the content.
  console.log('\n→ query (hybrid search) ...');
  const queryWord = NOTE.split(/\s+/).slice(-2).join(' ');
  const queryResult = await callTool('query', { q: queryWord, limit: 5 });
  console.log('query top hit:');
  console.log(JSON.stringify((queryResult as any)?.hits?.[0] ?? queryResult, null, 2));

  console.log('\n✓ Phase 1 gate test PASSED');
  console.log(`  commit: ${(appendResult as { commit_sha?: string }).commit_sha}`);
  console.log(`  file:   ${(appendResult as { file_path?: string }).file_path}`);
  console.log(`  Verify in github: https://github.com/dentthefuture/dent-brain-data/commits/master`);
}

main().catch((e) => {
  console.error('test failed:', e instanceof Error ? e.message : e);
  process.exit(99);
});
