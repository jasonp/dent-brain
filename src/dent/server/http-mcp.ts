/**
 * Dent Brain HTTP MCP server.
 *
 * Wraps gbrain's operation handlers in an HTTP transport so Claude Cowork
 * (or any remote MCP client) can connect via a public URL + bearer token.
 *
 * gbrain's shipped `gbrain serve` command is stdio-only. For our use case
 * (multi-user team access, Cowork connector URL, always-on), we need HTTP.
 *
 * Endpoints:
 *   GET  /health    - liveness probe, no auth
 *   GET  /ready     - readiness probe (DB reachable), no auth
 *   POST /mcp       - MCP JSON-RPC, requires Bearer <token>
 *
 * Authentication:
 *   Uses gbrain's existing `access_tokens` table. Tokens are created with:
 *     DATABASE_URL=... bun run src/commands/auth.ts create "<name>"
 *   Tokens are SHA-256 hashed at rest. On each /mcp call we hash the
 *   Authorization header, look up the active (non-revoked) token, update
 *   last_used_at, and log the request to mcp_request_log.
 *
 * Environment:
 *   PORT         - HTTP port (Railway sets this; default 3000)
 *   DATABASE_URL - Supabase pooler connection string (gbrain convention)
 *   NODE_ENV     - "production" enables tighter logging + error redaction
 */

import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import postgres from 'postgres';

import { PostgresEngine } from '../../core/postgres-engine.ts';
import { operations, OperationError } from '../../core/operations.ts';
import type { OperationContext } from '../../core/operations.ts';
import { loadConfig } from '../../core/config.ts';
import { VERSION } from '../../version.ts';
import { buildToolDefs } from '../../mcp/tool-defs.ts';

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required. Set it to your Supabase pooler connection string.');
  process.exit(1);
}

// Connect to Postgres for token lookups + request logging.
// Keep this separate from the gbrain engine's own connection so auth is
// fast and not competing with operation handlers for pool slots.
const authDb = postgres(DATABASE_URL, {
  max: 2, // auth and logging only — minimal pool
  idle_timeout: 20,
  connect_timeout: 10,
});

// Single shared PostgresEngine used by all MCP calls.
// Stateless requests, single engine connection pool.
// Pass an explicit poolSize so the engine takes the worker-instance code path
// (its own postgres() connection) instead of the module singleton — that way
// our HTTP server's connection pool is isolated from any other gbrain code
// that might construct a separate engine in the same process.
const engine = new PostgresEngine();
await engine.connect({ database_url: DATABASE_URL, poolSize: 10 });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

type TokenInfo = { id: string; name: string; scopes: string[] | null };

async function verifyBearer(authHeader: string | undefined): Promise<TokenInfo | null> {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
  const raw = authHeader.slice(7).trim();
  if (!raw) return null;

  const hash = hashToken(raw);
  const rows = await authDb<TokenInfo[]>`
    SELECT id, name, scopes
    FROM access_tokens
    WHERE token_hash = ${hash} AND revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;

  // Fire-and-forget last_used_at update (don't block the request).
  authDb`UPDATE access_tokens SET last_used_at = now() WHERE id = ${rows[0].id}`.catch((err) => {
    console.error(`[auth] failed to update last_used_at: ${err.message}`);
  });

  return rows[0];
}

async function logMcpRequest(
  tokenName: string | null,
  operation: string,
  latencyMs: number,
  status: 'success' | 'error',
  errorCode?: string,
): Promise<void> {
  try {
    // gbrain's mcp_request_log schema is (token_name, operation, latency_ms,
    // status, created_at). No error_code column. We surface error detail to
    // Railway stderr instead — gbrain's audit table records the binary
    // success/error and the latency, which is enough for trend monitoring.
    await authDb`
      INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
      VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})
    `;
    if (status === 'error' && errorCode) {
      console.error(`[audit] op=${operation} err=${errorCode} latency=${latencyMs}ms token=${tokenName}`);
    }
  } catch (err) {
    // Non-blocking; audit log failures should not fail the request.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[audit] failed to log request: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Server (per-request instance for stateless operation)
// ---------------------------------------------------------------------------

function buildMcpServer(): Server {
  const server = new Server(
    { name: 'dent-brain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(operations),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find((o) => o.name === name);
    if (!op) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const ctx: OperationContext = {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
      dryRun: !!(params?.dry_run),
      // HTTP callers are remote by definition; enforce strict file confinement.
      remote: true,
    };

    const safeParams = params || {};

    try {
      const result = await op.handler(ctx, safeParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return {
          content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }],
          isError: true,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      // In production, redact stack traces to avoid leaking internals.
      const outgoing = NODE_ENV === 'production' ? 'Internal error' : msg;
      return { content: [{ type: 'text', text: `Error: ${outgoing}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Health — no DB check
  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION, service: 'dent-brain' }));
    return;
  }

  // Readiness — verify DB reachable
  if (url === '/ready' && method === 'GET') {
    try {
      await authDb`SELECT 1`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: 'reachable' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, db: 'unreachable', error: msg }));
    }
    return;
  }

  // MCP — bearer auth required, supports POST (JSON-RPC), GET (SSE stream),
  // DELETE (close stream). All three are part of the Streamable HTTP transport
  // spec; clients like Cowork probe with GET first to establish a notification
  // stream, then POST individual requests.
  if (url === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
    const authHeader = (req.headers.authorization || req.headers.Authorization) as string | undefined;
    const token = await verifyBearer(authHeader);
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid or missing Bearer token' }));
      return;
    }

    const startedAt = Date.now();
    let operationName = method === 'GET' ? 'sse_stream' : method === 'DELETE' ? 'sse_close' : 'unknown';
    let status: 'success' | 'error' = 'success';
    let errorCode: string | undefined;

    try {
      // For POST: read + parse the JSON body. For GET/DELETE: no body to read.
      let parsedBody: unknown = undefined;
      if (method === 'POST') {
        const body = await readBody(req);
        if (body.length > 0) {
          try {
            parsedBody = JSON.parse(body.toString('utf-8'));
            // Capture the operation name for audit log (best-effort).
            if (parsedBody && typeof parsedBody === 'object' && 'method' in parsedBody) {
              const m = (parsedBody as any).method;
              if (typeof m === 'string') operationName = m;
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body is not valid JSON' }));
            return;
          }
        }
      }

      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — each request is self-contained
      });
      await server.connect(transport);

      // Hand off to the transport. It dispatches based on req.method (POST →
      // JSON-RPC, GET → SSE stream, DELETE → close).
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      status = 'error';
      errorCode = err instanceof Error ? err.name : 'unknown';
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] handler error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: NODE_ENV === 'production' ? 'Internal error' : msg }));
      }
    } finally {
      const latencyMs = Date.now() - startedAt;
      // Fire-and-forget audit log
      logMcpRequest(token.name, operationName, latencyMs, status, errorCode).catch(() => {});
    }
    return;
  }

  // Fallthrough 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', message: `No route ${method} ${url}` }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[server] unhandled error: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: NODE_ENV === 'production' ? 'Internal error' : msg }));
    }
  });
});

server.listen(PORT, () => {
  console.error(`[dent-brain] HTTP MCP server listening on :${PORT} (env=${NODE_ENV}, version=${VERSION})`);
  console.error(`[dent-brain]   GET  /health`);
  console.error(`[dent-brain]   GET  /ready`);
  console.error(`[dent-brain]   POST /mcp  (Bearer <token> required)`);
});

// Graceful shutdown — important for Railway's zero-downtime deploys
const shutdown = async (signal: string) => {
  console.error(`[dent-brain] received ${signal}, shutting down gracefully`);
  server.close(async () => {
    try {
      await engine.disconnect();
      await authDb.end();
      console.error('[dent-brain] shutdown complete');
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dent-brain] error during shutdown: ${msg}`);
      process.exit(1);
    }
  });
  // Force-exit after 10s
  setTimeout(() => {
    console.error('[dent-brain] forced exit after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
