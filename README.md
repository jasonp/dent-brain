# Dent Brain

**An organizational knowledge brain for small teams that already live in
Claude Code.** Multiple teammates write into one shared brain;
machine-driven ingestors push events from each teammate's tools (email,
calendar, meetings, registrations, mailing lists) directly into the
right entity timelines. The brain is the queue, Claude Code is the
agent, and the team gets a single substrate of truth that compounds
without anyone having to remember to update it.

Built as a fork of [GBrain](https://github.com/garrytan/gbrain) — that
project is the substrate (Postgres + pgvector, hybrid search,
self-wiring entity graph, contract-first MCP). Dent Brain adds the
multi-tenant onboarding flow, the per-teammate ingestors, and the
domain-specific skills that turn it from a personal brain into a
shared one. Stays compatible with upstream gbrain by design — see
[`scripts/sync-from-upstream.sh`](scripts/sync-from-upstream.sh) for
the merge protocol.

> Want the substrate docs (engine, search, schema, skills core)?
> They live at [`README.gbrain.md`](README.gbrain.md). This file
> covers what dent-brain adds on top.

---

## What's added on top of gbrain

Dent Brain layers four kinds of things on top of the gbrain substrate:

### 1. Per-teammate ingestors (`tools/`)

Each teammate runs these on their own laptop. Personal data (full email
content, raw meeting transcripts) stays local until the ingestor
filters + curates it down to a digest the brain can index. The brain
itself never holds raw inboxes.

| Extension | Source | Schedule | What it does |
|---|---|---|---|
| `granola-sync` | Granola public API | Hourly (launchd) | Pulls Granola meeting notes + transcripts via the public API (key in macOS keychain); each teammate's `user/filter.ts` decides which meetings reach the brain; pushes kept meetings into `meetings/`. |
| `email-sync` | Gmail (direct OAuth) | Every 6h (launchd) | Pulls Gmail in a strict scope (the configured `workEmail` only). Canonical noise-filter drops bulk-promo first; each teammate's `user/filter.ts` then decides keep/drop with noise + signature hints. Writes one digest page per UTC day to `inbox/<email-slug>/<date>`. |
| `mailchimp-ingestor` | Mailchimp audience CSV | Manual + cron | Files audience contacts under `audience/` for ad-hoc lookups. |
| `regfox-ingestor` | RegFox webhook → server | Real-time | Server-side ingestor that creates/appends entity pages on registration events (Dent conference, etc.). |

Manage these via the [`/dent-extensions`](skills/dent/dent-extensions/SKILL.md)
skill — list, install, **setup** (author your `user/filter.ts`),
**preview** (dry-run with that filter), **arm** (bootstrap launchd), or
uninstall any of them in plain English from your Claude Code session.
As of v0.39 both ingestors use the recipe model: install stages plumbing
but the daemon refuses to run until you've written your own `user/filter.ts`
and explicitly armed it. See `tools/<id>/recipe/RECIPE.md` for the contract.
New extensions land by adding an entry to
[`tools/extensions/registry.ts`](tools/extensions/registry.ts).

### 2. Cron-driven enrichers (Claude Code Desktop scheduled tasks)

The two-layer pattern from gbrain's email-to-brain recipe, instantiated.
Layer 1 is a deterministic ingestor (above); Layer 2 is an LLM-driven
enricher that fires on a schedule under your own Claude subscription:

- **`dent-process-inbox`** — daily 3am Sonnet run. Reads
  `inbox/<email-slug>/*` digests where `processed: false`, walks each
  Triage entry, resolves the other party (brain query → FileMaker
  fallback via FM MCP), appends a timeline bullet to the right
  entity's page, stamps the digest processed. Canonical body lives at
  `~/.dent-brain/skills/process-inbox.md` after install.

These run as native Claude Code Desktop scheduled tasks (see
[Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)),
not gstack `/schedule` and not gbrain minions — that way the routine
inherits the teammate's full MCP set (dent-brain, FileMaker, etc.) and
runs under their Claude subscription with no API key wrangling.

### 3. Domain skills (`skills/dent/`)

Multi-step workflows your team will actually use. All discoverable from
Claude Code with `/<name>`:

| Skill | What it does |
|---|---|
| `/dent-onboard-teammate` | Generates a bearer token for a new teammate, prints the install bundle + OS-aware connector script (works on macOS and Windows), verifies registration. |
| `/dent-extensions` | Manage local ingestors — list, install, setup (author `user/filter.ts`), preview (dry-run), arm, uninstall. |
| `/dent-tell-me-about` | Token-efficient summary of any entity (people, companies, projects, events). Routes through hybrid search + chunked retrieval + timeline rather than dumping the full page. |
| `/dent-append-evidence` | Capture an observation as a timeline bullet on the right entity. Detects which entities the observation is about, links new people to FileMaker, applies the A5 escalation rule. |
| `/dent-enrich` | Re-synthesize an entity page from current markdown + linked FM record + related context. FM is authoritative for owned fields; human edits preserved verbatim. |
| `/dent-resolve-entity` | Disambiguate a name that resolves to 2+ FileMaker People records with identical Full_Name. |
| `/dent-process-inbox` | Layer 2 of the email pipeline (above). Manually invokable too — useful when you want to force a re-process. |
| `/dent-setup` | First-run setup of the fork — provisions Supabase + Railway + the GitHub deploy key, customizes the fork for your org. |
| `/dent-add-ingestor` | Wire a new signal source into the brain (RegFox webhook, Gmail, Dropbox, etc.). Walks the five-step authoring flow. |

### 4. Server-side enhancements

- **DB-direct markdown writes** — `markdown_append_to_page` /
  `markdown_replace_page` write straight to Postgres (source `dent`);
  page history lives in `page_versions` (inspect via `get_versions`).
  A nightly exporter (10:00 UTC) renders the DB to the Dent Brain Data
  git repo as a one-way mirror — hand-edits pushed to that repo are
  NOT ingested. See `src/dent/db-writer/` and `src/dent/exporter/`.
- **Bearer-token onboarding** — each teammate gets a personal token
  scoped read+write so attribution stays clean across the shared
  brain. Token issuance lives in `/dent-onboard-teammate`.
- **FileMaker integration** — Dent's authoritative people/companies
  data lives in FileMaker; FM MCP gives every Claude Code session
  access for entity disambiguation + canonical-record lookups.
  Filing rules treat FM as the source of truth for owned fields and
  the brain page as the source of truth for narrative + timeline.

---

## Onboarding a new teammate

Two-step flow. The admin runs step 1 once per teammate; the teammate
follows the printed instructions for step 2.

**Step 1 (admin, in Claude Code):** invoke `/dent-onboard-teammate` and
provide the teammate's name + email. The skill mints a bearer token
scoped to the shared brain, prints a one-paste install command for the
teammate, and logs the registration to the audit trail.

**Step 2 (teammate, in Claude Code Desktop):** paste the install command.
Claude Code adds the dent-brain MCP server with the bearer token,
verifies connectivity, and confirms the teammate is registered.
After this, the teammate can:

- Read + write to the shared brain via `mcp__dent-brain__*` tools.
- Install per-teammate ingestors via `/dent-extensions`.
- Run `/dent-tell-me-about <person>` and get a token-efficient summary
  that pulls from the shared brain plus FileMaker.

For the per-teammate ingestors, the lifecycle is **install → setup →
preview → arm**. `install` stages plumbing only — the daemon is provably
inert (refuses to run without `user/filter.ts`). `/dent-extensions`
walks you through `setup` (a conversation that produces your own
`~/.dent-brain/<id>/user/filter.ts`), then `preview` (dry-run, no
writes), then `arm` (bootstraps launchd). Credentials are handled
inside `setup`:

- **Granola sync** auto-discovers the brain bearer token from
  `~/.claude.json`; setup prompts the teammate once for a
  Granola API key (minted in Granola → Settings → Connectors → API
  keys) and stores it in the macOS keychain.
- **Email sync** runs a one-time browser OAuth dance against the
  shared "Dent Brain" Google Cloud OAuth app (test mode, manual
  whitelist). The teammate clicks through one "this app isn't
  verified" warning; refresh tokens land in
  `~/.dent-brain/email-sync/google-tokens.json` (chmod 0600).
  After install: ask Claude in any Desktop session to "create a daily
  scheduled task at 3am called dent-process-inbox with these
  instructions: 'Read `~/.dent-brain/skills/process-inbox.md` and
  follow the instructions exactly.'"

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│                       Each teammate's laptop                  │
│                                                               │
│  ┌─────────────────────────┐    ┌─────────────────────────┐  │
│  │  Per-teammate ingestors │    │  Claude Code Desktop    │  │
│  │  (launchd, on cron)     │    │  - your subscription    │  │
│  │  - granola-sync         │    │  - MCP: dent-brain,     │  │
│  │  - email-sync           │    │     FileMaker, Calendar │  │
│  │  - (more)               │    │  - Scheduled task:      │  │
│  └────────────┬────────────┘    │     dent-process-inbox  │  │
│               │                  └────────────┬────────────┘  │
│               │ HTTPS (MCP)                   │ HTTPS (MCP)   │
└───────────────┼───────────────────────────────┼───────────────┘
                ▼                                ▼
        ┌────────────────────────────────────────────────┐
        │       Dent Brain server (Railway)              │
        │  - gbrain HTTP MCP                             │
        │  - bearer-token auth (per-teammate)            │
        │  - DB-direct markdown writes (Postgres,        │
        │    source 'dent'; history in page_versions)    │
        │  - nightly exporter → dent-brain-data mirror   │
        └────────────────┬───────────────────────────────┘
                         ▼
                  ┌───────────────┐  ┌───────────────────┐
                  │  Supabase     │  │  dent-brain-data  │
                  │  (Postgres +  │  │  (one-way nightly │
                  │   pgvector)   │  │   export mirror)  │
                  └───────────────┘  └───────────────────┘
                         ▲
                         │ also reachable
                         ▼
              ┌──────────────────────────┐
              │  Server-side ingestors   │
              │  - regfox-ingestor       │
              │  - (Mailchimp etc.)      │
              └──────────────────────────┘
```

Two write paths into the brain:
- **Teammate's Claude Code session** — direct MCP writes for ad-hoc
  edits + skill-driven workflows.
- **Per-teammate ingestor daemons** — launchd cron, also through MCP,
  same bearer token. Daemons never call the Anthropic API; they're
  pure deterministic transformers (collect → filter → digest).

---

## Repo layout (delta vs upstream gbrain)

```
dent-brain/
├── README.md                 ← this file (Dent-specific)
├── README.gbrain.md          ← upstream gbrain README (substrate docs)
├── skills/
│   └── dent/                 ← Dent-only skills (/dent-* commands)
├── src/
│   └── dent/                 ← Dent-only TypeScript
│       ├── db-writer/        ← DB-direct markdown write ops
│       ├── exporter/         ← nightly one-way DB→git export mirror
│       ├── ingestors/        ← regfox, mailchimp
│       └── ...
├── tools/
│   ├── extensions/           ← per-teammate ingestor registry + manager
│   ├── granola-sync/         ← extension: Granola → brain (laptop)
│   ├── email-sync/           ← extension: Gmail → brain (laptop)
│   └── ...
└── _reference/               ← gitignored: per-deploy notes, OAuth JSON, etc.
```

Everything else is upstream gbrain — the engine, schema, MCP server,
hybrid search, skill core. We pull upstream regularly and resolve any
conflicts; the rule is **always compatible with the latest gbrain.** If
upstream ships something that breaks dent-brain, fixing it is a
same-day priority. See `scripts/sync-from-upstream.sh`.

---

## Development

Same as upstream gbrain. Run `bun run typecheck && bun test` before
shipping. E2E tests require a Postgres+pgvector container; the lifecycle
is documented in [`CLAUDE.md`](CLAUDE.md).

To pull upstream changes:

```bash
bun run sync:upstream
```

Resolves conflicts, runs verify, surfaces any stale tests. Land via PR
to `main` and ship as a `v0.x.0` release.

---

## License

MIT — same as upstream gbrain.
