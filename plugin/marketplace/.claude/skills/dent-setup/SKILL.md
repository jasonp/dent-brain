---
name: dent-setup
description: |
  Guided first-run setup for the dbrain fork — walks the admin through
  customizing this fork for their organization, provisioning Supabase
  + Railway + the GitHub deploy key, and getting the plugin installed
  in Cowork. Mirrors the gbrain/gstack model of "run setup once, get
  walked through every decision."

  **Runtime: Claude Code Desktop only** (clones the repo, writes config
  files, calls `gh`/`supabase`/`railway` CLIs, generates SSH keys). See
  `docs/reference/runtime-conventions.md`.
triggers:
  - "dent-setup"
  - "set up dbrain"
  - "configure dent-brain"
  - "first time setup"
  - "fork dbrain for my org"
tools:
  - get_health
  - get_stats
mutating: true
writes_pages: false
---

# /dent-setup

Admin-only first-run setup. Walks the human through:

1. **Customize the fork** — runs `bun run setup` to ask org_prefix, org_name, server_url, data_repo and rewrite the manifest + rebuild the plugin marketplace.
2. **Provision the markdown data repo** — create the GitHub repo that holds entity pages.
3. **Provision Supabase** — Postgres + pgvector for the retrieval index.
4. **Provision Railway** — runs the dbrain MCP server.
5. **Generate the deploy key** — SSH keypair so the server can write commits to the data repo.
6. **Set Railway env vars** — DATABASE_URL, DENT_BRAIN_DATA_DEPLOY_KEY, etc.
7. **Verify boot** — `/health` returns 0.x.0, boot logs show "scheduled-pull: every 300s".
8. **Install the Cowork plugin** — add the local marketplace + install the plugin so /dent-* slash commands work in Cowork.
9. **Run a smoke-test** — append an observation about a test entity, observe a real commit in the data repo within seconds.
10. **Onboard teammates** (optional) — run `/dent-onboard-teammate` for each.

Most steps require the admin to take action themselves (clicking through Railway/Supabase UIs, pasting env vars, running `git push`). The skill's job is to keep them on the rails — one step at a time, verify each, never let them skip ahead.

> **Read first:** `docs/dent-brain/SETUP.md` (full reference — this skill is the conversational layer over that doc).

---

## Inputs

This skill takes no arguments. The admin invokes it the first time they fork the repo, OR after the fork to keep the setup state visible.

---

## Protocol

### Phase 0. Detect setup state

Run these checks to figure out where the admin is:

- Is there a `plugin/manifest.local.json` (gitignored real deploy config)? If so, this deploy is already customized — read deploy values from there. The committed `plugin/manifest.json` ships placeholders by design, so seeing placeholders there does NOT mean un-customized.
- Failing that, does `plugin/manifest.json` show the default placeholder values, or has it been customized in place?
- Does `.claude-plugin/marketplace.json` exist (means the plugin has been built)?
- Is the MCP server reachable at the resolved `deploy.server_url` (from `manifest.local.json` if present, else `manifest.json`)? Try `curl -fsS <url>/health` — version + db status.
- Is there a `${prefix}-brain@${prefix}-brain` plugin in `claude plugin list`?

Surface a one-line status: "You're at step N of the 10-step setup. Last completed: <step>. Next: <step>."

If all 10 steps are done, congratulate them and ask if they want to onboard a teammate (which routes to /dent-onboard-teammate).

### Phase 1. Customize the fork

If `plugin/manifest.json` still has default `dent-*` values, prompt the admin to run `bun run setup` from the repo root. Do not run it for them — the setup script is interactive (asks 7 questions) and the admin should see the prompts.

After they say "done":

- Read `plugin/manifest.json` and confirm the new values.
- Verify `plugin/marketplace/` was rebuilt (timestamps newer than the manifest write).
- Tell them: "Commit and push the changes — your repo is now a real Cowork-installable marketplace at `github:<your-fork>`."

### Phase 2. Provision the markdown data repo

Walk through:

1. Create a new GitHub repo at the path they entered for `data_repo` (e.g., `github.com/<their-org>/dent-brain-data`). Repo can be private or public; the server's deploy key gives it write access regardless.
2. Add a minimal `README.md` and at least one `entities/people/<somebody>.md` seed page so the first sync has something to import. Suggest a content shape — frontmatter with `slug`, `title`, `type: person`, plus a one-line body.
3. Push the seed.

Verify by checking that `git ls-remote https://github.com/<data_repo>` returns at least `refs/heads/master` (or `main`).

### Phase 3. Provision Supabase

Point them at `docs/dent-brain/DEPLOY.md §1`. Walk through:

1. Create a Supabase project in their org's account.
2. Enable `vector` and `pg_trgm` extensions.
3. Copy the **Transaction pooler** DATABASE_URL.
4. Run gbrain migrations against it: `DATABASE_URL=… bun run src/cli.ts apply-migrations --yes`.
5. Create a bearer token: `DATABASE_URL=… bun run src/commands/auth.ts create <admin-handle>`.

Capture the DATABASE_URL and the bearer token as state for later steps. Do NOT write them to a file in the repo.

### Phase 4. Provision Railway + deploy

Point them at `docs/dent-brain/DEPLOY.md §2`. Walk through:

1. Create a Railway project, link to their GitHub fork.
2. Set env vars: `DATABASE_URL`, `NODE_ENV=production`, `DENT_BRAIN_DATA_REPO_URL=git@github.com:<data_repo>.git`.
3. Generate domain (or skip and use Railway's `*.up.railway.app`).
4. Trigger first deploy via `railway up` (or the GitHub integration if they have it working — note we know it's flaky for some accounts; CLI deploy is the reliable path).

The first deploy will FAIL at boot because `DENT_BRAIN_DATA_DEPLOY_KEY` isn't set yet — that's expected, set it in Phase 5.

### Phase 5. Generate + register the deploy key

Walk through `docs/dent-brain/DEPLOY.md §2.3.1`:

1. `ssh-keygen -t ed25519 -f /tmp/dent-deploy-key -N '' -C 'dent-server@railway'`
2. Add the public key (`/tmp/dent-deploy-key.pub`) to the data repo's GitHub Settings → Deploy keys with **Allow write access** checked.
3. Set the private key on Railway: `railway variables --set "DENT_BRAIN_DATA_DEPLOY_KEY=$(cat /tmp/dent-deploy-key)"`.
4. `rm /tmp/dent-deploy-key{,.pub}`.
5. Trigger Railway redeploy (`railway up --detach` from the fork repo).

Verify by polling `<server_url>/health` until version flips to the current dbrain version. Then check Railway deploy logs for `[dent-brain] data repo ready: …` and `[dent-brain] scheduled-pull: every 300s`.

### Phase 6. Verify boot end-to-end

With the bearer token from Phase 3:

```
curl -fsS -X POST <server_url>/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print([t["name"] for t in d["result"]["tools"]])'
```

Pass criteria:
- Both `markdown_append_to_page` and `markdown_replace_page` are in the list.
- `detect_entities` is present.
- The 4 evidence ops (append_evidence, get_evidence, quarantine_batch, get_provenance) are NOT present.

### Phase 7. Install the Cowork plugin

Two install paths — pick one:

**A. Cowork plugin install (canonical for teammates):**
- The admin opens a fresh Cowork chat and asks: *"Add a custom marketplace from `github:<their-code-repo>` and install the `dent-brain` plugin."*
- Cowork's plugin-management flow takes over — pulls the repo, registers the marketplace, installs the plugin. After Cmd+Q + Cowork relaunch + new chat, the slash commands appear.

**B. Code mode install (admin convenience):**
- `bash plugin/marketplace/install-local.sh` — registers the local `plugin/marketplace/` as a Code-mode marketplace. Doesn't reach Cowork; useful for admin debug iteration.

Verify both paths via `claude plugin list` (Code mode) and by typing `/` in a Cowork chat (slash commands appear).

### Phase 8. Smoke test

The admin runs `/dent-append-evidence` from Cowork against a known entity. Expected result:

- Cowork responds with a `commit_sha`.
- `git log` in the data repo (after `git pull`) shows a commit by `dent-brain-server <noreply@<email-domain>>` with message `agent: append entities/people/<slug>`.
- The new bullet appears in the markdown file.

### Phase 9. Onboard teammates

Optional. For each teammate:
- Run `/dent-onboard-teammate` — generates a per-user bearer token, produces a one-paste install command.
- Optionally walk them through the Cowork plugin install (Phase 7A) so they get the slash commands locally.

### Phase 10. Add ingestors (optional, Phase 5+ work)

Optional. Run `/dent-add-ingestor` to add a signal source (RegFox, Gmail, Granola, Dropbox). These are server-side workers that translate external signals into `markdown_append_to_page` calls. Not required for the brain to function — Cowork captures alone are useful — but they amplify the input pipeline.

---

## Anti-patterns

- **Do not skip Phase 5.** The server boots fine without `DENT_BRAIN_DATA_DEPLOY_KEY` but `markdown_*` writes fail with "context not initialized." The admin will think the brain is broken; really it's just the deploy key.
- **Do not commit secrets to the repo.** Tokens and DATABASE_URL go to Railway env vars, NOT plugin/manifest.json or any committed file. The admin's bearer token goes in their own `~/.claude.json` and Cowork config.
- **Do not push before running setup.** A pre-setup repo still has Dent's defaults (org_prefix=dent, server_url=dent-brain.example.com) baked into `plugin/manifest.json` AND `plugin/marketplace/`. Pushing without running `bun run setup` means Cowork installs would route to Dent's server with the wrong token.

---

## Tools used

- `get_health` — server reachability + version.
- `get_stats` — page count post-first-sync.
- (Phase 7+ relies on `claude` CLI and Cowork's UI — not server tools.)
