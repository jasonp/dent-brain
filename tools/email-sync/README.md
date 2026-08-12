# Email → Dent Brain sync

Two-layer pipeline that pulls Gmail directly via Google OAuth and turns it into entity timeline bullets in the brain.

**Layer 1 — collector (this directory).** Pure Bun, no LLM. Runs on the teammate's laptop via launchd, every 6 hours. Pulls messages where the configured **work email** is on either side, filters noise, classifies signatures, generates Gmail deep links, dedupes against a cursor. Writes a daily digest page to dent-brain via MCP at `inbox/<work-email-slug>/<YYYY-MM-DD>.md`. Email bodies never enter an LLM context — that's the whole point of doing this layer in code.

**Layer 2 — enricher.** A Claude Code Desktop scheduled task that fires daily at 3am on the teammate's laptop, under their Claude subscription. Reads the digest pages, walks the **Triage** section, finds or resolves each non-self entity (brain query → FileMaker fallback via FM MCP), appends a timeline bullet to their entity page. Marks the digest `processed: true` so it doesn't re-process. Catches up automatically if the laptop was asleep for a few days. Skill body lives at `~/.dent-brain/skills/process-inbox.md` (canonical) and `skills/dent/process-inbox/SKILL.md` (in repo).

**Privacy guarantee.** The Gmail query strictly scopes to the configured `workEmail`. Users with multiple addresses on the same Gmail inbox (e.g. `jason@dentthefuture.com` + `jason@jrpreston.com`) only get the work-email traffic in the brain. The non-work address never enters any layer of this system. Belt-and-suspenders re-check inside the collector drops anything that slipped through.

## Filter rules

A message is kept (sent to the brain) if ALL of these hold:

1. **Scope:** `from`, `to`, `cc`, or `bcc` contains the configured `workEmail`. Pushed into the Gmail query so non-matching messages never come back.
2. **Not noise:** `from` does not match the noise rules (literal substrings like `noreply@`, `notifications@`; marketing-subdomain regex like `e.<brand>.com`, `email.<brand>.com`; email-service apex domains like `mailchimp.com`, `sendgrid.net`, `luma-mail.com`, social-platform digests). See `noise-filter.ts`.
3. **Date:** newer than the cursor (or the configured backfill window on first run).

A kept message is then classified:

- **Signature** — subject or from matches DocuSign / Dropbox Sign / HelloSign / PandaDoc / "please sign" / "ready for your signature". Lands in the digest's `## Signatures` section for human attention; Layer 2 does not auto-update timelines for these.
- **Triage** — everything else. Layer 2 acts on this section.
- **Noise** — kept in the digest's `## Noise` section for audit (in case the noise filter was wrong) but never enriched.

## Auth model

Direct Google OAuth via a shared **"Dent Brain" Google Cloud OAuth app** in test mode. The admin (you, if you set up the fork) creates the OAuth app once, adds each teammate's Gmail address as a Test User in the consent screen, and stores the Client ID + Client Secret to pass to install.sh.

Each teammate runs the install once, completes a one-time browser OAuth dance ("this app isn't verified" → Advanced → "Go to Dent Brain (unsafe)" → Allow), and the resulting refresh token lands in `~/.dent-brain/email-sync/google-tokens.json` (chmod 0600). The collector self-refreshes the access token on every run.

No agent token to hunt down. No third-party broker. Each teammate authorizes their own Gmail; nobody else's tokens ever leave their laptop.

## Install

The supported path is via `/dent-extensions install email-sync` (the Claude Code skill walks the teammate through it).

Direct path (admin running it on a teammate's laptop, or a teammate doing the manual flow):

```bash
DENT_EMAIL_WORK_EMAIL=you@example.com \
DENT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
DENT_GOOGLE_CLIENT_SECRET=GOCSPX-... \
bun tools/email-sync/install.ts
```

Cross-platform (macOS + Windows): the installer is a Bun script — same command on both OSes. It picks launchd (macOS) or Windows Task Scheduler automatically. Or run it through the manager: `dent-extensions install email-sync`.

The installer also drops the Layer-2 skill body at `~/.dent-brain/skills/process-inbox.md`. After install completes, set up Layer 2 by asking Claude in any Claude Code Desktop session:

> "Create a daily scheduled task at 3am called dent-process-inbox with these instructions: 'Read `~/.dent-brain/skills/process-inbox.md` and follow the instructions exactly.'"

(Or use the Routines GUI in Claude Code Desktop: New routine → Local, schedule = Daily 3am.)

## Backfill

Default first run reaches back **3 days**. To pull a larger historical window:

```bash
bun ~/.dent-brain/email-sync/collect.ts --since 2026-04-01 --verbose
```

The collector writes one digest page per day in the range. The 3am Sonnet run picks them up oldest-first on its next firing; large backfills may take several runs to fully process (capped at 50 digests per run).

## Files

| File | Purpose |
|---|---|
| `collect.ts` | Entry point. Auto-discovers MCP creds, calls Gmail, classifies, writes digests. |
| `types.ts` | Shared type definitions. |
| `mcp-client.ts` | Minimal JSON-RPC client for the dent-brain MCP endpoint (shared with granola-sync). |
| `google-client.ts` | Direct Gmail API client with self-refreshing access tokens. |
| `oauth-flow.ts` | One-time interactive OAuth dance (loopback server + browser). Run by `install.sh`. |
| `noise-filter.ts` | Deterministic noise + signature classification. |
| `link-gen.ts` | Gmail deep-link generator. Code, never LLM. |
| `digest.ts` | Builds the daily digest markdown page. |
| `gmail-state.ts` | Gmail call-avoidance state: the banked 429 cool-down + the identity memo that keeps `getProfile` off the per-fire path. |
| `install.ts` | Cross-platform one-shot installer (collects config, runs OAuth dance, stages the schedule via the scheduler abstraction, drops Layer-2 skill body). macOS + Windows. |
| `config.example.json` | Reference config shape. |

## Manual ops

```bash
# One-shot manual collection
bun ~/.dent-brain/email-sync/collect.ts

# Dry run — see what WOULD be written, no MCP writes
bun ~/.dent-brain/email-sync/collect.ts --dry-run --verbose

# Backfill specific window
bun ~/.dent-brain/email-sync/collect.ts --since 2026-04-01

# Check whether a Gmail 429 cool-down is holding the daemon off
cat ~/.dent-brain/email-sync/gmail-state.json

# Override an active cool-down for one confirming probe (see below)
bun ~/.dent-brain/email-sync/collect.ts --force

# Inspect the launchd agent
launchctl print gui/$(id -u)/com.dent.email-sync

# Pause: stop the agent without uninstalling
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dent.email-sync.plist

# Resume
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dent.email-sync.plist

# Re-run OAuth dance (e.g. after revoking the grant in myaccount.google.com)
bun ~/.dent-brain/email-sync/oauth-flow.ts \
  --client-id $DENT_GOOGLE_CLIENT_ID \
  --client-secret $DENT_GOOGLE_CLIENT_SECRET \
  --tokens-path ~/.dent-brain/email-sync/google-tokens.json
```

## Gmail rate limits (429)

A 429 returns a **rolling ~16-minute window, restarted by every call**. Measured 2026-08-11:
two calls 52 minutes apart each got a retry-after exactly `15m56s` out.

That window is not the real constraint. The daemon waits 6h between fires — ~22x the stated
window — and still hits 429s in streaks of 3–5 consecutive fires. The quota is pooled across
the whole team's shared OAuth app, so those stalls are **someone's sustained usage, not
something this daemon did to itself**. See the §B7 item in `TODOS.md`; that is the fix for
stall frequency.

What the collector does about it: banks the retry-after in `gmail-state.json` and makes **zero**
Gmail calls until it passes, and aborts a run that hits its limit partway through rather than
grinding the remaining fetches into 429s. The first clean run clears the banked window.

Operator rules:

- **Never re-authorize on a 429.** It is not an auth failure, and the OAuth dance spends more
  quota. See `docs/issues/email-sync-429-and-reauth-ux.md`.
- **Don't poll it.** `preview` / `verify` / a manual `collect.ts` run during an active window
  re-extends it. Read `gmail-state.json` instead — that costs nothing.
- **`--force` is one confirming probe, not a retry loop.** Use it after the deadline has passed
  if you want to reopen the daemon early rather than waiting for the next scheduled fire.

Because quota is pooled across the whole team's shared OAuth app, a window you did nothing to
earn is usually someone else's burst. See the §B7 item in `TODOS.md`.

## Files written outside this directory

| Path | What |
|---|---|
| `~/.dent-brain/email-sync/config.json` | Required. Google OAuth creds + work email. Mode 0600. |
| `~/.dent-brain/email-sync/google-tokens.json` | Refresh token + last access token. Mode 0600. Self-refreshing. |
| `~/.dent-brain/email-sync/cursor.json` | Last-synced timestamp + recent message ids (dedup). |
| `~/.dent-brain/email-sync/gmail-state.json` | Banked 429 cool-down + verified-account memo. Mode 0600. Safe to delete — it rebuilds itself. |
| `~/.dent-brain/email-sync/sync.log` | launchd captures stdout + stderr here. |
| `~/.dent-brain/skills/process-inbox.md` | Canonical Layer-2 skill body, referenced by the scheduled task. |
| `~/Library/LaunchAgents/com.dent.email-sync.plist` | launchd schedule. |
| `inbox/<email-slug>/<date>.md` (in dent-brain) | Daily digest pages. The queue between Layer 1 and Layer 2. |
| `inbox/unresolved/<date>.md` (in dent-brain) | Layer-2 sweep page for entries that couldn't be auto-resolved. Reviewed manually in a Claude Code session with FM MCP. |
