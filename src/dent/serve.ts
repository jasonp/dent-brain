#!/usr/bin/env bun
/**
 * Dent Brain HTTP MCP entry point (Option B retrofit, 2026-05-01).
 *
 * Wraps upstream's `startHttpTransport` (src/mcp/http-transport.ts, v0.22.7)
 * with the merged operation registry (gbrain core ops + dent ops). Avoids
 * patching upstream's `src/core/operations.ts` so `bun run sync:upstream`
 * stays clean.
 *
 * The fork keeps it small: build a merged Operation[] array, hand it to a
 * thin HTTP server that mirrors upstream's transport contract — bearer auth
 * via access_tokens, mcp_request_log audit, rate limit, body cap, CORS,
 * DB-probing /health.
 *
 * Boot order:
 *   1. Read DATABASE_URL from env (Railway provides).
 *   2. Connect Postgres engine.
 *   3. Build merged ops array.
 *   4. Start Bun HTTP transport.
 *
 * Environment:
 *   PORT                       HTTP port (Railway sets this; default 3000)
 *   DATABASE_URL               Supabase pooler connection string
 *   GBRAIN_HTTP_CORS_ORIGIN    Comma-separated CORS allowlist (default: deny)
 *   GBRAIN_HTTP_MAX_BODY_BYTES Body cap in bytes (default 1 MiB)
 *   GBRAIN_HTTP_TRUST_PROXY    Set to '1' to honor X-Forwarded-For
 */

import { createHash } from 'node:crypto';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { operations, type Operation, OperationError, type OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from '../mcp/tool-defs.ts';
import { buildDefaultLimiters, type RateLimiter } from '../mcp/rate-limit.ts';
import { entityDetectionOperations } from './operations/entity-detection.ts';
import { markdownWriteOperations } from './operations/markdown-write.ts';
import { ensureDataRepo, setRepoContext } from './markdown-writer/repo.ts';
import { startScheduledPull, DEFAULT_PULL_INTERVAL_SECONDS, type ScheduledPullHandle } from './markdown-writer/cron.ts';
import { runMigrations, LATEST_VERSION as UPSTREAM_LATEST_VERSION } from '../core/migrate.ts';
import { runDentMigrations, DENT_LATEST_VERSION } from './migrate.ts';

const DEFAULT_BODY_CAP = 1024 * 1024;

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required. Set it to your Supabase pooler connection string.');
  process.exit(1);
}

// Merged registry: upstream first, dent appended. Order matters for
// tools/list ordering only; dispatch lookup is name-keyed.
const allOps: Operation[] = [...operations, ...entityDetectionOperations, ...markdownWriteOperations];
const opsByName = new Map(allOps.map((o) => [o.name, o]));

const engine = new PostgresEngine();
await engine.connect({ database_url: DATABASE_URL!, poolSize: 10 });

// Reuse the engine's own postgres client for auth + audit. PostgresEngine
// already applies the pooler-mode `prepare: false` convention via
// resolvePrepare(url) in src/core/db.ts, so we don't have to mirror it here.
const sql = (engine as unknown as { sql: any }).sql;
if (!sql) {
  console.error('FATAL: PostgresEngine has no .sql client after connect.');
  process.exit(1);
}

// Schema-drift guard: substrate sync ships source code that expects a newer
// schema than prod, and `dbrain auth create` / dent-migrate.ts only cover
// auth + dent migrations. Without this check, the first put_page after a
// substrate sync explodes with a column-doesn't-exist error from inside the
// engine. Cost: one read + (if drift) automated catch-up.
//
// GBRAIN_AUTOMIGRATE=skip lets ops opt out for staging environments where
// migrations need a manual review step. Default is fail-closed (auto-migrate)
// because production always wants to be at-version.
{
  const upstreamCurrent = parseInt(((await engine.getConfig('version')) || '1'), 10);
  const dentCurrent = parseInt(((await engine.getConfig('dent_version')) || '0'), 10);
  const upstreamDrift = upstreamCurrent < UPSTREAM_LATEST_VERSION;
  const dentDrift = dentCurrent < DENT_LATEST_VERSION;

  if (upstreamDrift || dentDrift) {
    console.error(
      `[dent-brain] schema drift detected — upstream ${upstreamCurrent}/${UPSTREAM_LATEST_VERSION}, dent ${dentCurrent}/${DENT_LATEST_VERSION}`
    );
    if (process.env.GBRAIN_AUTOMIGRATE === 'skip') {
      console.error(
        `[dent-brain] FATAL: GBRAIN_AUTOMIGRATE=skip and schema is behind. ` +
        `Run \`bun run scripts/dent-migrate.ts\` and the upstream migration sequence, ` +
        `then redeploy. Refusing to serve with stale schema.`
      );
      process.exit(1);
    }
    console.error('[dent-brain] auto-migrating (set GBRAIN_AUTOMIGRATE=skip to disable)...');
    if (upstreamDrift) {
      const r = await runMigrations(engine);
      console.error(`[dent-brain] upstream migrations: applied ${r.applied}, now at ${r.current}`);
    }
    if (dentDrift) {
      const r = await runDentMigrations(engine);
      console.error(`[dent-brain] dent migrations: applied ${r.applied}, now at ${r.current}`);
    }
  } else {
    console.error(
      `[dent-brain] schema versions current — upstream ${upstreamCurrent}, dent ${dentCurrent}`
    );
  }
}

// PLAN v2.0 Phase 1: clone-or-pull dent-brain-data and stash the SSH env
// + repo path so markdown_append_to_page / markdown_replace_page can run.
// Skipped when DENT_BRAIN_DATA_DEPLOY_KEY is unset (local dev / tests with
// no write path) — markdown_* ops will fail with "context not initialized"
// if invoked, which is the right error.
let scheduledPull: ScheduledPullHandle | null = null;
if (process.env.DENT_BRAIN_DATA_DEPLOY_KEY) {
  try {
    const repoCtx = await ensureDataRepo(engine);
    setRepoContext(repoCtx);
  } catch (e) {
    console.error(`[dent-brain] FATAL: ensureDataRepo failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // PLAN v2.0 Phase 4: scheduled pull. Surfaces teammate-side hand-edits
  // pushed to dent-brain-data master without waiting for the next agent
  // write to trigger an internal pull. Set DENT_BRAIN_PULL_INTERVAL_SECONDS=0
  // to disable (e.g. for staging or for debugging).
  const pullIntervalSec = Number.parseInt(
    process.env.DENT_BRAIN_PULL_INTERVAL_SECONDS ?? String(DEFAULT_PULL_INTERVAL_SECONDS),
    10,
  );
  if (Number.isFinite(pullIntervalSec) && pullIntervalSec > 0) {
    scheduledPull = startScheduledPull(engine, pullIntervalSec * 1000);
    console.error(`[dent-brain] scheduled-pull: every ${pullIntervalSec}s`);
  } else {
    console.error('[dent-brain] scheduled-pull: disabled (DENT_BRAIN_PULL_INTERVAL_SECONDS=0)');
  }
} else {
  console.error('[dent-brain] DENT_BRAIN_DATA_DEPLOY_KEY unset — markdown_* write ops will be unavailable.');
}

const limiters = buildDefaultLimiters();
const bodyCap = (() => {
  const v = process.env.GBRAIN_HTTP_MAX_BODY_BYTES;
  if (!v) return DEFAULT_BODY_CAP;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BODY_CAP;
})();

const corsAllowlist: Set<string> | null = (() => {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
})();

const tools = buildToolDefs(allOps);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function corsHeaders(origin: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (corsAllowlist && origin && corsAllowlist.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function corsPreflightHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
  if (corsAllowlist && origin && corsAllowlist.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const cl = req.headers.get('content-length');
  if (cl) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n > cap) return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* noop */ }
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function resolveClientIp(
  req: Request,
  server: { requestIP: (r: Request) => { address: string } | null },
): string {
  if (process.env.GBRAIN_HTTP_TRUST_PROXY === '1') {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xRealIp = req.headers.get('x-real-ip');
    if (xRealIp) return xRealIp.trim();
  }
  const sock = server.requestIP(req);
  return sock?.address || 'unknown';
}

interface AuthResult {
  ok: boolean;
  tokenId?: string;
  tokenName?: string;
}

async function validateToken(authHeader: string | null): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) return { ok: false };
  const token = authHeader.slice(7);
  const hash = hashToken(token);
  try {
    const [row] = await sql`
      SELECT id, name FROM access_tokens
      WHERE token_hash = ${hash} AND revoked_at IS NULL
    `;
    if (!row) return { ok: false };
    sql`UPDATE access_tokens
        SET last_used_at = now()
        WHERE id = ${row.id}
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`
      .catch(() => { /* fire-and-forget */ });
    return { ok: true, tokenId: row.id, tokenName: row.name };
  } catch {
    return { ok: false };
  }
}

function logRequest(tokenName: string | null, operation: string, status: string, latencyMs: number) {
  sql`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
      VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})`
    .catch(() => { /* best-effort */ });
}

function buildContext(): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: {
      info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
    },
    dryRun: false,
    remote: true,
  };
}

function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

async function dispatch(name: string, args: Record<string, unknown>) {
  const op = opsByName.get(name);
  if (!op) {
    return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
  }
  const validationError = validateParams(op, args);
  if (validationError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }],
      isError: true,
    };
  }
  const ctx = buildContext();
  ctx.dryRun = !!args.dry_run;
  try {
    const result = await op.handler(ctx, args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    // Always log the real error to stderr (Railway captures this) so prod
    // failures are diagnosable. The client still gets the redacted message
    // in production to avoid leaking internals over the wire.
    console.error(`[mcp] handler error in op=${name}: ${msg}${stack ? `\n${stack}` : ''}`);
    const outgoing = NODE_ENV === 'production' ? 'Internal error' : msg;
    return { content: [{ type: 'text', text: `Error: ${outgoing}` }], isError: true };
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const startedMs = Date.now();
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('origin');

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsPreflightHeaders(origin) });
    }

    if (path === '/health') {
      try {
        await sql`SELECT 1`;
        return Response.json(
          { status: 'ok', version: VERSION, transport: 'http', service: 'dent-brain', db: 'ok' },
          { headers: corsHeaders(origin) },
        );
      } catch (e: any) {
        return Response.json(
          { status: 'unhealthy', version: VERSION, transport: 'http', service: 'dent-brain', db: 'unreachable', error: e?.message ?? 'unknown' },
          { status: 503, headers: corsHeaders(origin) },
        );
      }
    }

    if (path !== '/mcp') {
      return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders(origin) });
    }

    const ip = resolveClientIp(req, server);
    const ipCheck = limiters.ip.check(ip);
    if (!ipCheck.allowed) {
      logRequest(null, 'unknown', 'rate_limited', Date.now() - startedMs);
      return Response.json(
        { error: 'rate_limited', message: 'Too many requests' },
        { status: 429, headers: corsHeaders(origin, { 'Retry-After': String(ipCheck.retryAfter ?? 60) }) },
      );
    }

    const bodyText = await readBodyWithCap(req, bodyCap);
    if (bodyText === null) {
      logRequest(null, 'unknown', 'body_too_large', Date.now() - startedMs);
      return Response.json(
        { error: 'payload_too_large', message: `Request body exceeds ${bodyCap} bytes` },
        { status: 413, headers: corsHeaders(origin) },
      );
    }

    const auth = await validateToken(req.headers.get('Authorization'));
    if (!auth.ok) {
      logRequest(null, 'unknown', 'auth_failed', Date.now() - startedMs);
      return Response.json(
        { error: 'invalid_token', message: 'Bearer token required. Create one: dbrain auth create <name>' },
        { status: 401, headers: corsHeaders(origin) },
      );
    }

    const tokCheck = limiters.token.check(auth.tokenId!);
    if (!tokCheck.allowed) {
      logRequest(auth.tokenName!, 'unknown', 'rate_limited', Date.now() - startedMs);
      return Response.json(
        { error: 'rate_limited', message: 'Too many requests for this token' },
        { status: 429, headers: corsHeaders(origin, { 'Retry-After': String(tokCheck.retryAfter ?? 60) }) },
      );
    }

    let body: { method?: string; params?: any; id?: any };
    try {
      body = JSON.parse(bodyText);
    } catch (e: any) {
      logRequest(auth.tokenName!, 'unknown', 'parse_error', Date.now() - startedMs);
      return Response.json(
        { error: 'parse_error', message: e?.message ?? 'invalid JSON' },
        { status: 400, headers: corsHeaders(origin) },
      );
    }

    const { method, params, id } = body;

    if (method === 'initialize') {
      logRequest(auth.tokenName!, 'initialize', 'success', Date.now() - startedMs);
      return Response.json(
        {
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'dent-brain', version: VERSION },
            capabilities: { tools: {} },
          },
          jsonrpc: '2.0',
          id,
        },
        { headers: corsHeaders(origin) },
      );
    }

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (method === 'tools/list') {
      logRequest(auth.tokenName!, 'tools/list', 'success', Date.now() - startedMs);
      return Response.json(
        { result: { tools }, jsonrpc: '2.0', id },
        { headers: corsHeaders(origin) },
      );
    }

    if (method === 'tools/call') {
      const toolName: string = params?.name ?? 'unknown';
      const args: Record<string, unknown> = params?.arguments ?? {};
      const result = await dispatch(toolName, args);
      const status = result.isError ? 'error' : 'success';
      logRequest(auth.tokenName!, `tools/call:${toolName}`, status, Date.now() - startedMs);
      return Response.json(
        { result, jsonrpc: '2.0', id },
        { headers: corsHeaders(origin) },
      );
    }

    logRequest(auth.tokenName!, method ?? 'unknown', 'unknown_method', Date.now() - startedMs);
    return Response.json(
      { error: 'unknown_method', message: `Unknown method: ${method}` },
      { status: 400, headers: corsHeaders(origin) },
    );
  },
});

console.error(`[dent-brain] HTTP MCP server listening on :${PORT} (env=${NODE_ENV}, version=${VERSION})`);
console.error(`[dent-brain]   GET  /health`);
console.error(`[dent-brain]   POST /mcp  (Bearer <token> required)`);
console.error(`[dent-brain]   ops    : ${operations.length} core + ${entityDetectionOperations.length} entity-detection + ${markdownWriteOperations.length} markdown-write = ${allOps.length}`);
if (!corsAllowlist) {
  console.error('[dent-brain]   CORS : default-deny. Set GBRAIN_HTTP_CORS_ORIGIN=https://your.app to allow browser clients.');
} else {
  console.error(`[dent-brain]   CORS : allowlist = ${[...corsAllowlist].join(', ')}`);
}

// Graceful shutdown for Railway zero-downtime deploys.
const shutdown = async (signal: string) => {
  console.error(`[dent-brain] received ${signal}, shutting down gracefully`);
  try {
    if (scheduledPull) scheduledPull.stop();
    server.stop(false);
    await engine.disconnect();
    console.error('[dent-brain] shutdown complete');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dent-brain] error during shutdown: ${msg}`);
    process.exit(1);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
