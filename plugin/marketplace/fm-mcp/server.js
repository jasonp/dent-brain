#!/usr/bin/env node
/**
 * FileMaker MCP Server
 *
 * Read-only MCP server for querying a single FileMaker database via the
 * Data API. Built to match the pattern of the RegFox MCP server in
 * ~/RegFox MCP/.
 *
 * Environment variables (required):
 *   FM_HOST       - FileMaker Server hostname, e.g. "your-fm-host.example.com"
 *   FM_DATABASE   - Database name, e.g. "YourFMDatabase"
 *   FM_USERNAME   - Account name with fmrest extended privilege
 *   FM_PASSWORD   - Password for that account
 *
 * Tools exposed (v0.1 = read-only):
 *   fm_ping              - Confirm the server is reachable & auth works
 *   fm_list_layouts      - Enumerate layouts available to this account
 *   fm_get_layout_fields - Get field names and types for one layout
 *   fm_list_scripts      - Enumerate scripts visible to this account
 *   fm_find_records      - Run a FileMaker find against a layout
 *   fm_get_record        - Fetch a single record by recordId
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FM_HOST = process.env.FM_HOST;
const FM_DATABASE = process.env.FM_DATABASE;
const FM_USERNAME = process.env.FM_USERNAME;
const FM_PASSWORD = process.env.FM_PASSWORD;

if (!FM_HOST || !FM_DATABASE || !FM_USERNAME || !FM_PASSWORD) {
  // stderr so it shows up in Claude Desktop's MCP logs
  console.error(
    "FileMaker MCP: missing required env vars. Need FM_HOST, FM_DATABASE, FM_USERNAME, FM_PASSWORD."
  );
  process.exit(1);
}

const BASE_URL = `https://${FM_HOST}/fmi/data/v1/databases/${encodeURIComponent(
  FM_DATABASE
)}`;

// ---------------------------------------------------------------------------
// Session token management
//
// FileMaker Data API tokens are valid for ~15 minutes of idle time.
// We cache one token in memory and refresh on 401.
// ---------------------------------------------------------------------------

let cachedToken = null;
let tokenAcquiredAt = 0;
const TOKEN_MAX_AGE_MS = 14 * 60 * 1000; // refresh proactively before 15 min expiry

async function login() {
  const basic = Buffer.from(`${FM_USERNAME}:${FM_PASSWORD}`).toString("base64");
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basic}`,
    },
    body: "{}",
  });
  const data = await res.json();
  if (!res.ok || data?.messages?.[0]?.code !== "0") {
    const code = data?.messages?.[0]?.code ?? res.status;
    const msg = data?.messages?.[0]?.message ?? "Unknown login failure";
    throw new Error(`FileMaker login failed (${code}): ${msg}`);
  }
  cachedToken = data.response.token;
  tokenAcquiredAt = Date.now();
  return cachedToken;
}

async function getToken() {
  if (!cachedToken || Date.now() - tokenAcquiredAt > TOKEN_MAX_AGE_MS) {
    await login();
  }
  return cachedToken;
}

/**
 * Make an authenticated Data API request.
 * On 401 we drop the cached token and retry once with fresh credentials.
 */
async function fmFetch(path, { method = "GET", body } = {}) {
  let token = await getToken();

  const doRequest = async (t) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response — include raw text for debugging
      throw new Error(
        `FileMaker returned non-JSON (${res.status}): ${text.slice(0, 200)}`
      );
    }
    return { res, data };
  };

  let { res, data } = await doRequest(token);

  // If the token expired, log in again and retry once.
  if (res.status === 401) {
    cachedToken = null;
    token = await login();
    ({ res, data } = await doRequest(token));
  }

  const code = data?.messages?.[0]?.code;
  if (!res.ok || (code && code !== "0")) {
    const msg = data?.messages?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`FileMaker API error (${code ?? res.status}): ${msg}`);
  }

  return data.response;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "filemaker-mcp",
  version: "0.1.0",
});

// Helper: format any result as a single text content block
const asText = (value) => ({
  content: [
    {
      type: "text",
      text:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

// Helper: wrap tool handlers so thrown errors come back as structured errors
// instead of killing the MCP connection.
const safeHandler = (fn) => async (args) => {
  try {
    const result = await fn(args);
    return asText(result);
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${err.message}`,
        },
      ],
    };
  }
};

// --- fm_ping ----------------------------------------------------------------
server.registerTool(
  "fm_ping",
  {
    title: "Ping FileMaker",
    description:
      "Verify the MCP server can authenticate against the FileMaker Data API. Returns server/database info and a snippet of the session token.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safeHandler(async () => {
    const token = await getToken();
    return {
      ok: true,
      host: FM_HOST,
      database: FM_DATABASE,
      username: FM_USERNAME,
      tokenPreview: `${token.slice(0, 8)}…`,
    };
  })
);

// --- fm_list_layouts --------------------------------------------------------
server.registerTool(
  "fm_list_layouts",
  {
    title: "List layouts",
    description:
      "List every layout in the database that this account can see. Layouts are FileMaker's view/table interfaces — you need a layout name to query records.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safeHandler(async () => {
    const response = await fmFetch("/layouts");
    return response.layouts ?? response;
  })
);

// --- fm_get_layout_fields ---------------------------------------------------
server.registerTool(
  "fm_get_layout_fields",
  {
    title: "Get layout fields",
    description:
      "Return the field names, types, and related-table structure for a specific layout. Use this before fm_find_records so you know what fields exist.",
    inputSchema: {
      layout: z
        .string()
        .describe("Exact layout name (case-sensitive). Get one from fm_list_layouts."),
    },
    annotations: { readOnlyHint: true },
  },
  safeHandler(async ({ layout }) => {
    const response = await fmFetch(`/layouts/${encodeURIComponent(layout)}`);
    return response;
  })
);

// --- fm_list_scripts --------------------------------------------------------
server.registerTool(
  "fm_list_scripts",
  {
    title: "List scripts",
    description:
      "Enumerate FileMaker scripts visible to this account. Read-only — does not execute them.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safeHandler(async () => {
    const response = await fmFetch("/scripts");
    return response.scripts ?? response;
  })
);

// --- fm_find_records --------------------------------------------------------
server.registerTool(
  "fm_find_records",
  {
    title: "Find records",
    description:
      "Search for records in a layout using FileMaker's find syntax. " +
      'Example query: [{"FirstName": "Steve", "Status": "Active"}] finds records where both fields match. ' +
      "Multiple objects in the array are OR'd together. Include {\"omit\": \"true\"} in an object to exclude matches.",
    inputSchema: {
      layout: z.string().describe("Layout name to search within."),
      query: z
        .array(z.record(z.string(), z.any()))
        .describe(
          "Array of find-request objects. Each object's field:value pairs are AND'd; multiple objects are OR'd."
        ),
      sort: z
        .array(
          z.object({
            fieldName: z.string(),
            sortOrder: z.enum(["ascend", "descend"]).optional(),
          })
        )
        .optional()
        .describe("Optional sort order."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max records to return. FileMaker defaults to 100."),
      offset: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-indexed offset for pagination."),
    },
    annotations: { readOnlyHint: true },
  },
  safeHandler(async ({ layout, query, sort, limit, offset }) => {
    const body = { query };
    if (sort) body.sort = sort;
    if (limit) body.limit = String(limit);
    if (offset) body.offset = String(offset);

    const response = await fmFetch(
      `/layouts/${encodeURIComponent(layout)}/_find`,
      { method: "POST", body }
    );
    return {
      dataInfo: response.dataInfo,
      recordCount: response.data?.length ?? 0,
      records: response.data ?? [],
    };
  })
);

// --- fm_get_record ----------------------------------------------------------
server.registerTool(
  "fm_get_record",
  {
    title: "Get record by ID",
    description: "Fetch a single record by its internal FileMaker recordId.",
    inputSchema: {
      layout: z.string().describe("Layout name."),
      recordId: z
        .string()
        .describe("FileMaker internal recordId (returned by fm_find_records)."),
    },
    annotations: { readOnlyHint: true },
  },
  safeHandler(async ({ layout, recordId }) => {
    const response = await fmFetch(
      `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(
        recordId
      )}`
    );
    return response.data?.[0] ?? response;
  })
);

// --- fm_create_record -------------------------------------------------------
server.registerTool(
  "fm_create_record",
  {
    title: "Create record",
    description:
      "Create a new record in a layout. Takes a fieldData object of field-name:value pairs. " +
      "WRITES TO THE DATABASE — only use when the user has explicitly asked you to create a record. " +
      "Returns the new recordId and modId on success.",
    inputSchema: {
      layout: z
        .string()
        .describe("Layout name to create the record in (case-sensitive)."),
      fieldData: z
        .record(z.string(), z.any())
        .describe(
          'Object of field names to values, e.g. {"FirstName": "Steve", "Status": "Active"}. ' +
            "Use fm_get_layout_fields first if unsure which fields exist."
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  safeHandler(async ({ layout, fieldData }) => {
    const response = await fmFetch(
      `/layouts/${encodeURIComponent(layout)}/records`,
      { method: "POST", body: { fieldData } }
    );
    return {
      recordId: response.recordId,
      modId: response.modId,
    };
  })
);

// ---------------------------------------------------------------------------
// Connect over stdio (Claude Desktop talks to MCP servers over stdio)
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Anything we write to stdout breaks the MCP protocol; console.error is fine
// for startup logging because it goes to stderr.
console.error(
  `FileMaker MCP v0.1 ready — ${FM_USERNAME}@${FM_HOST}/${FM_DATABASE}`
);
