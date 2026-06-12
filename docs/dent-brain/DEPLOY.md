# Deploying Dent Brain to Railway + Supabase

Step-by-step for the initial (first-ever) Dent Brain deployment. Subsequent deploys are automatic from `git push origin master`.

**Time estimate:** ~30 minutes, mostly waiting for services to provision.

---

## 1. Supabase setup

You should already have:
- A Supabase account (created via the `dentthefuture` GitHub user)
- A project named `dent-brain` with a secure password
- Automatic RLS enabled (harmless for our single-writer architecture; defense-in-depth for later)

**Remaining Supabase steps:**

### 1.1 Enable pgvector

- Sidebar → **Database** → **Extensions** → search `vector`
- Toggle **Enabled**
- (Also recommended: `pg_trgm` for tsvector text search — gbrain uses it)

### 1.2 Copy the pooler DATABASE_URL

- Sidebar → **Project Settings** → **Database** → **Connection string** → **URI** tab
- **IMPORTANT: Choose "Transaction pooler" mode** (port 6543). Direct (port 5432) works but pooler is the production best-practice for serverless / containerized use.
- The URL looks like:
  ```
  postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
  ```
- Replace `<password>` with your real project password.

### 1.3 Apply gbrain migrations

Run from your local `~/gh/dent-brain/` checkout (with `DATABASE_URL` set for this command only — don't save to .env yet):

```bash
cd ~/gh/dent-brain
DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres" \
  bun run src/cli.ts apply-migrations --yes
```

Expected: "14 migration(s) applied" (or the current count). If you get `relation "schema_migrations" does not exist` on the first run, that's fine — the migration harness creates it.

Verify tables exist:

```bash
DATABASE_URL="..." bunx postgres --command "\\dt" 2>/dev/null | head -20
```

You should see `pages`, `chunks`, `links`, `timeline`, `access_tokens`, `mcp_request_log`, and others.

### 1.4 Create a bearer token

```bash
DATABASE_URL="..." bun run src/commands/auth.ts create "dent-brain-cowork"
```

Output:

```
Token created: dent-brain-cowork
Token (save this — you won't see it again):
  dbk_<48-char-base64-token>
```

Save the token. This goes into Railway env vars AND into Cowork's connector config later.

---

## 2. Railway setup

### 2.1 Create account + link GitHub

- Sign up at https://railway.com (or railway.app — same thing)
- Link your GitHub account: Settings → Account → Connected Accounts → GitHub
- Grant Railway access to `jasonp/dent-brain` (repo-scoped, not org-wide)

### 2.2 Create the project

- Dashboard → **+ New** → **Deploy from GitHub repo**
- Select `jasonp/dent-brain`
- Branch: `master`
- Railway auto-detects our `Dockerfile` (no Nixpacks guessing)

### 2.3 Set environment variables

In the project's **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `NODE_ENV` | `production` |
| `PORT` | Railway sets this automatically — **do not set manually** |
| `DENT_BRAIN_DATA_DEPLOY_KEY` | PEM-formatted SSH private key with write access to `dentthefuture/dent-brain-data`. Used only by the nightly DB→git export mirror (since v0.45); writes are DB-direct and work without it. See §2.3.1 below. |
| `DENT_BRAIN_DATA_REPO_URL` | (optional) Override clone URL. Default: `git@github.com:dentthefuture/dent-brain-data.git`. |
| `DENT_BRAIN_DATA_PATH` | (optional) Override clone path. Default: `/app/dent-brain-data`. Set to `/tmp/dent-brain-data` for ephemeral storage. |
| `DENT_BRAIN_GIT_NAME` | (optional) git commit author name. Default: `dent-brain-server`. |
| `DENT_BRAIN_GIT_EMAIL` | (optional) git commit author email. Default: `noreply@dentthefuture.com`. |
| `DENT_BRAIN_EXPORT_HOUR_UTC` | (optional, since v0.45) UTC hour-of-day for the nightly DB→git export to `dent-brain-data`. Default: `10`. The export is one-way (DB → git); the server never ingests from the repo. |
| `DENT_BRAIN_ADMIN_TOKENS` | (optional, since v0.45) Comma-separated bearer-token names allowed to call admin ops (`export_brain_now`). Calls from unlisted tokens return `permission_denied`. |
| `DENT_BRAIN_REGFOX_API_KEY` | (optional, Phase 5.1) Webconnex API key for the RegFox polling ingestor. When set, the server polls `/search/registrants` every `DENT_BRAIN_REGFOX_POLL_INTERVAL_SECONDS` and translates each new registration into a markdown bullet on the right entity page. See `docs/dent-brain/ingestors/regfox.md` for the full guide. |
| `DENT_BRAIN_REGFOX_POLL_INTERVAL_SECONDS` | (optional, default `300`) Tick interval for the RegFox cron. Set `0` to disable. |
| `DENT_BRAIN_REGFOX_FORM_IDS` | (optional, default poll-all) Comma-separated form IDs to scope polling. |
| `DENT_BRAIN_REGFOX_PRODUCT` | (optional, default `regfox.com`) Webconnex product. |
| `DENT_BRAIN_REGFOX_DISCOUNT_FIELD_PATH` | (optional) Override path inside `fieldData` where the discount code lives. |

The server reads `PORT` from env and binds to whatever Railway provides.

When `DENT_BRAIN_DATA_DEPLOY_KEY` is unset, the server still boots but logs
`exporter: disabled (DENT_BRAIN_DATA_DEPLOY_KEY unset) — no git mirror will
be maintained.` All ops — including `markdown_append_to_page` /
`markdown_replace_page` — work normally; since v0.45 writes go DB-direct to
Postgres (source `dent`), and the key only powers the export mirror.

### 2.3.1 GitHub deploy key for the dent-brain-data clone

The nightly exporter (since v0.45) pushes a DB→git mirror commit to the data
repo, so the Railway server needs an SSH key with **write** access to
`dentthefuture/dent-brain-data`.
Use a per-deployment ed25519 key, scoped to that single repo — smaller blast
radius than a personal access token.

**One-time setup:**

1. Generate a fresh ed25519 keypair locally (no passphrase — Railway can't
   prompt for one at runtime):
   ```bash
   ssh-keygen -t ed25519 -f /tmp/dent-brain-data-key -N '' -C 'dent-brain-server@railway'
   ```
2. **GitHub side.** In `dentthefuture/dent-brain-data` → **Settings** →
   **Deploy keys** → **Add deploy key**:
   - Title: `dent-brain-server (railway)`
   - Key: contents of `/tmp/dent-brain-data-key.pub`
   - **✅ Allow write access** — required; the exporter pushes the nightly mirror commit.
3. **Railway side.** In the dent-brain service → **Variables** → add a new
   variable:
   - Name: `DENT_BRAIN_DATA_DEPLOY_KEY`
   - Value: paste the contents of `/tmp/dent-brain-data-key` (the PRIVATE key,
     including the `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----END ...` lines).
     Railway accepts multi-line values — preserve newlines.
4. **Cleanup:** delete `/tmp/dent-brain-data-key` and `/tmp/dent-brain-data-key.pub`
   after both sides are configured. The private key now lives only in Railway's
   secret store and on the running container at `/tmp/dent-brain-data-deploy-key`
   (0600, written by `ensureDataRepo` at boot from the env var).

**On boot the server will:**
- Materialize the key to `/tmp/dent-brain-data-deploy-key` (0600) and set
  `GIT_SSH_COMMAND` for the exporter's git processes.
- Clone `dent-brain-data` to `DENT_BRAIN_DATA_PATH` (or pull if the path
  already exists across deploys). A clone/pull failure here is non-fatal —
  the export retries at fire time.
- Upsert the `sources` row (`id='dent'`) with `{mirror: true,
  syncEnabled: false}` — the server never ingests from the repo.

Look for these lines in the Railway deploy logs to confirm:
```
[dent-brain] exporter: nightly DB→git export scheduled (DENT_BRAIN_EXPORT_HOUR_UTC or default 10:00 UTC)
[dent-exporter] mirror ready: /app/dent-brain-data @ <sha> branch=main (source=dent, mirror=true)
```

**Rotating the key:** generate a new keypair, swap the GitHub deploy key, then
update the Railway env var. Railway redeploys on env var change. There is no
"refresh in place" — the env var is read once at boot.

### 2.4 Generate a public domain

- In the service settings, **Networking** → **Generate Domain**
- Railway gives you something like `dent-brain-production-a1b2.up.railway.app`
- Note this URL — you'll use it for Cowork connector config and later replace with the custom subdomain.

### 2.5 Trigger first deploy

Railway auto-deploys on push. If you've made no recent changes, just push an empty commit:

```bash
cd ~/gh/dent-brain
git commit --allow-empty -m "chore: trigger Railway deploy"
git push origin master
```

Watch the build logs in Railway's dashboard. Expected: Docker build completes in 1-3 min (mostly `bun install`), then the server starts (`bun run src/dent/serve.ts` per `railway.json` / `Dockerfile` CMD) and you see the `[dent-brain]` log lines:

```
[dent-brain] HTTP MCP server listening on :<PORT> (env=production, version=<gbrain-version>)
[dent-brain]   GET  /health
[dent-brain]   POST /mcp  (Bearer <token> required)
[dent-brain]   ops    : 41 core + 4 dent = 45
```

---

## 3. Verify

### 3.1 Health check (no auth)

```bash
curl https://<railway-domain>/health
# {"ok":true,"version":"<gbrain-version>","service":"dent-brain","db":"reachable"}
```

Upstream's `/health` is DB-probing — a single endpoint covers liveness + readiness. (The legacy separate `/ready` from our removed http-mcp wrapper no longer exists.)

### 3.2 MCP auth check

```bash
# No token → 401
curl -X POST https://<railway-domain>/mcp -H 'Content-Type: application/json' -d '{}'
# {"error":"unauthorized","message":"Invalid or missing Bearer token"}

# With token → either success or method-not-found (we sent a blank body)
curl -X POST https://<railway-domain>/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <your-dbk-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Should return a JSON-RPC response with a `tools` array
```

### 3.3 Verify audit logging

Back in Supabase SQL Editor:

```sql
SELECT token_name, operation, latency_ms, status, created_at
FROM mcp_request_log
ORDER BY created_at DESC
LIMIT 10;
```

Should show your `tools/list` call, status `success`, latency in ms.

---

## 4. Custom subdomain (recipe — applies to any deployment)

Canonical URL for any deployment: **`https://<your-subdomain>.<your-domain>/mcp`**, set in `plugin/manifest.json` under `deploy.server_url`.

Steps:

1. **Railway side — add the custom domain.** Project dashboard → **Networking** → **Custom Domain** → enter `<your-subdomain>.<your-domain>`. Railway returns:
   - A **CNAME target** (e.g. `<unique-id>.up.railway.app`) — call this `<your-railway-cname-target>`.
   - A **TXT verification record** on a Railway-defined record name — call this `<railway-txt-record-name>` and `<railway-txt-record-value>`. The TXT proves you control the domain so Railway can issue a LetsEncrypt cert.
2. **DNS side — add BOTH records at your DNS provider.** GoDaddy, Cloudflare, Namecheap, Route 53, etc. all work the same:
   - Record 1 (CNAME):
     - Type: `CNAME`
     - Name: `<your-subdomain>` *(subdomain only, not the full hostname)*
     - Value: `<your-railway-cname-target>`
     - TTL: 1 Hour (default)
   - Record 2 (TXT):
     - Type: `TXT`
     - Name: `<railway-txt-record-name>` *(exactly as Railway showed)*
     - Value: `<railway-txt-record-value>` *(exactly as Railway showed)*
     - TTL: 1 Hour (default)

   ⚠️ Both records are required. Skipping the TXT means Railway never validates the domain and the LetsEncrypt cert never issues — the URL keeps serving the wildcard `*.up.railway.app` cert and clients fail SSL verification.
3. **Wait.** DNS propagates fast on most providers (under a minute on GoDaddy + Google/Cloudflare resolvers). Railway issues the LetsEncrypt cert within ~1-5 min after seeing both valid records.
4. **Verify.**
   ```bash
   dig +short <your-subdomain>.<your-domain> CNAME           # should show your Railway target
   echo | openssl s_client -servername <your-subdomain>.<your-domain> \
     -connect <your-subdomain>.<your-domain>:443 2>/dev/null \
     | openssl x509 -noout -subject                          # should be CN=<your-subdomain>.<your-domain>, NOT *.up.railway.app
   curl -fsS https://<your-subdomain>.<your-domain>/health    # {"ok":true,...}
   ```
5. **Update existing standalone CLI registrations** to use the new URL (tokens are URL-agnostic — same token works on both URLs). Run as ONE line — backslash continuations break in some terminal paste modes:
   ```bash
   claude mcp remove dent-brain -s user
   claude mcp add dent-brain -s user -t http https://<your-subdomain>.<your-domain>/mcp -H "Authorization: Bearer <existing-token>"
   ```
   ⚠️ The `-s user` flag is required. Default scope is "local" (project-private), which doesn't surface in Claude Desktop's Code mode or Cowork — both read user-scope `~/.claude.json`. The onboarding skill (`/dent-onboard-teammate`) hardcodes `-s user` for this reason.

The Railway-provided URL (`https://<service-name>.up.railway.app/mcp`) keeps working in parallel — Railway routes both. The onboarding skill (`/dent-onboard-teammate`) reads `plugin/manifest.json` for the canonical URL, so all new registrations use the custom domain automatically.

**Deployment-specific values** (Railway CNAME target, TXT record name + value, Supabase project ID, etc.) belong in your private deploy runbook (e.g. `~/.dent-brain/DEPLOY_NOTES.md`, gitignored), NOT in this repo. The placeholders above are the OSS-shareable recipe; the private runbook is the per-deploy ledger.

---

## 5. Per-teammate install: dual-registration with mcp-remote bridge

Claude Desktop has **two MCP config files** with different schemas, and the team-use surface (Cowork mode) reads the stdio-only one. So every teammate gets BOTH registrations:

| Surface | Config file | Schema | Mechanism |
|---|---|---|---|
| Standalone CLI + Claude Desktop's **Code mode** | `~/.claude.json` (top-level `mcpServers.<name>`) | HTTP allowed (`{type, url, headers}`) | Direct write |
| Claude Desktop's **Cowork mode** + classic Desktop chats | `~/Library/Application Support/Claude/claude_desktop_config.json` | **stdio-only** | `mcp-remote` npm package as bridge |

Why the bridge: Cowork's config file rejects `{type: "http", ...}` entries with a launch-time popup ("entries are not valid MCP server configurations"). `mcp-remote` (npm) speaks MCP stdio to Claude Desktop and proxies to the remote URL. Same bearer token authenticates both surfaces.

Don't try to roll a custom Cowork connector through claude.ai's web Connectors UI — that requires OAuth and gates on the Pro/Max web plan, which is out of scope for Dent's MVP.

**Onboarding mechanics:** the `/dent-onboard-teammate` skill (admin-only, runs on Jason's machine) generates a per-user bearer token, embeds it in a one-paste Python-driven shell block, and walks the admin through delivery + verification via the audit log. The teammate pastes the block in their own terminal; both config files get atomically updated with backups in `~/.dent-brain/backups/`.

**Per-teammate prerequisites** (the skill walks the admin through pre-checking these):
- Claude Desktop installed and signed in (download: https://claude.ai/download).
- Node 18+ on the teammate's machine (`node --version`). Install via `brew install node` if missing — required for `npx -y mcp-remote` to spawn.
- Python 3 (universal on macOS, no install needed).

**Verification:** the admin polls the audit log via `./scripts/tail-mcp-audit.sh 20 | grep <teammate-handle>` after the teammate confirms they ran the install + asked Cowork to call `get_stats`. Pass criteria: a `tools/call` row from the teammate's token. `initialize` / `tools/list` rows alone don't count — they fire on connector load even without invocation.

For OSS forks: the dual-registration pattern works against any remote dbrain deployment. The `mcp-remote` bridge is one extra command in the install block; no OAuth issuer to deploy. See `docs/dent-brain/UPSTREAM_NOTES.md` §"Three Claude surfaces" for the discovery story.

---

## Troubleshooting

**Railway deploy fails with "no space left":** Our `.dockerignore` trims most non-runtime files. If you hit size issues, inspect the build context with `docker build --no-cache .` locally.

**`/health` returns `db:"unreachable"` (503):** DATABASE_URL is wrong, or Supabase is blocking the Railway IP. Supabase defaults to open; check project settings → Database → Network Restrictions.

**`401 unauthorized` with correct token:** verify the token was created against the SAME Supabase instance Railway is pointing at. Check `Authorization: Bearer <token>` header (no extra spaces, no trailing newline).

**gbrain migrations fail on first run:** check pgvector extension is enabled. Some Supabase regions default-disable it; you need to toggle it on.

**Cowork shows connector as "connected" but tools don't appear:** Cowork's deferred-tools model means schemas load lazily. Ask Claude "what tools does dent-brain have?" to trigger ToolSearch.
