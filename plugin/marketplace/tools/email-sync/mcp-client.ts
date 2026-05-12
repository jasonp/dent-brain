/**
 * Minimal JSON-RPC HTTP client for the dent-brain MCP endpoint.
 *
 * The server speaks MCP transport at POST /mcp with Bearer auth. We don't
 * pull in @modelcontextprotocol/sdk for this — the surface we use is tiny
 * (initialize once + tools/call N times) and adding the SDK would balloon
 * the daemon's dependency tree.
 */

export interface McpClientOptions {
  serverUrl: string;
  bearerToken: string;
  /** Optional fetch implementation (mostly useful for tests). */
  fetchImpl?: typeof fetch;
}

export class McpHttpError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = 'McpHttpError';
  }
}

export class McpToolError extends Error {
  constructor(public toolName: string, public detail: unknown, message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

export class McpClient {
  private nextId = 1;
  private fetchImpl: typeof fetch;

  constructor(private opts: McpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Probe the server. Throws if auth or transport is wrong. */
  async initialize(): Promise<{ serverInfo: { name: string; version: string } }> {
    const result = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'granola-sync', version: '0.1.0' },
    });
    return result as { serverInfo: { name: string; version: string } };
  }

  /** Call a tool by name. Returns the tool's `result` payload. */
  async tool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    // Server returns { content: [...], isError: bool, structuredContent?: ... }
    // following MCP convention. We unwrap structuredContent if present, else
    // join textual content into a string and try JSON.parse, else return raw.
    const r = result as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    if (r?.isError) {
      throw new McpToolError(name, r, `Tool ${name} returned isError`);
    }
    if (r?.structuredContent !== undefined) return r.structuredContent as T;
    if (Array.isArray(r?.content)) {
      const texts = r.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!);
      const joined = texts.join('');
      if (joined) {
        try { return JSON.parse(joined) as T; }
        catch { return joined as unknown as T; }
      }
    }
    return r as T;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    // 60-second per-call timeout. Markdown_replace_page can take a few seconds
    // when the data repo's working tree is contended; 60s leaves headroom.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.bearerToken}`,
        },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new McpHttpError(0, '', `MCP transport failed for ${method}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new McpHttpError(res.status, text, `MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let parsed: { result?: unknown; error?: { code: number; message: string } };
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new McpHttpError(res.status, text, `MCP returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (parsed.error) {
      throw new McpHttpError(res.status, text, `MCP error ${parsed.error.code}: ${parsed.error.message}`);
    }
    return parsed.result;
  }
}
