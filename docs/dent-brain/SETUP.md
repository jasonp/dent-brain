# dbrain — fork-and-deploy setup

End-to-end guide for taking a clean fork of this repo and standing up your
organization's brain. Mirrors the gbrain/gstack model: run the setup
script, follow the steps, end with a working brain you and your teammates
can use from Cowork.

> **In a hurry?** The TL;DR is at the bottom (§9). Read § §1-§8 the first
> time so you understand what each step is doing.

---

## 1. Prerequisites

You need:

- **GitHub** account + admin access to a (new or existing) GitHub
  organization where you'll host two repos:
  1. Your **fork of this repo** (the dbrain code, e.g.
     `acme/acme-brain`).
  2. A **markdown data repo** (where entity pages live, e.g.
     `acme/acme-brain-data`).
- **Supabase** account. Free tier is fine for under ~5k entities.
- **Railway** account. ~$5/mo for a usually-idle service.
- **Claude Desktop** installed locally on every teammate's machine that
  will use Cowork.
- **Bun** ≥ 1.3 installed locally on the admin's machine
  (`brew install oven-sh/bun/bun`).
- **The `claude` CLI** on PATH — comes with Claude Code (`claude --version`).
- **The `railway` CLI** on PATH — `brew install railway`.
- **The `gh` CLI** on PATH — `brew install gh`.

If you're not the admin (you're a teammate joining an existing brain),
you don't need any of this. The admin runs `/{{prefix}}-onboard-teammate`
and gives you a one-paste install command. See `TEAMMATE_GUIDE.md`.

---

## 2. Fork the repo + run setup

```bash
# Fork via GitHub UI: github.com/jasonp/dent-brain → Fork → into your org.
# Or via gh CLI:
gh repo fork jasonp/dent-brain --clone --remote --org acme \
  -- --remote-name origin
cd dent-brain   # whatever the local clone is named

# Run the interactive setup. It asks 7 questions and rewrites the
# manifest + rebuilds the plugin marketplace.
bun install
bun run setup
```

The setup script asks:

| Question | Example |
|---|---|
| Org prefix | `acme` (lowercase, becomes `/acme-append-evidence`, etc.) |
| Org full name | `Acme, Inc.` |
| Org email domain | `acme.com` |
| Deploy id | `acme-brain-prod` |
| MCP server URL | `https://acme-brain.acme.com/mcp` (you'll set up the deployment in §3-4; pick the URL now) |
| Markdown data repo | `github.com/acme/acme-brain-data` |
| Code repo (this fork) | `acme/acme-brain` (auto-detected from `git remote get-url origin`) |

After setup runs, you'll see:

```
✓ wrote plugin/manifest.json
✓ renamed skills/dent/ → skills/acme/
Running plugin build...
  built: acme-append-evidence
  built: acme-enrich
  built: acme-resolve-entity
  built: acme-onboard-teammate
  built: acme-setup
  built: acme-add-ingestor
Built marketplace 'acme-brain' with plugin 'acme-brain' (6 skills)
```

Commit and push:

```bash
git add -A
git commit -m "fork: customize for Acme"
git push origin master
```

Your repo is now a real **Cowork-installable marketplace** at
`github:acme/acme-brain`. We'll use that in §6.

---

## 3. Provision the markdown data repo

1. Create a new GitHub repo at the path you entered as `data_repo`
   (e.g. `acme/acme-brain-data`). Repo can be private or public; the
   server's deploy key gives it write access regardless.
2. Add a minimal seed:
   ```bash
   git clone git@github.com:acme/acme-brain-data.git
   cd acme-brain-data
   echo '# Acme Brain — markdown data' > README.md
   mkdir -p entities/people
   cat > entities/people/founder.md <<'EOF'
   ---
   title: Founder
   slug: entities/people/founder
   type: person
   updated: 2026-05-03
   ---

   # Founder

   Stub seed for the brain's first sync.
   EOF
   git add -A && git commit -m "seed: README + entities/people/founder.md" && git push
   ```

This gives the first server boot something to import.

---

## 4. Provision Supabase

See `DEPLOY.md §1` for the canonical recipe. Quick summary:

1. Create a Supabase project in your org's account.
2. Sidebar → Database → Extensions → enable `vector` and `pg_trgm`.
3. Settings → Database → Connection string → URI → **Transaction pooler**
   (port 6543). Save this DATABASE_URL — you'll need it twice:
   - Once for `apply-migrations` from your laptop.
   - Once as a Railway env var.
4. Apply gbrain migrations:
   ```bash
   DATABASE_URL='postgresql://…:6543/postgres' \
     bun run src/cli.ts apply-migrations --yes
   ```
   Expect "27 migration(s) applied" or similar.
5. Issue your first bearer token (the admin's own):
   ```bash
   DATABASE_URL='…' bun run src/commands/auth.ts create <admin-handle>
   ```
   Copy the printed `gbrain_…` token. You'll use it for Cowork install
   in §7 and for verification in §8.

---

## 5. Provision Railway + deploy

See `DEPLOY.md §2` for the canonical recipe. Quick summary:

1. Create a Railway project. Link it to your GitHub fork (see DEPLOY.md
   §2.2 — note the GitHub→Railway integration is finicky for some
   accounts; CLI-based `railway up` is the reliable path).
2. Set env vars in Railway → Variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the pooler URL from §4 |
   | `NODE_ENV` | `production` |
   | `DENT_BRAIN_DATA_REPO_URL` | `git@github.com:acme/acme-brain-data.git` |
   | `DENT_BRAIN_DATA_PATH` | `/app/dent-brain-data` (default; override if needed) |
   | `DENT_BRAIN_GIT_NAME` | `acme-brain-server` |
   | `DENT_BRAIN_GIT_EMAIL` | `noreply@acme.com` |
   | `DENT_BRAIN_PULL_INTERVAL_SECONDS` | `300` (default — set to `0` to disable scheduled pull during debug) |

3. Deploy:
   ```bash
   railway up --detach
   ```

   The first deploy will FAIL at boot because `DENT_BRAIN_DATA_DEPLOY_KEY`
   isn't set yet. That's expected. §6 fixes it.

4. (Optional) Networking → Generate Domain (Railway gives you
   `acme-brain-production.up.railway.app`). Or set up a custom domain
   per `DEPLOY.md §4`.

---

## 6. Generate + register the deploy key

The server clones your `acme-brain-data` repo at boot via SSH. It needs
a private key whose public counterpart is registered as a GitHub
deploy key on the data repo (with **write** access).

```bash
# 1. Generate a fresh ed25519 keypair, no passphrase.
ssh-keygen -t ed25519 -f /tmp/acme-deploy-key -N '' \
  -C 'acme-brain-server@railway'

# 2. Print the public key + open the GitHub deploy keys page.
cat /tmp/acme-deploy-key.pub
open 'https://github.com/acme/acme-brain-data/settings/keys/new'
```

In the browser:
- Title: `acme-brain-server (railway)`
- Key: paste the public-key line
- ✅ **Allow write access** — required.
- Add key.

Push the private key to Railway (use the CLI to avoid newline corruption
the Railway UI textbox sometimes introduces):

```bash
railway variables --set "DENT_BRAIN_DATA_DEPLOY_KEY=$(cat /tmp/acme-deploy-key)"
```

Clean up locally:

```bash
rm /tmp/acme-deploy-key /tmp/acme-deploy-key.pub
```

Trigger a redeploy:

```bash
railway up --detach
```

Tail the logs to confirm boot succeeds:

```bash
railway logs --deployment
# Look for:
#   [dent-brain] data repo ready: /app/dent-brain-data @ <sha> (source=dent)
#   [dent-brain] scheduled-pull: every 300s
#   [dent-brain] HTTP MCP server listening on :8080 (env=production, version=…)
```

If the boot crash-loops with `Load key … error in libcrypto` or
`Permission denied (publickey)`, the env var or the GitHub deploy key
is wrong. Most common cause: pasted the public key when Railway needed
the private key, or vice versa. Recheck.

---

## 7. Install the Cowork plugin

Two places, two install paths.

### 7a. Cowork (the canonical teammate flow)

In a fresh Cowork chat:

> *"Add a custom marketplace from `github:acme/acme-brain` and install
> the `acme-brain` plugin."*

Cowork's `cowork-plugin-management` skill takes over — pulls the repo,
registers the marketplace, installs the plugin. After Cmd+Q + Cowork
relaunch + new chat, the slash commands appear:

- `/acme-setup` — admin setup (this skill, useful as a reference)
- `/acme-onboard-teammate` — admin: token + connector install for a teammate
- `/acme-append-evidence` — anyone: log an observation
- `/acme-enrich` — anyone: re-synthesize an entity page
- `/acme-resolve-entity` — anyone: disambiguate a name
- `/acme-add-ingestor` — admin: wire a new signal source

### 7b. Code mode (admin convenience)

For terminal CLI / Claude Desktop's Code mode, run:

```bash
bash plugin/marketplace/install-local.sh
```

This registers the local `plugin/marketplace/` as a Code-mode
marketplace and installs the plugin via `claude plugin install`.
Cowork is unaffected — its install must go through §7a above.

---

## 8. Verify end-to-end

Set up the bearer token (from §4):

```bash
export ACME_BRAIN_TOKEN='gbrain_…'
```

Test 1: tools/list shape

```bash
curl -fsS -X POST https://acme-brain.acme.com/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACME_BRAIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);t=[x["name"] for x in d["result"]["tools"]];print(f"{len(t)} tools");print("markdown_append_to_page:", "markdown_append_to_page" in t);print("evidence ops absent:", not any(x.startswith("append_evidence") or x.startswith("get_evidence") for x in t))'
```

Expect: ~44 tools, `markdown_append_to_page: True`, `evidence ops absent: True`.

Test 2: round-trip via Cowork

In a fresh Cowork chat, run:

```
/acme-append-evidence remember that the founder confirmed the 2026 conference dates would be Sept 13-15 in our 2026-05-03 1:1
```

Expected behavior:
1. Cowork detects "founder" → matches `entities/people/founder` (the seed page from §3).
2. Calls `markdown_append_to_page` with a date-anchored bullet under `## Timeline`.
3. Returns `commit_sha`.

Verify on disk + GitHub:

```bash
cd ~/<your local clone of acme-brain-data>
git fetch origin master
git log origin/master --pretty="%h %an %s" -3
# Top: <sha> acme-brain-server <noreply@acme.com> agent: append entities/people/founder
git pull --ff-only
grep -A 1 "Timeline" entities/people/founder.md
# Should show your new bullet
```

Round-trip via query:

> *"What do we know about the 2026 conference dates?"*

Cowork's response should surface the bullet you just wrote, sourced from
the Postgres index that got refreshed inside the op.

If all three tests pass, **the brain is live**.

---

## 9. Onboard teammates

For each teammate who'll use the brain:

```
/acme-onboard-teammate
```

The skill walks through:
- Pick a handle (`steve`, `jeff`, etc.).
- Issue a per-user bearer token.
- Produce a one-paste Python install command that registers the dent-brain MCP
  connector in their `~/.claude.json` (Code mode) AND
  `~/Library/Application Support/Claude/claude_desktop_config.json` (Cowork).
- Optionally walk them through Cowork plugin install (Phase 9 of the skill —
  for teammates who want hand-edit access on the data repo too).

Audit-log verification confirms registration before the onboarding is
declared complete.

---

## 10. (Optional) Add ingestors

Server-side ingestors translate external signals (RegFox webhooks,
Gmail threads, Granola transcripts) into `markdown_append_to_page`
calls. They amplify the brain's input pipeline beyond Cowork
conversational capture and teammate hand-edits.

**Ingestor framework lands in Phase 5+** — see
`/acme-add-ingestor` for the user-facing checklist + the
five-step wiring (pick source, configure auth, write translator, deploy,
smoke-test).

For Dent's MVP, RegFox is the first concrete ingestor (Phase 5.1).
Subsequent ships add Gmail (Phase 5.2), Granola (5.3), Dropbox (5.4).

---

## TL;DR (bookmark this)

```bash
# 1. Fork + setup
gh repo fork jasonp/dent-brain --clone --remote --org acme
cd dent-brain
bun install && bun run setup
git add -A && git commit -m "fork: customize for Acme" && git push

# 2. Data repo
gh repo create acme/acme-brain-data --private --clone
# (add README + entities/people/seed.md, commit, push)

# 3. Supabase: create project, enable vector + pg_trgm, copy DATABASE_URL
DATABASE_URL='…' bun run src/cli.ts apply-migrations --yes
DATABASE_URL='…' bun run src/commands/auth.ts create <admin-handle>

# 4. Railway: create project, set env vars (DATABASE_URL, NODE_ENV=production,
#    DENT_BRAIN_DATA_REPO_URL=git@github.com:acme/acme-brain-data.git, etc.)
railway up --detach   # first deploy fails — expected

# 5. Deploy key
ssh-keygen -t ed25519 -f /tmp/acme-deploy-key -N '' -C 'acme-brain-server@railway'
# Add /tmp/acme-deploy-key.pub to data repo's GitHub Settings → Deploy keys, write access ✓
railway variables --set "DENT_BRAIN_DATA_DEPLOY_KEY=$(cat /tmp/acme-deploy-key)"
rm /tmp/acme-deploy-key{,.pub}
railway up --detach   # second deploy succeeds

# 6. Cowork plugin
# In a fresh Cowork chat:
#   "Add a custom marketplace from github:acme/acme-brain and install acme-brain"
# Cmd+Q, relaunch, new chat.

# 7. Smoke test
# In Cowork:
#   /acme-append-evidence remember that …
# Verify: a real commit lands in acme/acme-brain-data master within seconds.

# 8. Onboard teammates
# /acme-onboard-teammate (per teammate)
```
