# Dent Brain — Teammate install walkthrough

This doc is written so a teammate can paste the URL into a fresh Claude
Code session in Claude Desktop and say:

> *"Read https://github.com/jasonp/dent-brain/blob/main/docs/dent-brain/TEAMMATE_INSTALL.md and walk me through the install step by step. Pause at each question and wait for my answer."*

Your Claude agent will fetch this page, parse the conditional branches, and
guide you through. Each `### Agent prompt` block is a pause-point: the
agent asks you, you answer, the agent branches accordingly.

You can also read this top-to-bottom yourself and follow it manually. The
sections are numbered so you don't lose your place.

---

## Operating principle for the agent

**Agent: do everything you possibly can on your own. Only stop and ask the user when you genuinely cannot proceed without them.**

You have a shell tool. Use it. When this doc shows a command, **run it yourself** — capture the output, decide what to do next, and continue. Do not paste commands into chat and tell the user to "run this in Terminal" if you can run them directly. (This applies in particular to Claude Code in Claude Desktop, which has direct bash access to the user's laptop. If you're running in Cowork's sandbox instead, your shell can't reach the user's machine — fall back to copy-paste handoff for any command that touches `~/.claude.json`, launchd, or `~/Library/`.)

Things only the user can do (these are the legitimate pause-points):

- **Provide a secret** (bearer token from the admin, FileMaker password). Secrets aren't in the chat history; the user has to type them.
- **Click a UI dialog outside Terminal**: the macOS `xcode-select --install` popup, FileMaker Pro's Manage Security window, GitHub's "Accept Invitation" button, the Claude Desktop quit/relaunch (Cmd+Q), the Customize-panel UI clicks for installing the plugin marketplace, and the new session needed to verify install (the current session caches its tool registry).
- **State a preference**: where to clone the data repo, what handle to use for the FileMaker MCP account, yes/no on optional sections (FM MCP, hand-edit mode, granola-sync).
- **Confirm an ambiguous output**: when a command's exit is non-zero or the result is unexpected, show the user and ask before guessing.

Everything else — `git --version`, `brew install node`, reading and writing JSON config, running the Python install block, `git clone`, `npm install`, `curl` health checks — **you run yourself**. The user shouldn't have to copy-paste between windows unless their judgment or their hands are required.

When you do need user input, ask one clean question and wait. Don't bundle "open Terminal AND run this AND tell me what it says" — just run it yourself and report.

---

> **You'll need from your admin** three things, delivered together via your
> agreed secure channel (Slack DM, encrypted email, 1Password share). The
> admin's `/dent-onboard-teammate` skill produces all three in one message:
>
> 1. **Bearer token** — looks like `gbrain_<long-string>`. Authenticates
>    you to the MCP server. Tied to your name in the audit log.
> 2. **Server URL** — the MCP endpoint, e.g.
>    `https://dent-brain.dentthefuture.com/mcp` (varies per deployment).
> 3. **Marketplace URL** — the GitHub repo for the plugin, e.g.
>    `https://github.com/jasonp/dent-brain` (varies per deployment).
>
> If you don't have all three, stop and ask the admin before starting Section 3.

---

## 0. What this gets you

By the end of this walkthrough you'll have:

- The **dent-brain MCP connector** registered in Claude Desktop, so your
  Claude sessions can search the brain, log observations, and update
  entity pages. Both Claude Code and Cowork sessions will see it.
- The **dent-brain plugin** installed in Claude Code, giving you the
  `/dent-*` slash commands (`/dent-append-evidence`, `/dent-enrich`,
  `/dent-resolve-entity`, `/dent-extensions`, etc.).
- (Optional) A **local clone of `dent-brain-data`** so you can hand-edit
  entity pages in your code editor instead of dictating to your agent.
- (Optional) **FileMaker MCP** wired up so your agent can also query
  DentCRM directly — separate from dent-brain, but they compose nicely.
- (Optional) **granola-sync extension** running hourly on your laptop,
  pushing your Dent meeting notes into the brain automatically.

You will **not** need to install Postgres, Bun (until granola-sync), or
Railway. Those run on the dent-brain server (Railway → Supabase). You
only talk to the server via MCP.

> **Two surfaces, one install for the connector — separate installs for the plugin.**
>
> The MCP **connector** lives in Claude Desktop's config files and is
> visible to BOTH Claude Code mode and Cowork sessions after one install.
> The **plugin** lives in each surface's separate plugin store and must be
> installed once per surface you want to use it in. This walkthrough
> installs the plugin in Claude Code (the Code mode tab in Claude
> Desktop). If you also want it in Cowork, repeat Section 5 there too.

---

## 1. Prerequisites

### Agent actions

1. **OS check** — run `uname -s` yourself. If it returns `Darwin`, ✅ continue. If anything else, tell the user this guide is Mac-only today and to ping the admin.

2. **Claude Desktop check** — ask the user: "Is Claude Desktop installed and are you signed in?" (You can't detect this from the shell reliably.) If no, point them at https://claude.ai/download and pause until they confirm.

3. **Git check** — run `git --version` yourself.
   - If it prints a version number: ✅ continue silently.
   - If `xcode-select: error: …` or `command not found`: run `xcode-select --install` yourself. This opens a macOS dialog the user must click through — tell the user "I just kicked off the Xcode Command Line Tools install. A popup should have appeared on your screen — click Install and accept the license. Tell me when it's finished." Then re-run `git --version` to confirm.
   - If still broken after Xcode CLT: try `brew install git` yourself. If `brew` is also missing, tell the user to install Homebrew from https://brew.sh and pause.

4. **Node check** — run `node --version` yourself. Need Node 18+.
   - If 18+: ✅ continue silently.
   - If older or missing: run `brew install node` yourself. Capture the output. If `brew` is missing, escalate to the user as above. (Why Node: the Cowork-mode MCP bridge uses `npx mcp-remote` which needs Node 18+.)

Don't list every check in chat — run them silently and only surface results when something needs fixing.

---

## 2. FileMaker MCP — optional precheck

DentCRM lives in FileMaker. There's a separate MCP server (built by Steve)
that lets your agent query the CRM directly. It's optional and totally
independent of dent-brain — they share Claude Desktop but nothing else.

### Agent prompt

Ask the user: **"Do you already have FileMaker MCP set up? (yes / no)"**

- **If yes:** ✅ Skip to Section 3.

- **If no:** Ask: **"Do you want to set up FileMaker MCP now, or later? (now / later)"**

  - **If later:** Note it and continue to Section 3. No dent-brain
    prerequisite depends on FM MCP — they're fully independent. The user
    can come back to this section any time.

  - **If now:** Switch to the FileMaker MCP install walkthrough at
    https://github.com/jasonp/dent-brain/blob/main/docs/dent-brain/FILEMAKER_MCP_INSTALL.md
    and walk through it. The user will need from the admin:
    1. The `FileMaker-MCP-for-<yourhandle>.zip` archive (Steve produces
       this per-teammate).
    2. Confirmation that the `MCP Read And Edit Records` privilege set
       exists in DentCRM.
    Once FM MCP is verified working (the `fm_ping` test in §6 of that
    doc returns `ok: true`), come back here and resume from Section 3.

The two MCP servers do NOT share auth, config, or data. Your agent sees
both connectors side-by-side and routes queries to whichever fits.

---

## 3. Install the dent-brain MCP connector

The admin issues you a personal **bearer token** that authenticates your
Claude Desktop to the dent-brain server. The token is your identity in
the audit log — every search, query, and observation you make is tagged
with the token's handle.

### 3a. Get the install bundle from the admin

### Agent prompt

Ask the user: **"Has the admin sent you the install bundle? It contains three things: a bearer token (looks like `gbrain_<long-string>`), the server URL (looks like `https://...mcp`), and the marketplace URL (a GitHub repo URL). Check Slack, encrypted email, or wherever you've agreed to receive secrets."**

- **If no:** Stop. Tell the user to ask the admin to run their teammate-onboard skill with the user's handle. The admin will send back all three values in one message.

- **If yes:** Continue.

### 3b. Paste the bundle into this session

Ask for all three at once so the user can paste them in one shot.

### Agent prompt

Tell the user: **"Paste the three values here, each on its own line and prefixed with the label, like this:**
>
> ```
> token: gbrain_xxxxxxxxxxxx
> server: https://your-brain.example.com/mcp
> marketplace: https://github.com/your-org/your-brain
> ```
>
> **Don't share these anywhere else. The token in particular is tied to your name in the audit log."**

Parse what the user pastes and save:
- `<TOKEN>` — must start with `gbrain_` and have ≥ 20 chars total. Reject and ask again if it doesn't.
- `<SERVER_URL>` — must start with `https://` and end with `/mcp`. Reject and ask if it doesn't.
- `<MARKETPLACE_URL>` — must be a GitHub URL like `https://github.com/<org>/<repo>`. Reject and ask if it doesn't.

Hold all three: token + server URL for §3c, marketplace URL for §5.

### 3c. Run the install yourself

Don't paste the install command into chat for the user to copy. **Run it yourself** via your shell tool. Substitute `<TOKEN>` and `<SERVER_URL>` with the values the user just provided, and execute:

```bash
TOKEN="<TOKEN>" URL="<SERVER_URL>" python3 <<'PY'
import json, os, shutil, time
HOME = os.path.expanduser("~")
TOKEN = os.environ["TOKEN"]; URL = os.environ["URL"]

bk_dir = os.path.join(HOME, ".dent-brain", "backups")
os.makedirs(bk_dir, exist_ok=True)
stamp = time.strftime("%Y%m%d-%H%M%S")

def patch(path, entry):
    if os.path.exists(path):
        shutil.copy(path, os.path.join(bk_dir, f"{os.path.basename(path)}.{stamp}.bak"))
        with open(path) as f: cfg = json.load(f)
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cfg = {}
    cfg.setdefault("mcpServers", {})
    cfg["mcpServers"]["dent-brain"] = entry
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    with open(path) as f: json.load(f)
    print(f"  wrote: {path}")

# Claude Code (CLI + Desktop's Code mode tab): ~/.claude.json — HTTP-type entry
patch(
    os.path.join(HOME, ".claude.json"),
    {"type": "http", "url": URL, "headers": {"Authorization": f"Bearer {TOKEN}"}},
)

# Cowork mode + classic Desktop chats: claude_desktop_config.json — stdio bridge
patch(
    os.path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    {
        "command": "npx",
        "args": ["-y", "mcp-remote", URL, "--header", f"Authorization: Bearer {TOKEN}"],
    },
)

print("\nDone. Backups saved to ~/.dent-brain/backups/")
PY
```

The block writes the dent-brain MCP entry into BOTH config files — `~/.claude.json` (read by Claude Code) and `~/Library/Application Support/Claude/claude_desktop_config.json` (read by Cowork). One install, both surfaces work. Backs up existing configs first (timestamped, in `~/.dent-brain/backups/`).

Capture the output. If it ends with `Done. Backups saved...`, ✅ continue. If it errors:
- Show the user the error.
- Reassure them the previous configs are in `~/.dent-brain/backups/` — nothing is lost.
- Offer to restore the most recent backup, or ping the admin with the error.

When the install succeeds, tell the user: **"I've registered dent-brain in your Claude Desktop config. Next, you need to quit Claude Desktop completely (Cmd+Q) and relaunch — this is something only you can do. Tell me when you've done it."**

### 3d. Restart Claude Desktop

**Cmd+Q** Claude Desktop completely. Don't just close the window — fully
quit. Then relaunch.

> ⚠️ Tool registries are cached **per-session**. After the relaunch, start a
> brand-new chat (Code mode or Cowork). The session you were in
> won't see dent-brain even though the connector is now wired up.

---

## 4. Verify the MCP connector

This step requires a fresh session (the current session's tool registry was cached at chat-start, before dent-brain was installed). Only the user can start a new chat.

### Agent actions

1. Run a JSON-validity check on the configs you just wrote:
   ```bash
   python3 -m json.tool ~/.claude.json > /dev/null && echo "claude.json VALID ✓"
   python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo "claude_desktop_config.json VALID ✓"
   ```
   If either fails, the install is broken — restore the matching backup from `~/.dent-brain/backups/` and surface the error to the user.

2. Ask the user: **"Open a new Claude Code session in Claude Desktop (the current session won't see dent-brain because tool registries cache per-chat). Once you're in the new session, ask: 'Use dent-brain to call get_stats and tell me what's in there.' Then come back here and tell me whether it worked or paste the error."**

3. Wait for the user to confirm. If they say it worked: ✅ continue to §5. If they say it failed:
   - "I don't see any dent-brain tools" → confirm they really started a new chat (the most common cause), confirm they Cmd+Q'd Claude Desktop (the second most common cause).
   - Any other error → ask them to paste it here, then route to admin.

---

## 5. Install the dent-brain plugin in Claude Code

The connector gives the brain's *tools*. The **plugin** gives the `/dent-*`
slash commands that orchestrate those tools.

The plugin install is **UI-only** — it can't be done by typing a prompt
into a chat, and there's no shell command that installs plugins. The user
has to click through Claude Desktop's Customize panel. After they finish,
the agent can verify the install via the filesystem.

> **Two-surface caveat.** Claude Code (the Code mode tab in Claude Desktop,
> plus the standalone CLI) has its own plugin store at `~/.claude/plugins/`.
> Cowork has a separate plugin store. **Installing the plugin in Claude Code
> does NOT install it in Cowork**, and vice versa. This walkthrough installs
> in Claude Code. If you also want the plugin in Cowork, repeat the steps
> below in a Cowork session — same UI, separate install.

### Agent actions

1. Walk the user through the UI clicks. Send this in one message (don't
   drip-feed; they need to follow it sequentially):

   Substitute `<MARKETPLACE_URL>` with the marketplace URL the user pasted in §3b:

   > **In Claude Desktop, with a Claude Code session open:**
   >
   > 1. Click **Customize** on the left sidebar.
   > 2. Next to **Personal plugins**, click the **+** icon.
   > 3. Click **Add marketplace**.
   > 4. Paste this URL into the field:
   >
   >    ```
   >    <MARKETPLACE_URL>
   >    ```
   >
   > 5. Confirm whatever Claude shows next (it should pull the marketplace
   >    manifest and offer to install the `dent-brain` plugin). Accept the
   >    install.
   >
   > Tell me when Claude confirms the install.

2. Wait for the user to confirm.

3. Tell the user: **"Now Cmd+Q Claude Desktop completely and relaunch.
   The plugin needs a fresh tool registry to load. Tell me when you're
   back."** (Two restarts total across the whole walkthrough: one for the
   connector in §3, one for the plugin here.)

4. Verify the install yourself via the filesystem. Claude Code's plugin
   store lives at `~/.claude/plugins/` — the registry is `installed_plugins.json`
   (keyed by `<marketplace>@<plugin>`) and the unpacked content is in
   `cache/<marketplace>/<plugin>/<version>/`.

   Check the registry first:
   ```bash
   python3 -c "import json,sys; d=json.load(open('${HOME}/.claude/plugins/installed_plugins.json')); k='dent-brain@dent-brain'; v=d.get('plugins',{}).get(k); print(v[0]['installPath'] if v else 'NOT installed')"
   ```
   - Prints a path like `/Users/<you>/.claude/plugins/cache/dent-brain/dent-brain/0.34.0` → ✅ install landed.
   - Prints `NOT installed` → surface to the user; ask them to retry the UI steps (a click may have been missed, or they may have pasted the wrong URL).

5. Verify the prefix is `dent`. Use whatever path the registry reported (versions change over time, so don't hardcode):
   ```bash
   INSTALL_PATH=$(python3 -c "import json; d=json.load(open('${HOME}/.claude/plugins/installed_plugins.json')); print(d['plugins']['dent-brain@dent-brain'][0]['installPath'])")
   ls "$INSTALL_PATH/.claude/skills/" 2>/dev/null
   ```
   Expected folders: `dent-append-evidence`, `dent-enrich`,
   `dent-resolve-entity`, `dent-onboard-teammate`, `dent-setup`,
   `dent-add-ingestor`, `dent-extensions`. If you see `acme-*` or literal
   `{{prefix}}-*` folders, the marketplace template wasn't processed
   during the admin's build step — escalate.

6. Ask the user to verify the slash commands appear in a NEW chat:
   **"Open a new Claude Code session in Claude Desktop (the one you just
   used will have the tool list cached from before the restart), type `/`
   and look at the suggestions. You should see `/dent-append-evidence`,
   `/dent-enrich`, `/dent-resolve-entity`, `/dent-extensions`, etc.
   Confirm the prefix is `dent`."**

7. Final smoke test — ask the user: **"Type `/dent-append-evidence
   remember that I successfully installed dent-brain on <today's date>`
   and tell me what it returns."** A confirmation that an observation
   was logged means the connector + plugin + write path are all live
   end-to-end.

---

## 6. (Optional) Hand-edit mode — clone `dent-brain-data`

This step is for teammates who want to edit markdown pages directly in a
code editor (VS Code, Cursor, Sublime, vim, whatever). **Skip this entire
section** if you only plan to interact with the brain through Claude.

### Agent prompt

Ask: **"Do you want to be able to hand-edit markdown pages in a code editor? (yes / no)"**

- **If no:** Skip to Section 7. Claude-only is fine; the brain works
  identically either way.

- **If yes:** Continue.

### Agent actions

1. **Confirm collaborator access** — ask the user: **"Check your email for a GitHub invite to `dentthefuture/dent-brain-data`. If you have one, accept it now and tell me. If you don't, the admin needs to add you — ping them and pause here."**

2. **Pick a location for the clone** — ask: **"Where do you usually keep your code repos? Common conventions: `~/gh/<org>/`, `~/code/`, `~/dev/`, `~/Documents/GitHub/`. Or pick a custom path. Default if no preference: `~/gh/dentthefuture/`."** Wait for their answer.

3. **Ask for git identity** — ask: **"What full name and email should commits be attributed to? (Usually your real name and your dentthefuture.com email if you have one.)"**

4. **Run the clone yourself** — substitute `<BASE_PATH>`, `<NAME>`, `<EMAIL>` with the user's answers and run:

   ```bash
   mkdir -p <BASE_PATH>
   cd <BASE_PATH>
   git clone git@github.com:dentthefuture/dent-brain-data.git
   cd dent-brain-data
   git config --local user.name "<NAME>"
   git config --local user.email "<EMAIL>"
   git remote -v
   ```

   Capture output. On success, `git remote -v` should show two `origin` lines for `dentthefuture/dent-brain-data.git`.

5. **Handle SSH failures** — if `git clone` fails with `Permission denied (publickey)`:
   - The user's GitHub account may not have an SSH key registered, OR
   - The collaborator invite isn't accepted yet.

   Fall back to HTTPS yourself:
   ```bash
   git clone https://github.com/dentthefuture/dent-brain-data.git
   ```
   The first push will prompt for GitHub credentials — that's a Terminal interaction the user has to handle, but the clone itself doesn't need auth for a public-or-collaborator repo.

6. **Confirm to the user**: **"Cloned successfully to `<BASE_PATH>/dent-brain-data`. The full edit/commit/push workflow is documented in TEAMMATE_GUIDE.md — pull before you edit, push when you're done, server picks up changes within ~5 minutes."**

### What's in the repo

Pages live under:

- `entities/people/<slug>.md` — individual humans
- `entities/audience/<slug>.md` — email-list contacts (Mailchimp etc.) who haven't engaged with Dent events
- `entities/companies/<slug>.md` — orgs
- `entities/projects/<slug>.md` — initiatives + specific events
- `meetings/YYYY-MM-DD-<slug>.md` — meeting notes
- `meetings/YYYY-MM-DD-<slug>--transcript.md` — raw transcripts (granola-sync writes these)

For the full edit/commit/push workflow + conflict resolution + what NOT
to edit, read **`docs/dent-brain/TEAMMATE_GUIDE.md` § Mode 2** in this
same repo. That doc is the canonical reference for hand-editing; this
walkthrough only handles the install.

---

## 7. (Optional) Install local extensions — granola-sync

dent-brain extensions are per-teammate ingestors that run on your laptop
and push signal into the brain automatically. The flagship today is
**granola-sync** — an hourly daemon that pulls meetings from the Granola
public API (you'll mint an API key during install), filters for Dent
meetings, and pushes notes + transcripts to the brain.

### Agent prompt

Ask: **"Want to install granola-sync now? It's the daemon that auto-syncs your Granola meeting notes into Dent Brain hourly. (yes / skip)"**

- **If skip:** Continue to Section 8. You can install it later by typing
  `/dent-extensions` in any Claude Code session.

- **If yes:** Continue.

### Agent actions

1. **Clone the dent-brain repo** if it isn't already cloned. The extensions
   tooling lives in the code repo (separate from the data repo). Default
   location `~/gh/dent-brain`:

   ```bash
   if [ ! -d ~/gh/dent-brain ]; then
     mkdir -p ~/gh && cd ~/gh && git clone git@github.com:jasonp/dent-brain.git
   else
     cd ~/gh/dent-brain && git pull --ff-only origin main
   fi
   ```

2. **Hand off to the `/dent-extensions` skill** — tell the user:

   > "I'll switch to the `/dent-extensions` skill which handles the
   > extension install. Just type `/dent-extensions` in a new line, or
   > say 'install granola-sync' and I'll route you there."

3. The `/dent-extensions` skill then walks the v0.39 recipe lifecycle:
   - **install** — verifies prereqs (Bun, Granola.app, Granola
     permissions, dent-brain clone) and runs `tools/granola-sync/install.sh`,
     which stages plumbing into `~/.dent-brain/granola-sync/`. The daemon
     is provably inert at this point (no `user/filter.ts`, no launchd
     bootstrap).
   - **setup** — interviews you about which meetings should reach the
     brain and writes `~/.dent-brain/granola-sync/user/filter.ts`
     accordingly (starting point: `recipe/filter.example.ts`).
   - **preview** — `dent-extensions preview granola-sync` runs the
     daemon once in dry-run mode against recent Granola notes so you
     can verify the filter before going live. No writes to the brain.
   - **arm** — `dent-extensions arm granola-sync` bootstraps launchd
     and verifies first real sync via `tail` on the log. Refuses
     without `user/filter.ts`.

The skill walks through everything else. See `tools/granola-sync/README.md`
in this repo for what gets written where, and `tools/extensions/README.md`
for the broader extensions framework.

---

## 8. You're done

✅ MCP connector live (verified by `get_stats`).
✅ dent-brain plugin installed in Claude Code (verified by `/dent-*` slash commands appearing).
✅ Optional: data repo cloned for hand-edit mode.
✅ Optional: FileMaker MCP set up (or noted for later).
✅ Optional: granola-sync running hourly (or noted for later).

### Heads-up

- **Don't share your bearer token.** It's tied to your name in the audit
  log. Each MCP request is logged with the token's handle, so we can see
  what each person is querying without it being surveillance — it's just
  operational hygiene.
- **If you switch machines:** ping the admin for a fresh token. Don't
  copy tokens between machines.
- **If a session says "I don't see dent-brain tools":** start a
  brand-new chat. Tool registries cache per-chat and old chats won't see
  newly-installed connectors even after a Claude Desktop restart.
- **If you want the plugin in Cowork too:** the plugin install in §5 only
  registered the plugin in Claude Code's store. Cowork has a separate
  plugin store. To use the `/dent-*` slash commands in Cowork, repeat
  the §5 Customize-panel steps from a Cowork session — the same
  marketplace URL, same install flow, separate store.
- **Backups of your previous Claude config** are in `~/.dent-brain/backups/`.
  If anything ever breaks, restoring is one shell command. Show the admin
  if you need help.

### What to try first

In a Claude Code session:

> *"Use dent-brain to search for 'Steve' and tell me what we know."*

Then:

> *"/dent-append-evidence remember that I'm now set up on dent-brain as of `<today>`."*

Then ask in a fresh query 5 minutes later:

> *"What did I record about myself today?"*

The bullet should surface — proof that writes round-trip through git +
Postgres re-sync end-to-end.

---

## Reference

- **Server URL** — the value the admin sent you (looks like
  `https://your-brain.example.com/mcp`). Lives at rest in your
  `~/.claude.json` and `~/Library/Application Support/Claude/claude_desktop_config.json`
  under the `dent-brain` `mcpServers` entry — your agent can read those
  files to remind you what it is.
- **Marketplace URL** — the value the admin sent you (looks like
  `https://github.com/<org>/<repo>`). Same source as above; recorded in
  `~/.claude/plugins/known_marketplaces.json` for Claude Code, separately
  in Cowork's store if you also installed there.
- **Data repo** — `<server-org>/<server-org>-brain-data`. The admin's
  invitation email shows the exact URL.
- **Post-install reference**: `docs/dent-brain/TEAMMATE_GUIDE.md` (in
  the same code repo as this walkthrough).
- **Extensions reference**: `tools/extensions/README.md` and
  `tools/granola-sync/README.md` (same repo).
