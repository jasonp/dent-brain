# FileMaker MCP — Install walkthrough

Custom MCP server (built by your FileMaker admin) that lets Claude Desktop query the CRM
directly via the FileMaker Data API. **Independent of dent-brain** — they
share Claude Desktop but nothing else. Installing one doesn't affect the
other.

This doc is written so a teammate can ask their Claude agent (Claude Code in Desktop, Cowork, or the CLI):

> *"Read https://github.com/your-org/dent-brain/blob/main/docs/dent-brain/FILEMAKER_MCP_INSTALL.md and walk me through the install. Pause at each question and wait for my answer."*

The agent fetches the page, walks through the steps, and pauses where
input is needed.

**Time required:** ~15 minutes.

**End state:** a FileMaker account scoped to the teammate (e.g. `mcp_alice`,
`mcp_bob`) running a local Node.js MCP server, wired into Claude Desktop.
Your agent can then ask the CRM things like "find people in the CRM whose
last name contains 'Smith'" in plain English.

---

## Operating principle for the agent

**Agent: do everything you possibly can on your own. Only stop and ask the user when you genuinely cannot proceed without them.**

You have a shell tool. Use it to run `node --version`, `which npm`, `npm install`, `curl` health checks, JSON validation, and the config edit. **Edit `claude_desktop_config.json` yourself** — don't paste a JSON snippet and ask the user to merge it manually. Read the file, parse it, splice in the `filemaker` entry, write it back, validate.

(This applies in particular to Claude Code in Claude Desktop, which has direct bash access to the user's laptop. If you're running in Cowork's sandbox instead, your shell can't reach the user's machine — fall back to copy-paste handoff for any command that touches `claude_desktop_config.json` or `~/Library/`.)

Things only the user can do:
- **Provide secrets** (the FileMaker password they just set).
- **Operate FileMaker Pro UI** (Manage Security → New Account, etc.).
- **Locate the `FileMaker-MCP-for-<handle>.zip` from the admin** (Slack, email, etc.).
- **Cmd+Q + relaunch Claude Desktop**.
- **Start a new chat** to verify the install (the current chat's tool registry is cached).
- **State preferences** (handle name for the FileMaker account).

Everything else: you run it.

---

## 0. What you'll need from the admin

Before starting, confirm with the admin (your deployment admin) that they've sent
you (via Slack/email/1Password share):

1. The **`FileMaker-MCP-for-<yourhandle>.zip`** archive — contains
   `server.js`, `package.json`, and a `README.md`. Your FileMaker admin produces this
   per-teammate.
2. Your **FileMaker handle** to use for the MCP account, e.g. `mcp_alice`,
   `mcp_bob`. Pick something stable; this becomes your audit-log identity
   inside the CRM.
3. Confirmation that a **`MCP Read And Edit Records` privilege set** exists
   in the CRM (your admin sets this up once for everyone).

If you don't have all three, stop and ask the admin before continuing.

---

## 1. Prerequisites

### Agent actions

1. **FileMaker Pro check** — ask the user: "Is FileMaker Pro installed and can you log into the CRM with a full-access account (your own named account, not `Guest`)?" If no, surface to the admin; you can't install FileMaker Pro for them.

2. **Node check** — run `node --version` yourself. Need Node 18+.
   - If 18+: ✅ continue silently.
   - If older or missing: run `brew install node` yourself. If `brew` is missing too, point the user at https://brew.sh and pause.

3. **npm check** — run `which npm` yourself. If it returns a path, ✅. If not, the Node install didn't include npm — re-run `brew install node`.

---

## 2. Create your FileMaker account

This step is FileMaker Pro UI only — your agent can't drive it. Walk the user through clearly, then verify in §3.

### Agent actions

1. Ask: **"What handle do you want for the FileMaker MCP account? Suggested: `mcp_<yourfirstname>` (e.g. `mcp_bob`, `mcp_jeff`). Pick something stable; this becomes your audit-log identity inside the CRM."** Save the answer as `<MCP_HANDLE>`.

2. Tell the user (in one message, not multiple back-and-forth):

> **In FileMaker Pro:**
>
> 1. Open the CRM, logged in as your full-access account.
> 2. **File → Manage → Security**.
> 3. Click **+ New** (bottom left).
> 4. Fill in:
>    - **Account Name:** `<MCP_HANDLE>`
>    - **Password:** click the pencil icon → set a strong one → save it in a password manager labeled `FileMaker MCP — the CRM`. You'll paste it back to me in a moment.
>    - **Require password change on next sign-in:** UNCHECKED (critical — checked breaks API login).
>    - **Active:** ✅
>    - **Privilege Set:** `MCP Read And Edit Records`
> 5. Click **OK** to close Manage Security.
> 6. FileMaker will prompt for full-access credentials to commit — enter your own full-access password.
>
> Tell me when you're done.

3. Wait for confirmation, then continue to §3.

---

## 3. Verify the account works via curl

### Agent actions

1. Ask the user: **"Paste the password you just set for `<MCP_HANDLE>` here. I'll use it to test the FileMaker API auth and then to write the Claude Desktop config — I won't display it back to you and it stays in this session only."**

2. Wait for the password. Save it as `<FM_PASSWORD>` for §3 and §5.

3. Run the curl yourself, substituting the values. **Keep the single quotes around `-u`** so passwords with `!`, `$`, or backticks don't get mangled by the shell:

   ```bash
   curl -s -X POST https://sea-17.fmsdb.com/fmi/data/v1/databases/the CRM2025/sessions \
     -H "Content-Type: application/json" \
     -u '<MCP_HANDLE>:<FM_PASSWORD>' \
     -d '{}'
   ```

4. Parse the response:
   - **`code: 0, message: OK`** with a `token` field → ✅ continue to §4.
   - **`code: 212`** → password mismatch. Tell the user, ask them to re-paste the password (they may have a typo). Retry.
   - **`code: 9`** → privilege set is wrong on the account. Tell the user to go back to §2 and re-verify the `MCP Read And Edit Records` privilege set is selected.
   - **SSL / connection refused** → network issue. Surface to the user; route to admin.

Don't proceed until you see `code: 0`.

---

## 4. Install the MCP server

### Agent actions

1. Ask the user: **"Where is the `FileMaker-MCP-for-<yourhandle>.zip` from the admin? Give me its full path (e.g. `~/Downloads/FileMaker-MCP-for-robin.zip`). If you don't have it yet, ping the admin and pause."**

2. Run the unzip and install yourself, substituting `<ZIP_PATH>`:

   ```bash
   mkdir -p ~/"FileMaker MCP"
   unzip -o <ZIP_PATH> -d ~/"FileMaker MCP"
   ls ~/"FileMaker MCP"
   ```

   Expected: `server.js`, `package.json`, `README.md` (and possibly more). Confirm the three core files exist before moving on.

3. Install dependencies:

   ```bash
   cd ~/"FileMaker MCP" && npm install
   ```

   ~20s. "added N packages" is success. Deprecation warnings are normal — ignore. If the install errors, surface to the user.

---

## 5. Wire into Claude Desktop

This is a config-file merge, not a "tell the user to edit JSON manually" step. **Edit the file directly.**

### Agent actions

1. Tell the user: **"I'm about to edit your `claude_desktop_config.json` to add the FileMaker entry. I'll back up the existing file first to `~/.dent-brain/backups/`. You'll need to Cmd+Q Claude Desktop completely after I finish — confirm when you're ready and I'll proceed."**

2. Once the user confirms, run a Python block (yourself, via your shell tool) that:
   - Backs up the existing config to `~/.dent-brain/backups/claude_desktop_config.json.<timestamp>.bak`
   - Reads the JSON
   - Splices the `filemaker` entry into `mcpServers` (creating the block if missing, preserving any other entries like `dent-brain`)
   - Writes back with valid JSON
   - Validates the result

   Substitute `<MCP_HANDLE>` and `<FM_PASSWORD>` with values from earlier sections:

   ```bash
   FM_USER='<MCP_HANDLE>' FM_PASS='<FM_PASSWORD>' python3 <<'PY'
   import json, os, shutil, time
   HOME = os.path.expanduser("~")
   cfg_path = os.path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
   bk_dir = os.path.join(HOME, ".dent-brain", "backups")
   os.makedirs(bk_dir, exist_ok=True)
   stamp = time.strftime("%Y%m%d-%H%M%S")

   if os.path.exists(cfg_path):
       shutil.copy(cfg_path, os.path.join(bk_dir, f"claude_desktop_config.json.{stamp}.bak"))
       with open(cfg_path) as f: cfg = json.load(f)
   else:
       os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
       cfg = {}

   cfg.setdefault("mcpServers", {})
   cfg["mcpServers"]["filemaker"] = {
       "command": "node",
       "args": [os.path.join(HOME, "FileMaker MCP", "server.js")],
       "env": {
           "FM_HOST": "sea-17.fmsdb.com",
           "FM_DATABASE": "the CRM2025",
           "FM_USERNAME": os.environ["FM_USER"],
           "FM_PASSWORD": os.environ["FM_PASS"],
       },
   }

   with open(cfg_path, "w") as f:
       json.dump(cfg, f, indent=2)
       f.write("\n")
   with open(cfg_path) as f: json.load(f)  # validate
   print(f"wrote: {cfg_path}")
   PY
   ```

3. Validate explicitly after the write:

   ```bash
   python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo "VALID JSON ✓"
   ```

4. If validation fails: restore the backup, surface the error, route to admin.

5. On success, tell the user: **"Config updated. Now Cmd+Q Claude Desktop completely and relaunch. Tell me when you're back."**

---

## 6. Test it

Your agent can't test the install from the current chat (tool registry was cached at chat-start, before FileMaker MCP was wired up — same caveat as the dent-brain install). User has to start a new chat to verify.

### Agent actions

1. Tell the user: **"Open a NEW chat (Claude Code or Cowork) and ask: *'Ping my FileMaker database.'* Tell me whether it returns a JSON blob with `ok: true` or whether it errors."**

2. Wait for confirmation. On success, response should include:
   ```json
   {
     "ok": true,
     "host": "sea-17.fmsdb.com",
     "database": "the CRM2025",
     "username": "<MCP_HANDLE>",
     "tokenPreview": "a1b2c3d4…"
   }
   ```

3. On `ok: true` → ✅ done. Suggest follow-up tests they can try in that new chat:
   - *"What layouts are in my FileMaker database?"*
   - *"Find people in the CRM whose last name contains 'Smith'."*

4. On error → triage via the troubleshooting section below.

---

## Available tools

Once installed, Your agent can call these against the CRM:

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
- **`server.js` updates** come from your FileMaker admin when they add new tools. Drop the
  new version into `~/FileMaker MCP/` and quit/relaunch Claude Desktop.
- **Don't share your password.** It's scoped to you so audit logs work.
  If it gets exposed: rotate via File → Manage → Security → pencil icon
  on `<MCP_HANDLE>`, update `FM_PASSWORD` in `claude_desktop_config.json`,
  quit/relaunch.
