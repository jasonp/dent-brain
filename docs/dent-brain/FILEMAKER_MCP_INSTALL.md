# FileMaker MCP — Install walkthrough

Custom MCP server (built by Steve) that lets Claude Desktop query DentCRM
directly via the FileMaker Data API. **Independent of dent-brain** — they
share Claude Desktop but nothing else. Installing one doesn't affect the
other.

This doc is written so a teammate can ask Cowork:

> *"Read https://github.com/jasonp/dent-brain/blob/main/docs/dent-brain/FILEMAKER_MCP_INSTALL.md and walk me through the install. Pause at each question and wait for my answer."*

Cowork fetches the page, walks through the steps, and pauses where input
is needed.

**Time required:** ~15 minutes.

**End state:** a FileMaker account scoped to the teammate (e.g. `mcp_steve`,
`mcp_robin`) running a local Node.js MCP server, wired into Claude Desktop.
Cowork can then ask the CRM things like "find people in DentCRM whose last
name contains 'Smith'" in plain English.

---

## 0. What you'll need from the admin

Before starting, confirm with the admin (Jason today) that they've sent
you (via Slack/email/1Password share):

1. The **`FileMaker-MCP-for-<yourhandle>.zip`** archive — contains
   `server.js`, `package.json`, and a `README.md`. Steve produces this
   per-teammate.
2. Your **FileMaker handle** to use for the MCP account, e.g. `mcp_steve`,
   `mcp_robin`. Pick something stable; this becomes your audit-log identity
   inside DentCRM.
3. Confirmation that a **`MCP Read And Edit Records` privilege set** exists
   in DentCRM (Steve set this up once for everyone).

If you don't have all three, stop and ask the admin before continuing.

---

## 1. Prerequisites

### Cowork prompt

Ask the user:

1. "Do you have FileMaker Pro installed?" — If no: install via Apple
   FileMaker Cloud / your DentCRM provisioner. This walkthrough assumes
   yes.
2. "Do you have a full-access account on DentCRM (e.g. your own named
   account, not just `Guest`)?" — If no: ask the admin to provision one.
   You need full-access to create the MCP-scoped account in Step 2.
3. "Run `node --version` in Terminal. What does it print?" Need Node 18+.
   - If 18+: ✅ continue.
   - If older or missing: `brew install node` (assumes Homebrew). Re-run
     `node --version` to confirm.
4. "Run `which npm`. Does it print a path?" If no: same fix — `brew install node`
   includes npm.

---

## 2. Create your FileMaker account

### Cowork prompt

Ask the user: **"What handle do you want to use for the FileMaker account? (Suggested: `mcp_<yourfirstname>`)"**

Use the answer as `<MCP_HANDLE>` below.

Then walk them through:

Open DentCRM in FileMaker Pro, logged in as your full-access account.

1. **File → Manage → Security**
2. Click **+ New** (bottom left) to add an account
3. Fill in:
   - **Account Name:** `<MCP_HANDLE>`
   - **Password:** click the pencil icon and set a strong one. Save it
     somewhere — you'll need it in Step 4. A password manager entry
     labeled `FileMaker MCP — DentCRM` works well.
   - **Require password change on next sign-in:** leave UNCHECKED
     (critical — checked will break API login).
   - **Active:** ✅
   - **Privilege Set:** `MCP Read And Edit Records`
4. Click **OK** to close Manage Security.
5. FileMaker will prompt for full-access credentials to commit — enter
   your own full-access password.

---

## 3. Verify the account works via curl

Before touching Claude Desktop, confirm the new account can authenticate.

### Cowork prompt

Tell the user to open Terminal and run (substituting their handle and the
password they just set):

```bash
curl -X POST https://sea-17.fmsdb.com/fmi/data/v1/databases/DentCRM2025/sessions \
  -H "Content-Type: application/json" \
  -u '<MCP_HANDLE>:<YOUR_PASSWORD>' \
  -d '{}'
```

Expected output (one line of JSON):

```
{"response":{"token":"..."},"messages":[{"code":"0","message":"OK"}]}
```

If you get:
- **`code: 212`** — password mismatch. Retype the curl carefully; passwords
  with `!` or `$` need single quotes around `-u '...'` (which the example
  has — keep them).
- **`code: 9`** — privilege set is wrong. Go back to Step 2.4 and verify
  `MCP Read And Edit Records` is selected.
- **SSL or connection refused error** — network issue. Ping the admin.

Don't proceed until you see `code: 0, message: OK`.

---

## 4. Install the MCP server

### Cowork prompt

Tell the user to:

1. Locate the `FileMaker-MCP-for-<yourhandle>.zip` from the admin.
2. Unzip it into their home directory so the result is `~/FileMaker MCP/`
   containing `server.js`, `package.json`, `README.md`.
3. Run the install:

```bash
cd ~/FileMaker\ MCP
npm install
```

Takes ~20 seconds. "added 91 packages" or similar is success. Warnings
about deprecated packages are normal — ignore them.

---

## 5. Wire into Claude Desktop

### Cowork prompt

Quit Claude Desktop completely (Cmd+Q) before editing the config.

Tell the user to find their Mac username:

```bash
whoami
```

Use the output as `<MAC_USERNAME>` below.

Then open the config file:

```bash
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

What's already in there determines the merge approach:

### Case A: File is empty or doesn't have an `mcpServers` block

Replace the whole file with this (substituting `<MAC_USERNAME>`,
`<MCP_HANDLE>`, `<YOUR_PASSWORD>`):

```json
{
  "mcpServers": {
    "filemaker": {
      "command": "node",
      "args": ["/Users/<MAC_USERNAME>/FileMaker MCP/server.js"],
      "env": {
        "FM_HOST": "sea-17.fmsdb.com",
        "FM_DATABASE": "DentCRM2025",
        "FM_USERNAME": "<MCP_HANDLE>",
        "FM_PASSWORD": "<YOUR_PASSWORD>"
      }
    }
  },
  "preferences": {
    "coworkWebSearchEnabled": true
  }
}
```

### Case B: File already has an `mcpServers` block (e.g. dent-brain entry)

Add the `filemaker` key inside the existing `mcpServers` object. JSON
comma rules: every entry except the last gets a trailing comma. Result
should look like:

```json
{
  "mcpServers": {
    "dent-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "...", "..."]
    },
    "filemaker": {
      "command": "node",
      "args": ["/Users/<MAC_USERNAME>/FileMaker MCP/server.js"],
      "env": {
        "FM_HOST": "sea-17.fmsdb.com",
        "FM_DATABASE": "DentCRM2025",
        "FM_USERNAME": "<MCP_HANDLE>",
        "FM_PASSWORD": "<YOUR_PASSWORD>"
      }
    }
  },
  "preferences": { ... }
}
```

If unsure about the comma placement, ask Cowork to validate the merged
JSON before saving.

### Validate

Before relaunching Claude Desktop, confirm the JSON is valid:

```bash
python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo "VALID JSON ✓"
```

Should print `VALID JSON ✓`. If it errors, the JSON is broken and Claude
Desktop will silently skip ALL MCP servers — fix before proceeding.

---

## 6. Test it

Relaunch Claude Desktop. **In a NEW chat** (not an existing one — tool
registries cache per-chat), ask:

> *"Ping my FileMaker database."*

Expected: Claude calls the `fm_ping` tool and returns:

```json
{
  "ok": true,
  "host": "sea-17.fmsdb.com",
  "database": "DentCRM2025",
  "username": "<MCP_HANDLE>",
  "tokenPreview": "a1b2c3d4…"
}
```

If that works, try:

- *"What layouts are in my FileMaker database?"*
- *"Find people in DentCRM whose last name contains 'Smith'."*

If it works, you're done.

---

## Available tools

Once installed, Cowork can call these against DentCRM:

- `fm_ping` — auth sanity check
- `fm_list_layouts` — list all layouts visible to your account
- `fm_get_layout_fields` — get field names/types for a layout
- `fm_list_scripts` — list scripts (doesn't execute them)
- `fm_find_records` — search records using FileMaker find syntax
- `fm_get_record` — fetch one record by recordId
- `fm_create_record` — create a new record (writes to DB — use carefully)

---

## Troubleshooting

**"Ping my FileMaker database" returns "I don't have access to FileMaker tools"**
MCP didn't load. Check:
- `claude_desktop_config.json` is valid JSON (run the `python3 -m json.tool`
  validation above).
- Path in `args` matches your actual location — verify with
  `ls "/Users/<MAC_USERNAME>/FileMaker MCP/server.js"`.
- You fully quit Claude Desktop before editing AND relaunched after.
- You're in a NEW chat, not continuing an old one.

**`FileMaker login failed (212)`**
Password mismatch between FileMaker and `claude_desktop_config.json`.
Re-set the password via File → Manage → Security and update both places.

**`FileMaker API error (9): insufficient privileges`**
Privilege set on the MCP account isn't right. Go back to Step 2.4.

**Module not found errors on startup**
You skipped `npm install`. `cd ~/FileMaker\ MCP && npm install`.

**Everything else**
Check the Claude Desktop logs:
`~/Library/Logs/Claude/mcp-server-filemaker.log` — the actual error is at
the bottom. Send the relevant lines to the admin.

---

## Notes

- **Your activity is audited under `<MCP_HANDLE>`**, not a shared account.
  Adding write tools later won't change that.
- **`server.js` updates** come from Steve when he adds new tools. Drop the
  new version into `~/FileMaker MCP/` and quit/relaunch Claude Desktop.
- **Don't share your password.** It's scoped to you so audit logs work.
  If it gets exposed: rotate via File → Manage → Security → pencil icon
  on `<MCP_HANDLE>`, update `FM_PASSWORD` in `claude_desktop_config.json`,
  quit/relaunch.
