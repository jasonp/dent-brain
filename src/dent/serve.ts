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

// SIGCHLD reaper: must run at module load, before anything spawns children.
// Without this, every git / ssh / rev-list subprocess (markdown-writer,
// regfox-ingestor, granola-sync) becomes a zombie when it exits, and the
// container eventually hits RLIMIT_NPROC / pids-cgroup exhaustion. The
// classic symptom is `cannot fork() ... Resource temporarily unavailable`
// in markdown_append_to_page failures. Production v0.34.2 forked off
// upstream gbrain at v0.25.0 — predates the v0.28.1 reap fix — and `cli.ts`
// is the only entry point that called installSigchldHandler() until v0.36.
import { installSigchldHandler } from '../core/zombie-reap.ts';
installSigchldHandler();

import { createHash } from 'node:crypto';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { operations, type Operation, OperationError, type OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from '../mcp/tool-defs.ts';
import { buildDefaultLimiters, type RateLimiter } from '../mcp/rate-limit.ts';
import { entityDetectionOperations } from './operations/entity-detection.ts';
import { markdownWriteOperations } from './operations/markdown-write.ts';
import { exportOperations } from './operations/export.ts';
import { assembleServeOps } from './serve-ops.ts';
import { DENT_SOURCE_ID } from './db-writer/page-io.ts';
import { startExportCron, type ExportCronHandle } from './exporter/cron.ts';
import { startRegfoxCron, DEFAULT_REGFOX_POLL_INTERVAL_SECONDS, type RegfoxCronHandle } from './ingestors/regfox/cron.ts';
import {
  startNightlyMaintenance,
  DEFAULT_NIGHTLY_HOUR_UTC,
  DEFAULT_NIGHTLY_PHASES,
  type NightlyMaintenanceHandle,
} from './nightly-maintenance.ts';
import type { CyclePhase } from '../core/cycle.ts';
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
//
// The upstream set MUST pass through the canonical localOnly filter: this
// is an HTTP transport (ctx.remote = true), and localOnly ops (sync_brain,
// file_upload/file_list/file_url, …) are CLI-only by contract. Enforced
// structurally by scripts/check-operations-filter-bypass.sh.
const remoteSafeOps = operations.filter(op => !op.localOnly);
const allOps: Operation[] = assembleServeOps(remoteSafeOps);
const opsByName = new Map(allOps.map((o) => [o.name, o]));

const engine = new PostgresEngine();
await engine.connect({ database_url: DATABASE_URL!, poolSize: 10 });

// Reuse the engine's own postgres client for auth + audit. PostgresEngine
// already applies the pooler-mode `prepare: false` convention via
// resolvePrepare(url) in src/core/db.ts, so we don't have to mirror it here.
// Accessor, not a boot-time snapshot: upstream v0.42.21/v0.42.37 widened the
// sites where the engine tears down and rebuilds its instance pool (e.g. the
// getConfig retry path calls reconnect()). A snapshot would leave auth,
// /health, and the audit log querying the ended pool after the first rebuild.
const getSql = () => (engine as unknown as { sql: any }).sql;
if (!getSql()) {
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

// Single-brain Stage B: the server no longer forks git on the write path.
// markdown_* ops write straight to Postgres (db-writer); dent-brain-data is
// a derived one-way export mirror, refreshed nightly by the exporter cron
// below. No deploy key → no mirror → exports disabled, everything else runs.
let exportCron: ExportCronHandle | null = null;
if (process.env.DENT_BRAIN_DATA_DEPLOY_KEY) {
  exportCron = startExportCron(engine);
  console.error('[dent-brain] exporter: nightly DB→git export scheduled (DENT_BRAIN_EXPORT_HOUR_UTC or default 10:00 UTC)');
} else {
  console.error('[dent-brain] exporter: disabled (DENT_BRAIN_DATA_DEPLOY_KEY unset) — no git mirror will be maintained.');
}

// Phase 5.1 RegFox ingestor. Starts whenever the API key is set — writes are
// DB-direct now, so the data repo / deploy key is no longer a prerequisite.
let regfoxCron: RegfoxCronHandle | null = null;
if (process.env.DENT_BRAIN_REGFOX_API_KEY) {
  const intervalSec = Number.parseInt(
    process.env.DENT_BRAIN_REGFOX_POLL_INTERVAL_SECONDS ?? String(DEFAULT_REGFOX_POLL_INTERVAL_SECONDS),
    10,
  );
  if (Number.isFinite(intervalSec) && intervalSec > 0) {
    const formIds = (process.env.DENT_BRAIN_REGFOX_FORM_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    const maxPerTick = Number.parseInt(process.env.DENT_BRAIN_REGFOX_MAX_PER_TICK ?? '50', 10);
    const sleepMs = Number.parseInt(process.env.DENT_BRAIN_REGFOX_SLEEP_BETWEEN_WRITES_MS ?? '100', 10);
    regfoxCron = startRegfoxCron(
      engine,
      {
        apiKey: process.env.DENT_BRAIN_REGFOX_API_KEY,
        product: process.env.DENT_BRAIN_REGFOX_PRODUCT ?? 'regfox.com',
        formIds: formIds.length > 0 ? formIds : undefined,
        discountFieldPath: process.env.DENT_BRAIN_REGFOX_DISCOUNT_FIELD_PATH,
        maxPerTick: Number.isFinite(maxPerTick) && maxPerTick > 0 ? maxPerTick : undefined,
        sleepBetweenWritesMs: Number.isFinite(sleepMs) && sleepMs >= 0 ? sleepMs : undefined,
      },
      intervalSec * 1000,
    );
    console.error(
      `[dent-brain] regfox-ingestor: every ${intervalSec}s, forms=${formIds.length > 0 ? formIds.join(',') : 'all'}`,
    );
  } else {
    console.error('[dent-brain] regfox-ingestor: disabled (DENT_BRAIN_REGFOX_POLL_INTERVAL_SECONDS=0)');
  }
} else {
  console.error('[dent-brain] regfox-ingestor: not started (DENT_BRAIN_REGFOX_API_KEY unset)');
}

// Nightly brain maintenance — embed --stale + extract links + backlinks.
// Once per UTC day. Starts unconditionally (Stage B): embed is DB-only.
// The filesystem-walking phases (backlinks/extract) get the export mirror
// path when the mirror is configured; with no mirror we pass null and
// runCycle skips those phases with a per-phase 'skipped' entry.
let nightlyCron: NightlyMaintenanceHandle | null = null;
{
  const hourUtcRaw = process.env.DENT_BRAIN_NIGHTLY_HOUR_UTC;
  const hourUtc = hourUtcRaw !== undefined ? Number.parseInt(hourUtcRaw, 10) : DEFAULT_NIGHTLY_HOUR_UTC;
  if (Number.isFinite(hourUtc) && hourUtc >= 0 && hourUtc <= 23) {
    const phasesRaw = (process.env.DENT_BRAIN_NIGHTLY_PHASES ?? '').trim();
    const phases: CyclePhase[] = phasesRaw
      ? (phasesRaw.split(',').map((s) => s.trim()).filter(Boolean) as CyclePhase[])
      : DEFAULT_NIGHTLY_PHASES;
    const brainDir = process.env.DENT_BRAIN_DATA_DEPLOY_KEY
      ? (process.env.DENT_BRAIN_DATA_PATH || '/app/dent-brain-data')
      : null;
    if (brainDir === null) {
      console.error('[dent-brain] nightly-maintenance: no export mirror — dir-dependent phases (backlinks/extract) will be skipped.');
    }
    nightlyCron = startNightlyMaintenance(engine, {
      brainDir,
      hourUtc,
      phases,
    });
    console.error(
      `[dent-brain] nightly-maintenance: fires daily at ${String(hourUtc).padStart(2, '0')}:00 UTC, phases=${phases.join(',')}`,
    );
  } else {
    console.error('[dent-brain] nightly-maintenance: disabled (DENT_BRAIN_NIGHTLY_HOUR_UTC out of range)');
  }
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
    const [row] = await getSql()`
      SELECT id, name FROM access_tokens
      WHERE token_hash = ${hash} AND revoked_at IS NULL
    `;
    if (!row) return { ok: false };
    getSql()`UPDATE access_tokens
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
  // try/catch as well as .catch: engine.sql is a getter that THROWS
  // synchronously while the pool is mid-rebuild (reconnect window). A sync
  // throw here must never 500 a request whose dispatch already succeeded.
  try {
    getSql()`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
        VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})`
      .catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
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
    // The dent fork's canonical store is the markdown-backed 'dent' source:
    // markdown_* writes and the regfox/mailchimp ingestors all sync into it.
    // This context drives BOTH reads (get_page/search) and put_page writes, so
    // it must target 'dent' too — otherwise content written to 'dent' is
    // invisible to reads and direct put_page calls drift onto 'default'
    // (the split-brain that stranded the v0.43 bulk imports). Overridable via
    // DENT_BRAIN_READ_SOURCE for emergency rollback without a redeploy. Reads
    // reference the SAME DENT_SOURCE_ID constant the db-writer writes to,
    // so the two can't drift apart again.
    sourceId: process.env.DENT_BRAIN_READ_SOURCE || DENT_SOURCE_ID,
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

async function dispatch(name: string, args: Record<string, unknown>, tokenName?: string) {
  const op = opsByName.get(name);
  if (!op) {
    return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
  }
  // Admin-scope gate: every caller here is a remote bearer token (local
  // operators use the CLI / railway run, never this transport). Ops marked
  // scope:'admin' (e.g. export_brain_now) are denied unless the token's
  // name is allowlisted via DENT_BRAIN_ADMIN_TOKENS (comma-separated).
  // The localOnly filter strips upstream's admin surface at registry build;
  // this guards the dent-registered admin ops the same way.
  if (op.scope === 'admin') {
    const adminTokens = (process.env.DENT_BRAIN_ADMIN_TOKENS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!tokenName || !adminTokens.includes(tokenName)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', message: `Operation '${name}' requires an admin token (DENT_BRAIN_ADMIN_TOKENS).` }, null, 2) }],
        isError: true,
      };
    }
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
  // Source-isolation grant (upstream v0.42.37): with allowedSources set,
  // resolveRequestedScope rejects an explicit out-of-grant source_id param
  // from remote callers instead of silently honoring it. A single-element
  // grant collapses back to the scalar scope, so in-grant calls behave
  // exactly as before. clientId carries the bearer-token name so whoami
  // stays truthful (legacy-token shape: name doubles as clientId).
  ctx.auth = {
    token: '',
    clientId: tokenName ?? 'dent-brain-token',
    clientName: tokenName ?? 'dent-brain-token',
    scopes: [],
    // Union with DENT_SOURCE_ID: if the DENT_BRAIN_READ_SOURCE emergency
    // rollback lever is set, markdown_* writes still target 'dent' — the
    // grant must keep 'dent' readable or written content becomes
    // unreachable during exactly the emergency the lever exists for.
    allowedSources: [...new Set([process.env.DENT_BRAIN_READ_SOURCE || DENT_SOURCE_ID, DENT_SOURCE_ID])],
  };
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
        await getSql()`SELECT 1`;
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
      const result = await dispatch(toolName, args, auth.tokenName);
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
console.error(`[dent-brain]   ops    : ${remoteSafeOps.length} core (of ${operations.length}; localOnly filtered) + ${entityDetectionOperations.length} entity-detection + ${markdownWriteOperations.length} markdown-write + ${exportOperations.length} export = ${allOps.length}`);
if (!corsAllowlist) {
  console.error('[dent-brain]   CORS : default-deny. Set GBRAIN_HTTP_CORS_ORIGIN=https://your.app to allow browser clients.');
} else {
  console.error(`[dent-brain]   CORS : allowlist = ${[...corsAllowlist].join(', ')}`);
}

// Graceful shutdown for Railway zero-downtime deploys.
const shutdown = async (signal: string) => {
  console.error(`[dent-brain] received ${signal}, shutting down gracefully`);
  try {
    if (exportCron) exportCron.stop();
    if (regfoxCron) regfoxCron.stop();
    if (nightlyCron) nightlyCron.stop();
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
