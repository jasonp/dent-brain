# FileMaker MCP — Setup for Jason

Steve built a custom MCP server that lets Claude Desktop query DentCRM2025 directly via the FileMaker Data API. This doc gets you set up the same way on your Mac.

**Time required:** \~15 minutes.

**You'll end up with:** a new FileMaker account (`mcp_jason`) scoped to read \+ edit DentCRM2025, running as a local Node.js MCP server, wired into Claude Desktop so you can ask Claude to query the CRM in plain English.

---

## Prerequisites

- FileMaker Pro installed (you already have it)  
- Your existing `Jason` full-access FileMaker account  
- Node.js 18+ on your Mac. Check with `node --version` in Terminal. If missing or too old, install via Homebrew: `brew install node`  
- Claude Desktop installed

---

## Step 1 — Create your FileMaker account

Open DentCRM2025 in FileMaker Pro, logged in as `Jason` (full access).

1. **File → Manage → Security**  
2. Click **\+ New** (bottom left) to add an account  
3. Fill in:  
   - **Account Name:** `mcp_jason`  
   - **Password:** click the pencil icon and set a strong one. Save it somewhere — you'll need it in Step 4\. A password manager entry labeled "FileMaker MCP — DentCRM2025" works well.  
   - **Require password change on next sign-in:** leave UNCHECKED (critical — checked will break API login)  
   - **Active:** ✅  
   - **Privilege Set:** `MCP Read And Edit Records` (Steve already created this)  
4. Click **OK** to close Manage Security  
5. FileMaker will prompt for full-access credentials to commit — enter your `Jason` password

---

## Step 2 — Verify the account works via curl

Before touching Claude Desktop, confirm your account can actually authenticate. Open Terminal and run (replace `YOUR_PASSWORD` with what you just set):

```shell
curl -X POST https://sea-17.fmsdb.com/fmi/data/v1/databases/DentCRM2025/sessions \
  -H "Content-Type: application/json" \
  -u 'mcp_jason:YOUR_PASSWORD' \
  -d '{}'
```

**Expected output** (one line of JSON):

```
{"response":{"token":"..."},"messages":[{"code":"0","message":"OK"}]}
```

If you get `code: 212`, password is wrong — retype carefully. If you get `code: 9`, the privilege set isn't right — check Step 1\. If you see a curl error about SSL or connection refused, something's off with network — talk to Steve.

**Password gotcha:** if your password contains `!`, `$`, or backticks, bash can mangle it. The single quotes around `-u 'mcp_jason:PASSWORD'` above prevent this — keep them.

---

## Step 3 — Install the MCP server

Unzip `FileMaker-MCP-for-Jason.zip` into your home directory so you end up with a folder at `~/FileMaker MCP/` containing three files: `server.js`, `package.json`, `README.md`.

Then install dependencies:

```shell
cd ~/FileMaker\ MCP
npm install
```

Takes \~20 seconds. You'll see "added 91 packages" or similar. Warnings about deprecated packages are normal — ignore them.

---

## Step 4 — Wire into Claude Desktop

Quit Claude Desktop (⌘Q) before editing the config.

Open the config file:

```shell
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

What you see depends on whether you've set up other MCP servers before.

### Case A: File is mostly empty

If it only contains something like:

```json
{
  "preferences": {
    "coworkWebSearchEnabled": true,
    ...
  }
}
```

Replace the whole file with this (substituting your real password):

```json
{
  "mcpServers": {
    "filemaker": {
      "command": "node",
      "args": ["/Users/YOUR_MAC_USERNAME/FileMaker MCP/server.js"],
      "env": {
        "FM_HOST": "sea-17.fmsdb.com",
        "FM_DATABASE": "DentCRM2025",
        "FM_USERNAME": "mcp_jason",
        "FM_PASSWORD": "your-password-here"
      }
    }
  },
  "preferences": {
    "coworkWebSearchEnabled": true
  }
}
```

Replace `YOUR_MAC_USERNAME` with your Mac username (find it with `whoami` in Terminal).

### Case B: File already has an `mcpServers` block

If there's already a `"mcpServers": { ... }` block with other entries, add the `filemaker` entry inside it. **Comma placement matters in JSON** — the entry before yours needs a trailing comma, and if `filemaker` becomes the last entry it should NOT have a trailing comma after its closing `}`.

If you're unsure, paste your current file into Slack (with any passwords redacted) and Steve or I can send back the correctly-edited version.

### Validate before restarting

```shell
python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo "VALID JSON ✓"
```

Should print `VALID JSON ✓`. If it prints an error, the JSON is broken and Claude Desktop won't load any MCPs — fix it before proceeding.

---

## Step 5 — Test it

Relaunch Claude Desktop. In a brand new chat (not an existing one — tool lists are cached per-chat), ask:

"Ping my FileMaker database."

Expected: Claude calls the `fm_ping` tool and returns something like:

```json
{
  "ok": true,
  "host": "sea-17.fmsdb.com",
  "database": "DentCRM2025",
  "username": "mcp_jason",
  "tokenPreview": "a1b2c3d4…"
}
```

If it works, you're done. Try asking things like:

- "What layouts are in my FileMaker database?"  
- "Find people in DentCRM2025 whose last name contains 'Smith'."

---

## Available tools

- `fm_ping` — auth sanity check  
- `fm_list_layouts` — list all layouts visible to mcp\_jason  
- `fm_get_layout_fields` — get field names/types for a layout  
- `fm_list_scripts` — list scripts (doesn't execute them)  
- `fm_find_records` — search records using FileMaker find syntax  
- `fm_get_record` — fetch one record by recordId  
- `fm_create_record` — create a new record (writes to DB — use carefully)

---

## Troubleshooting

**"Ping my FileMaker database" returns "I don't have access to FileMaker tools"** MCP didn't load. Check:

- `claude_desktop_config.json` is valid JSON (run the python3 validation above)  
- Path in `args` matches your actual location — try `ls "/Users/YOUR_USERNAME/FileMaker MCP/server.js"` to verify the file's there  
- You fully quit Claude Desktop before editing and relaunched after  
- Starting a **new** chat, not continuing an old one

**Getting "FileMaker login failed (212)"** Password is wrong. Most likely you typed it differently into the config than you set in FileMaker. Re-set the password via File → Manage → Security and update both places.

**Getting "FileMaker API error (9): insufficient privileges"** The privilege set isn't right on the mcp\_jason account. Go back to Step 1 and verify `MCP Read And Edit Records` is selected.

**Getting module not found errors on startup** You skipped `npm install`. Run it from `~/FileMaker MCP/`.

**Everything else** Check the Claude Desktop logs: `~/Library/Logs/Claude/mcp-server-filemaker.log` — the error will be at the bottom. Ping Steve with whatever's there.

---

## Notes for later

- **Your activity is audited under `mcp_jason`**, not a shared account. Adding write tools later won't change that.  
- **`server.js` updates** will come from Steve when he adds new tools (update, delete, run script, etc.). When he sends a new version, drop it into `~/FileMaker MCP/` and quit/relaunch Claude Desktop.  
- **Don't share your password.** It's scoped to you so audit logs work. If it gets exposed, rotate via File → Manage → Security → pencil icon on `mcp_jason`, then update `FM_PASSWORD` in `claude_desktop_config.json` and quit/relaunch.

