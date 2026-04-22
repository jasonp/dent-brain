# FileMaker MCP

Custom MCP server for querying DentCRM2025 on `sea-17.fmsdb.com` via the FileMaker Data API.

Built because the third-party `filemaker-connector` DXT extension was
silently failing with "Invalid FileMaker Data API token" despite credentials
working via curl. Scope: v0.1 is read-only. Write/delete/script-execute
tools can be added later following the same pattern.

## Setup

```bash
cd ~/FileMaker\ MCP
npm install
```

That's it. No build step — it's plain ES modules.

## Test standalone (before wiring to Claude Desktop)

The MCP inspector gives you a browser UI to call the tools directly:

```bash
FM_HOST=sea-17.fmsdb.com \
FM_DATABASE=DentCRM2025 \
FM_USERNAME=mcp_claude \
FM_PASSWORD='your-password' \
npm run inspect
```

Open the URL it prints, click **Connect**, then **List Tools**, then try
`fm_ping` first. If ping works, everything is wired correctly.

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`.
Inside the existing `"mcpServers"` block, add:

```json
"filemaker": {
  "command": "node",
  "args": ["/Users/sb3/FileMaker MCP/server.js"],
  "env": {
    "FM_HOST": "sea-17.fmsdb.com",
    "FM_DATABASE": "DentCRM2025",
    "FM_USERNAME": "mcp_claude",
    "FM_PASSWORD": "your-password-here"
  }
}
```

Fully quit Claude Desktop (⌘Q, not just close the window) and reopen.
Ask Claude: "Ping my FileMaker database."

## Tools

| Tool | What it does |
|------|--------------|
| `fm_ping` | Verify auth works. Returns host/db/user and a token preview. |
| `fm_list_layouts` | List layouts visible to the account. |
| `fm_get_layout_fields` | Get field definitions for one layout. |
| `fm_list_scripts` | List scripts visible to the account (does not run them). |
| `fm_find_records` | Search records using FileMaker find syntax. |
| `fm_get_record` | Fetch one record by recordId. |

## How the find syntax works

`fm_find_records` takes a `query` array. Each object's fields are AND'd;
multiple objects in the array are OR'd.

Examples:

```js
// Active contacts named Steve
[{ "FirstName": "Steve", "Status": "Active" }]

// Anyone named Steve OR Jason
[{ "FirstName": "Steve" }, { "FirstName": "Jason" }]

// Active, excluding anyone whose LastName is Broback
[
  { "Status": "Active" },
  { "LastName": "Broback", "omit": "true" }
]
```

FileMaker find operators inside values: `==exact`, `>`, `<`, `>=`, `<=`,
`..range`, `*wildcard*`. See Claris Data API docs for full syntax.

## Next steps (when you want write access)

Add tools that POST/PATCH/DELETE — pattern is identical, just change the
`method` in `fmFetch`. You'll also want to swap the `mcp_claude` account
to a privilege set that allows edits (currently "View only in all tables").

- `fm_create_record` → POST `/layouts/{layout}/records` with `fieldData`
- `fm_update_record` → PATCH `/layouts/{layout}/records/{recordId}`
- `fm_delete_record` → DELETE `/layouts/{layout}/records/{recordId}`
- `fm_run_script` → GET `/layouts/{layout}/script/{name}?script.param=...`

## Troubleshooting

- **"missing required env vars" on startup** — env vars aren't reaching
  the server. For Claude Desktop, check the `env` block in the config.
- **"FileMaker login failed (212)"** — wrong username or password. Test
  with the curl command from earlier.
- **"FileMaker API error (9)"** — "insufficient privileges". The account
  needs the `fmrest` extended privilege AND access to the layout/table
  you're querying.
- **"FileMaker API error (105)"** — layout doesn't exist. Use
  `fm_list_layouts` to see valid names (case-sensitive).
- **Everything breaks after ~15 minutes idle** — shouldn't happen because
  we auto-refresh on 401, but if it does, the `TOKEN_MAX_AGE_MS` constant
  in server.js controls proactive refresh timing.
