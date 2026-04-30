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

The server reads `PORT` from env and binds to whatever Railway provides.

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

Watch the build logs in Railway's dashboard. Expected: Docker build completes in 1-3 min (mostly `bun install`), then the server starts and you see the three `[dent-brain]` log lines:

```
[dent-brain] HTTP MCP server listening on :<PORT> (env=production, version=0.16.0)
[dent-brain]   GET  /health
[dent-brain]   GET  /ready
[dent-brain]   POST /mcp  (Bearer <token> required)
```

---

## 3. Verify

### 3.1 Health check (no auth)

```bash
curl https://<railway-domain>/health
# {"ok":true,"version":"0.16.0","service":"dent-brain"}

curl https://<railway-domain>/ready
# {"ok":true,"db":"reachable"}
```

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

## 5. Add the connector to Claude Cowork

For Team/Enterprise Cowork plans, an org Owner adds the connector:

1. **Organization Settings** → **Connectors** → **Add**
2. URL: `https://<railway-domain>/mcp` (or the custom subdomain once set up)
3. Auth: **Bearer**, paste the `dbk_...` token from step 1.4
4. **Save**

Test in a new Cowork session: "What tools do I have from dent-brain?" — should list gbrain's 30+ operations.

---

## Troubleshooting

**Railway deploy fails with "no space left":** Our `.dockerignore` trims most non-runtime files. If you hit size issues, inspect the build context with `docker build --no-cache .` locally.

**`/ready` returns 503 db unreachable:** DATABASE_URL is wrong, or Supabase is blocking the Railway IP. Supabase defaults to open; check project settings → Database → Network Restrictions.

**`401 unauthorized` with correct token:** verify the token was created against the SAME Supabase instance Railway is pointing at. Check `Authorization: Bearer <token>` header (no extra spaces, no trailing newline).

**gbrain migrations fail on first run:** check pgvector extension is enabled. Some Supabase regions default-disable it; you need to toggle it on.

**Cowork shows connector as "connected" but tools don't appear:** Cowork's deferred-tools model means schemas load lazily. Ask Claude "what tools does dent-brain have?" to trigger ToolSearch.
