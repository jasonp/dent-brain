# Dent Brain — Design Doc

**Owner:** Jason Preston
**Status:** Draft v0.7 — ready for Claude Code + gstack development
**Goal:** A shared Dent Conference knowledge operations system that the core team uses through Claude Cowork, that Jason's OpenClaw Dent agent can also query, with append-only evidence, derived entity views, and seamless install. Built on gbrain as the substrate.

**Framing note:** This is not "gbrain with a thin multi-user layer." It is a collaborative knowledge operations system that uses gbrain for storage, search, and MCP substrate, and adds its own layers for evidence capture, materialized entity views, and multi-writer coordination. The distinction matters because it sets correct expectations about what we're building.

**Decisions locked in v0.7:**
- Hosted on Railway. Public URL via Railway's own domain or a custom subdomain — **ngrok dropped**.
- Dent org GitHub repo for markdown archive.
- Admins: Jason and Steve.
- **Event-log-first architecture:** immutable evidence records are the source of truth; entity pages are derived views.
- **Typed entity pages:** confirmed facts, working inferences, open questions, conflicts, evidence timeline — not a single compiled-truth blob.
- **Namespace separation:** `entities/`, `streams/`, plus domain namespaces (`speakers/`, `sponsors/`, `community/`, etc.).
- Granola official MCP for meeting transcripts (per-user, distributed).
- **Gmail ingest via Claude's native connector** in each user's Cowork session — uses the connector team members already have, no server-side OAuth needed in v1.
- Three v1 non-merge append streams: Jason's X posts, Steve's LinkedIn posts, Dent blog posts.
- Dropbox bulk import is v1, not deferred — it's the first serious test of the architecture.
- Replay/rebuild tooling is built early, before broad onboarding.
- Reuse gbrain as substrate; merge upstream updates by keeping our additions as *layers above* gbrain, not modifications to it.

---

## 1. What we're building (in one paragraph)

A collaborative knowledge operations system called `dent-brain` that runs as a hosted HTTP MCP server on Railway. The Dent core team (Steve, Jeff, Robin, Andreas, Morgan, Jason) connects to it from Claude Cowork via a remote MCP connector URL + personal bearer token. They invoke skills to append new evidence to a shared event log, and query entity pages that are materialized from that evidence. When Jason texts with Mike Cottmeyer, he invokes `/append Mike texted about Dent 2026…` in Cowork; when Jeff later has lunch with Mike, he does the same; both contributions land as separate evidence records attributed to their respective authors, and Mike's entity page shows both in a timeline alongside typed sections for confirmed facts, working inferences, and open questions. Data flows in through three classes of source — server-side (Dropbox drop folder, RSS streams, scrapers), user-pushed via Cowork (meeting transcripts through each user's Granola MCP, emails through each user's Gmail connector, pasted notes), and one-time historical import (Dropbox archive). Jason's OpenClaw Dent agent uses the same MCP endpoint with a service token. The markdown archive lives in a private Dent GitHub repo as a periodic snapshot of the entity layer, not as the transactional substrate.

---

## 2. Why this architecture

The obvious design — "multi-user gbrain with commits on every write" — fails in three ways once you model the actual work:

1. **Shared entity pages are write-contended.** Mike Cottmeyer's page will be touched by Jason (texts), Jeff (lunches), scrapers (LinkedIn updates), enrichment crons (nightly synthesis). If every write is a git commit and every conflict is a human resolution, the team stops using the system.
2. **Compiled truth hides uncertainty.** A single synthesized block at the top of each page pretends everything is equally confident. Speaker attribution errors, contradictions between sources, and stale claims all get frozen into prose that reads authoritatively.
3. **Bulk imports blow up mutable designs.** Dropping 5,000 historical files into a system that mutates entity pages on every write creates thrash. An immutable evidence layer handles imports as just another source — same code path, different batch tag.

The event-log-first architecture solves all three. Evidence is append-only and attribution-bearing. Entity pages are derived views that can be rebuilt from scratch at any time. Typed sections make uncertainty explicit. Imports are boring — they just produce more evidence records.

The secondary benefit: **this architecture is portable to other organizations**. The core machinery (evidence log, entity materialization, typed views) is domain-agnostic. Dent-specific content lives in skills, schema config, and namespace definitions — not in the system's bones.

---

## 3. Design principles

1. **Event-log is truth. Entity pages are views.** Every fact the system knows originated as an evidence record with a source and an author. Entity pages are derived from evidence and can be rebuilt at any time.
2. **Append, don't merge.** Multiple users contribute observations about the same entity by appending evidence, not by editing shared prose. Synthesis happens downstream, async.
3. **Typed uncertainty.** Entity pages explicitly separate confirmed facts, working inferences, open questions, and detected conflicts. No single "compiled truth" blob.
4. **Execution models are distinct.** Remote Cowork connectors, local agents (Claude Code, OpenClaw), and SaaS OAuth connectors (Granola MCP) are different runtime environments. Every ingest path specifies which one it uses.
5. **Gbrain is substrate, not fork target.** We reuse gbrain's CLI, MCP tools, hybrid search, embedding pipeline, and skill patterns. Our additions sit as layers above it so upstream merges stay clean.
6. **Thin harness, fat skills.** Evidence capture and entity materialization are thin. Intelligence lives in Dent-specific skills that read evidence and entity pages.
7. **Non-technical install.** Team members never touch a terminal.
8. **Provenance by default.** Every evidence record carries source, author, timestamp, content hash. Audit is a query, not a forensic investigation.
9. **Portable foundation.** The core is domain-agnostic. Dent specificity is in skills and namespace config, not in the machinery.

---

## 4. Who uses it and how

| Persona | Interface | Auth | Admin? |
|---|---|---|---|
| Jason (jason@dentthefuture.com) | Cowork + OpenClaw + Claude Code | Admin token | Yes |
| Steve Broback (steve@dentthefuture.com) | Cowork | Admin token | Yes |
| Jeff, Robin, Andreas, Morgan | Cowork | Member token | No |
| Jason's OpenClaw Dent agent | HTTP MCP | Service token | No |
| Server-side ingestors (Dropbox, scrapers, RSS) | HTTP MCP | Service token | No |

All identity uses @dentthefuture.com. No tkmt.vc or jrpreston.com anywhere.

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       INGESTION SOURCES                         │
│                                                                 │
│  SERVER-SIDE (run on Railway, no user device required)          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ • Dropbox drop folder (nightly scan)                     │   │
│  │ • Dropbox historical archive (one-time, batched)         │   │
│  │ • Jason's X posts (RSS/API, daily)                       │   │
│  │ • Steve's LinkedIn posts (RSS, daily)                    │   │
│  │ • Dent blog posts (RSS, daily)                           │   │
│  │ • Scraper webhooks (as scrapers fire)                    │   │
│  │ • MailerLite (v1.1)                                      │   │
│  │ • Google Drive (v1.1)                                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  USER-PUSHED via Cowork (remote MCP, runs on Anthropic cloud)   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ • /append-evidence <entity> <observation>                │   │
│  │ • /ingest-granola-meetings (via Granola MCP)             │   │
│  │ • /ingest-gmail-today (via Claude's Gmail connector)     │   │
│  │ • /ingest-email (paste)                                  │   │
│  │ • /ingest-notes (paste)                                  │   │
│  │ • /ingest-conference-content (batch, post-event)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  LOCAL AGENTS (Jason only in v1; runs on his machine)           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ • OpenClaw Dent agent (cron jobs, local filesystem)      │   │
│  │ • Claude Code (dev work, skill authoring)                │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                             │ All paths write to the same evidence log
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  DENT BRAIN SERVER (Railway)                    │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  HTTP MCP endpoint (dent-brain.dentthefuture.com/mcp)  │     │
│  │  Auth: bearer token → user identity                    │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  EVIDENCE LAYER (append-only, Postgres)                │     │
│  │  Every ingest lands here first.                        │     │
│  │  Schema: id, source, author, timestamp, content, hash, │     │
│  │          entity_refs[], stream_id, batch_id            │     │
│  │  Never modified, never deleted. This is truth.         │     │
│  └────────────────────────────┬───────────────────────────┘     │
│                               │                                 │
│                               │ Materializer job (async)        │
│                               ▼                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  ENTITY LAYER (derived views, markdown + Postgres idx) │     │
│  │  For each entity: rebuild page from all evidence       │     │
│  │  referencing it. Synthesize into typed sections:       │     │
│  │  • confirmed facts  • working inferences               │     │
│  │  • open questions   • conflicts                        │     │
│  │  • evidence timeline (reverse chron, attributed)       │     │
│  └────────────────────────────┬───────────────────────────┘     │
│                               │                                 │
│                               ▼                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  SEARCH + INDEX (gbrain's existing machinery)          │     │
│  │  Hybrid RRF search over entity pages and evidence.     │     │
│  │  pgvector + tsvector, exactly as gbrain provides.      │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  GIT ARCHIVE (periodic snapshots, not per-write)       │     │
│  │  Snapshot entity layer every hour + after batch jobs.  │     │
│  │  Pushes to github.com/dentthefuture/dent-brain-data.   │     │
│  │  Git is backup + diff review, NOT concurrency system.  │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  REPLAY + REPAIR TOOLS (built early, Phase 2)          │     │
│  │  • rebuild <entity> from evidence                      │     │
│  │  • rebuild-all (full materialization from log)         │     │
│  │  • quarantine <batch_id>                               │     │
│  │  • diff <entity> <timestamp>                           │     │
│  │  • evidence --source X --author Y --since Z            │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. The evidence-then-entity model, concretely

Every piece of knowledge in the system starts as an **evidence record**. An evidence record is immutable and has:

- `id` — content hash + timestamp
- `source` — where this came from (`granola:meeting:abc`, `dropbox:drop:file.md`, `user-paste:jeff:2026-04-15T14:22`, `rss:jason-twitter:tweet-id`, `dropbox-import:batch-2026-04-20:path/to/file.md`)
- `author` — who contributed this (`jeff@dentthefuture.com`, `service:dropbox-ingestor`, `service:rss-stream-fetcher`)
- `timestamp` — when the observation happened, not when it was ingested
- `ingested_at` — when it landed in our system
- `content` — the actual text/observation
- `entity_refs` — a list of entity slugs this evidence is about (`entities/people/mike-cottmeyer`, `entities/companies/leading-agile`)
- `stream_id` — nullable; for per-author streams (`streams/jason-twitter`, `streams/steve-linkedin`)
- `batch_id` — nullable; for grouped imports like Dropbox historical

**Entity pages are materialized views.** For each entity, a materializer job reads all evidence records that reference it, synthesizes them into typed sections, and writes a markdown page. Rebuilding a page is always safe — it's a pure function of the evidence log.

**Example: Mike Cottmeyer's page after two contributions:**

```markdown
---
slug: entities/people/mike-cottmeyer
last_materialized_at: 2026-04-17T18:45:00Z
evidence_count: 7
---

# Mike Cottmeyer

## Confirmed facts
- Founder and CEO of LeadingAgile. [src: scraper:linkedin:2026-03-12]
- Interested in speaking at Dent 2026. [src: user-paste:jason:2026-04-14, user-paste:jeff:2026-04-15]
- Travel-constrained in Q2 2026. [src: user-paste:jason:2026-04-14]

## Working inferences
- Likely wants a keynote slot based on Jeff's lunch conversation. [src: user-paste:jeff:2026-04-15] — confidence: medium

## Open questions
- Keynote vs. regular session?
- Compensation expectations not yet discussed.

## Conflicts
(none)

## Evidence timeline
- 2026-04-15 14:30 — jeff@dentthefuture.com via /append-evidence: "Lunch at Guisados. Mike is definitely interested, wants keynote slot, asked about audience size and compensation."
- 2026-04-14 09:12 — jason@dentthefuture.com via /append-evidence: "Texted with Mike. Interested in Dent 2026 but travel-constrained in Q2. Wants dates ASAP."
- 2026-04-12 03:00 — service:rss-stream-fetcher via streams/mike-cottmeyer-linkedin: "Posted article on team topology patterns."
- ...
```

**Contradictions get surfaced explicitly.** If Jeff later appends "Mike said he's NOT travel constrained, that was an old conversation," the materializer detects the contradiction with Jason's earlier observation and moves both to a `Conflicts` section until human review. No prose gets silently overwritten.

**Why this works for multi-writer:** No two writers ever touch the same mutable object. Everyone appends to the evidence log. The materializer is the only thing that writes entity pages, and it runs async.

---

## 7. Namespaces

The brain's markdown archive is organized into these top-level namespaces. This is structural only — v1 has no ACLs, everything is visible to all authenticated team members.

```
dent-brain-data/
  entities/              # ONE page per entity; derived from evidence log
    people/
      mike-cottmeyer.md
      todd-herman.md
    companies/
      leading-agile.md

  streams/               # Non-merge append-only per-author logs
    jason-twitter/       # time-ordered, one post per file or per day
    steve-linkedin/
    dent-blog/

  speakers/              # Speaker pipeline, nominations, prep
                         # References entities/people/*, doesn't duplicate
  sponsors/              # Sponsor conversations, commercial relationships
  sessions/              # Conference sessions by year
    dent-2026/
    dent-2025/
  community/             # Scraper-sourced community intel
  marketing/             # MailerLite, campaigns (v1.1)
  team-ops/              # Internal meetings, decisions, planning
    meetings/            # Granola-sourced meeting records
  originals/             # Team thinking, frameworks
  dent-library/          # Annual book nominations
  archives/              # Dropbox historical import
    batch-2026-04-20/

  observations/          # Optional export of evidence log for browsing
  integrations/          # Integration status, config (gitignored secrets)
  DENT_SCHEMA.md         # Loaded into context resolver on every query
```

**Why entities live separately from domain namespaces:** Mike Cottmeyer appears in the speaker pipeline (`speakers/2026-pipeline.md`) AND is referenced in scraper data (`community/...`) AND comes up in team meeting notes. Without a dedicated `entities/` namespace, we'd duplicate his profile in each place or build ad hoc cross-references. With a dedicated namespace, every mention of him anywhere in the system points to one canonical page.

**Why streams stay separate from entities:** Jason's Twitter feed is chronological and author-scoped. It's useful to query as a stream ("what has Jason been posting about lately?") and it's useful when specific tweets mention entities (the tweet becomes evidence). But tweets don't belong in the entity page for Jason — they belong in a stream. Evidence records from the stream that mention other entities (Mike Cottmeyer, a company, etc.) show up in those entities' pages.

---

## 8. Ingestion sources, end to end

Each source specifies: runtime environment, trigger, what it produces.

### 8.1 Server-side ingestion (runs on Railway)

| Source | Runtime | Trigger | Produces |
|---|---|---|---|
| Dropbox drop folder | Railway cron | Nightly 03:00 | Evidence records from new files, classified and routed |
| Dropbox historical archive | Railway, one-time | Phase 6 manual run | Bulk evidence records with `batch_id: dropbox-import-<date>` |
| Jason's X posts | Railway cron | Daily 06:00 | Stream records in `streams/jason-twitter/` + evidence if entities mentioned |
| Steve's LinkedIn posts | Railway cron | Daily 06:00 | Stream records in `streams/steve-linkedin/` |
| Dent blog posts | Railway cron | Daily 06:00 | Stream records in `streams/dent-blog/` + evidence if entities mentioned |
| Scraper webhooks | Railway HTTP endpoint | As scrapers fire | Evidence records in `community/` namespace |

**All server-side ingestors authenticate with service tokens.** Each has its own token so audit shows which ingestor wrote what.

**Dropbox drop folder workflow:**
1. Nightly cron lists the folder via Dropbox API.
2. For each new file (tracked by path + content hash): fetch, classify (meeting note? email export? document? note?), route to appropriate parser.
3. Parser produces one or more evidence records, each with source `dropbox:drop:<path>`.
4. Deduplicate by content hash before writing.
5. Log success/failure per file to an ingest journal visible via `/ingest-status`.

### 8.2 User-pushed via Cowork (remote MCP)

Cowork's remote connector runs on Anthropic's cloud infrastructure. These skills cannot touch the user's local filesystem. They operate on content the user pastes OR on data fetched through other MCP connectors the user has authorized (notably Granola and Gmail).

The pattern for connector-based ingest is: Claude fetches data via the user's own authenticated connector (Anthropic manages the auth), then passes the content to our Dent Brain skill which writes evidence records. No credentials cross the boundary — Anthropic handles OAuth, we handle parsing and writing.

| Skill | Trigger | Produces |
|---|---|---|
| `/append-evidence <entity> <observation>` | User invokes | One evidence record attributed to user |
| `/ingest-granola-meetings` | User invokes or Cowork schedule | Evidence records via user's Granola MCP connection |
| `/ingest-granola-meeting <id>` | User invokes | Evidence from one specific Granola meeting |
| `/ingest-gmail-today` | User invokes or Cowork schedule | Evidence records via user's Gmail connector |
| `/ingest-email` | User pastes email, invokes | Evidence records from email thread (shared parser with `/ingest-gmail-today`) |
| `/ingest-notes` | User pastes notes, invokes | Evidence records with entity detection |
| `/ingest-conference-content` | Jason runs post-event | Batch evidence records for session content |

**Granola specifics:** Each team member authenticates Granola's official MCP in their own Cowork. Our `/ingest-granola-meetings` skill queries their Granola for recent Dent-relevant meetings and writes evidence records. Because evidence is append-only, two team members ingesting the same meeting produce two evidence records (both valid, both attributed correctly) — no dedup problem, because no single mutable entity page is being fought over. The materializer sees both records when rebuilding the meeting entity and the attendees' pages.

**Granola filtering:** Default filter is "meetings where at least one attendee has an @dentthefuture.com email OR meeting is in a Granola folder named Dent." Per-user override in a small config file. Manual force-ingest via `/ingest-granola-meeting <id>` for exceptions (e.g., a call with a speaker who isn't yet on Dent email).

**Gmail specifics:** Each team member has already connected Claude's native Gmail connector to their Claude account. Our `/ingest-gmail-today` skill uses that connector to fetch emails, then writes evidence records via our MCP. The flow:

1. Skill queries Dent Brain: `list_recent_writes(source_prefix="gmail:<user>")` to get the last ingested message ID.
2. Skill calls Gmail connector: `search_messages` with the team's shared label (e.g., `dent`) and `after:<message-id>`.
3. For each new message: `read_message` returns full content.
4. Skill delegates to `/ingest-email`'s parser (same code path as paste-based ingest) to detect entities, extract observations, produce evidence records.
5. Each evidence record has `source: gmail:<user>:<message-id>`, `author: <user>@dentthefuture.com`.

**Shared label convention:** Team members standardize on a Gmail label (`dent` or `dent-brain`). They apply it either manually or via a Gmail filter rule (e.g., "auto-label messages from @dentthefuture.com addresses"). This is the email equivalent of the Dropbox drop folder: opt-in, explicit, no surveillance of the whole inbox. Each user controls what gets ingested from their mailbox.

**Gmail connector limits:** The connector can read but not send (fine — we're ingesting, not replying). Attachment metadata is available but not attachment content. If an email has a speaker deck attached, we capture the filename as context but not the slide content. For attachments that matter, users drag them into the Dropbox drop folder for server-side ingest.

**Reliability caveat:** Cowork scheduled tasks only run while the user's machine is awake and Claude Desktop is open. If Jeff's laptop is off over a weekend, Monday's scheduled run picks up the backlog. Tolerable for daily cadence; not suitable for time-sensitive auto-responses (we don't do those). When Anthropic's Claude Code cloud scheduled tasks start injecting MCP connectors properly, we can move this to cloud scheduling for machine-independence — the skill is designed to run identically in both environments.

**State tracking, multi-user:** Because the "last ingested message ID" is stored server-side in Dent Brain (not locally), the same user can run their scheduled task on multiple machines or Claude interfaces and never double-ingest. Each user has their own cursor keyed on their email.

### 8.3 Local agents (Jason only, v1)

Jason runs OpenClaw (now on Pi, later on Mac Studio) and Claude Code on his own machine. These have full local filesystem access and can do things Cowork can't. v1 uses them for:

- **Development** (Claude Code + gstack): building, testing, deploying Dent Brain itself.
- **Nightly enrichment and maintenance** (OpenClaw via MCP): things like running the dream-cycle skills, rebuilding stale entity pages, summarizing brain activity.
- **Jason's personal workflow**: his daily-planner skill and personal brain are local, separate from Dent Brain.

**No other team member runs a local agent in v1.** If Jeff later wants to, that's fine — he connects Claude Code's MCP to Dent Brain with his token and gets the same tool surface. But it's not a requirement for v1.

---

## 9. Query surface (MCP tools)

We expose gbrain's existing tools plus Dent-specific additions.

**Reused from gbrain:**
- `get_page(slug)` — retrieve entity or namespace page
- `search(query)` — hybrid RRF search over entity + evidence
- `list_recent_writes(since, user?)`
- All other gbrain tools for traversal, backlinks, embedding status, etc.

**New in Dent Brain:**
- `append_evidence(entity_refs, content, source_context?)` — add to the event log; returns evidence record ID
- `get_evidence(entity_slug, limit?)` — return raw evidence records for an entity, most recent first
- `get_provenance(entity_slug)` — return all sources and authors that contributed to an entity page
- `list_conflicts()` — entities currently flagged with contradictions for human review
- `rebuild_entity(slug)` — force re-materialization from evidence log
- `list_streams(stream_id?, since?)` — query per-author streams
- `whoami()` — confirm identity and connection

**Wrapped for provenance:**
- Writes to non-entity namespace pages (team-ops/, speakers/, etc.) also go through an append-and-materialize pattern when multi-writer, or are simple user-owned pages (like team-ops meeting agendas authored by one person) when not.

---

## 10. How gbrain fits and how upstream merges stay clean

Our code adds layers *above* gbrain's existing machinery. Specifically:

**Unchanged gbrain:**
- Core CLI
- MCP server infrastructure and the 37 existing operations
- Hybrid RRF search with pgvector + tsvector
- Embedding pipeline, chunking, import command
- All existing gbrain skills (we'll use some as templates)
- Recipe framework

**Dent Brain additions (new files, new tables, new tools):**
- `src/evidence/` — the evidence log module (Postgres tables + append API)
- `src/materializer/` — the evidence → entity page renderer
- `src/streams/` — per-author stream handling
- `src/ingestors/` — server-side source ingestors (Dropbox, RSS, scrapers)
- `src/auth/` — user/token tables and middleware
- `src/audit/` — audit log + middleware
- `src/replay/` — replay/rebuild/quarantine tools
- Dent-specific skills in `skills/` directory of the data repo

**Upstream merge strategy:**
- Our changes don't modify gbrain's core operations, its schema, or its storage.
- Evidence log lives in Dent-owned Postgres tables alongside gbrain's tables.
- Materializer writes to a designated directory structure gbrain treats as normal markdown.
- Our new MCP tools are additions to gbrain's tool surface, not replacements.
- When gbrain ships upstream updates, we pull and merge. Conflicts should be rare because we're not touching gbrain's files.

This is a better merge story than the original "fork and modify" plan. It treats gbrain as a library we depend on, not a codebase we've forked and diverged from.

---

## 11. Skills

### 11.1 Ingest skills

- `/append-evidence <entity> <observation>` — **new, core to the system.** User provides an entity slug (or creates new) and an observation. Skill writes an evidence record. This is the primary way team members contribute.
- `/ingest-granola-meetings` — queries user's Granola MCP, writes evidence records. Forks gbrain's meeting-sync attendee-enrichment logic.
- `/ingest-granola-meeting <id>` — force-ingest one meeting by ID.
- `/ingest-gmail-today` — **uses user's native Gmail connector**, fetches emails with team's shared Dent label since last ingest, parses via shared `/ingest-email` logic, writes evidence records. Runs manually or on Cowork schedule.
- `/ingest-email` — paste email, produce evidence records. Shares its parser with `/ingest-gmail-today`. Adapts gbrain's email-to-brain entity-detection logic.
- `/ingest-notes` — paste free-form notes, entity detection, produce evidence.
- `/ingest-conference-content` — batch-ingest session recordings post-event.
- `/ingest-dropbox-tree` — one-time historical import (Phase 6).

### 11.2 Dent-native intelligence skills

- `/prep-speaker <name>` — read entity page + related speaker pipeline context + session history.
- `/session-plan` — design a conference session using speakers, themes, past sessions.
- `/dent-library` — manage annual book nominations.
- `/who-knows-whom` — social graph traversal for warm intros.
- `/dent-status` — conference planning dashboard.
- `/sales-check <name>` — **"did we already pitch Mike Cottmeyer?"** Returns all evidence + entity state relevant to commercial/sponsorship status.
- `/evaluate-session <slug>` — post-session analysis for conference content.
- `/marketing-brief <campaign>` — assemble context for a marketing effort.

### 11.3 Operational skills (reused from gbrain with minor adaptation)

- Dream cycle (nightly enrichment) — runs server-side on Railway
- Signal detector — runs per-message in user sessions
- Daily digest — summarizes brain activity for a given period

### 11.4 Admin skills

- `/rebuild-entity <slug>` — force materialization
- `/quarantine-batch <batch_id>` — hide a whole ingest batch from queries
- `/list-conflicts` — show entities with contradictions
- `/ingest-status` — show recent server-side ingest health

---

## 12. Install experience

### 12.1 Team member install (~10 minutes, zero terminal)

1. Jason sends Slack message with connector URL and bearer token DM.
2. In Cowork: Customize → Connectors → Add Custom Connector. Paste URL `https://dent-brain.dentthefuture.com/mcp`, paste token.
3. Connect Granola's official MCP via browser OAuth (if not already).
4. Verify Claude's native Gmail connector is connected (most team members have this already).
5. Install Dent Brain plugin (skills bundle).
6. Create a Gmail label called `dent` (or use existing team convention). Optionally add a Gmail filter to auto-apply the label to messages matching certain criteria.
7. First message: "Am I connected?" → Claude calls `whoami()` → confirms.
8. Second check: "What are my recent Granola meetings?" → confirms Granola connector.
9. Third check: "Show me my recent Gmail messages with the dent label." → confirms Gmail access.
10. Optional: set up daily scheduled tasks for `/ingest-granola-meetings` and `/ingest-gmail-today`.
11. Done.

### 12.2 Admin setup (Jason + Steve, one-time)

1. Deploy Dent Brain to Railway from the tool repo. Use Railway-provided domain or a custom subdomain (e.g., `dent-brain.dentthefuture.com`).
2. Run `dent-brain init --multi-user` to create users/tokens/audit tables.
3. Create admin accounts for Jason and Steve.
4. Set up the Dropbox app integration for server-side ingestion (Dropbox API token stored as Railway env var).
5. Set up RSS feed URLs for the three v1 streams.
6. Verify `dent-brain doctor` passes all checks.
7. Create `dent-brain-data` private repo in Dent org. Server auto-initializes with namespace scaffolding and DENT_SCHEMA.md.
8. Issue member tokens for Jeff, Robin, Andreas, Morgan.

### 12.3 Jason's OpenClaw agent

1. Create service account `dent-agent@dentthefuture.com`.
2. Issue service token.
3. Add MCP endpoint to OpenClaw config with service token.

---

## 13. Data flow examples

**Example 1: Jason texts with Mike Cottmeyer.**
1. Jason in Cowork: "I just texted with Mike Cottmeyer. He's interested in Dent 2026 but travel-constrained in Q2. Wants dates ASAP."
2. Claude invokes `/append-evidence entities/people/mike-cottmeyer "Texted with Mike. Interested in Dent 2026 but travel-constrained in Q2. Wants dates ASAP."`
3. Server writes evidence record. Author: jason@dentthefuture.com. Source: user-paste:jason:<timestamp>.
4. Materializer queues a rebuild of `entities/people/mike-cottmeyer.md`.
5. Within a minute, his page updates — confirmed facts get a new entry, evidence timeline shows Jason's contribution.

**Example 2: Jeff has lunch with Mike next day.**
1. Jeff in Cowork: "Had lunch with Mike Cottmeyer. Definitely interested, wants keynote slot. Asked about audience size and comp."
2. `/append-evidence` produces new evidence record. Author: jeff@dentthefuture.com.
3. Materializer rebuilds Mike's page. Now shows both observations in evidence timeline. Confirmed facts consolidate ("Interested in Dent 2026"). Working inferences include "likely wants keynote." Open questions include "comp expectations."

**Example 3: "Did we already pitch Mike Cottmeyer?"**
1. Steve in Cowork: "Did we already pitch Mike Cottmeyer as a sponsor?"
2. `/sales-check` reads entity page, filters evidence for sponsor/commercial context.
3. Returns: "No sponsor pitch on record. He's in the speaker pipeline (see speakers/2026-pipeline.md) but no commercial conversations in evidence log."

**Example 4: Dropbox drop folder ingest.**
1. Jeff drags a speaker brief PDF and a meeting transcript into the team's Dropbox drop folder.
2. Next morning, Railway cron scans folder. New files detected.
3. Classifier routes: PDF to `/ingest-document`, transcript to transcript parser.
4. Evidence records created for each. Source: `dropbox:drop:<path>`. Author: `service:dropbox-ingestor`.
5. Entity pages for mentioned people/companies get rebuilt.
6. Jeff checks `/ingest-status` and sees his files were processed cleanly.

**Example 5: Granola meeting by two attendees.**
1. Jason and Jeff have a meeting about speaker outreach. Both use Granola.
2. Jason's scheduled task fires at 7am, ingests the meeting via his Granola MCP. Evidence record created, attributed to Jason.
3. Jeff's scheduled task fires at 8am, ingests the same meeting via his Granola MCP. Second evidence record, attributed to Jeff.
4. Both records reference `entities/people/mike-cottmeyer` (discussed in meeting).
5. Mike's page gets two new evidence entries. Both versions of the meeting notes are preserved. Materializer synthesizes across both.
6. No conflict because we didn't try to merge the two versions into one meeting page — each is separate evidence.

**Example 5b: Gmail ingest using the native connector.**
1. Jeff set up a Gmail filter that auto-applies the `dent` label to messages from @dentthefuture.com addresses and a few partner domains. His Cowork scheduled task runs `/ingest-gmail-today` at 7:15am daily.
2. Task queries Dent Brain for Jeff's last ingested Gmail cursor. Gets message ID from last run.
3. Task invokes Gmail connector: `search_messages(label:"dent", after:<cursor>)`. Returns 4 new threads.
4. For each thread: `read_message` fetches full content. Skill parses with the same code `/ingest-email` uses for pasted email.
5. Evidence records created with `source: gmail:jeff:<msg-id>`, `author: jeff@dentthefuture.com`. Entities detected (Mike Cottmeyer mentioned in one thread; a sponsor from a new company mentioned in another).
6. Entity pages get rebuilt. The new sponsor contact gets a stub page. Mike's page picks up the new email observation.
7. Cursor advances server-side — if Jeff also runs Claude on his iPad later that day, the ingest doesn't duplicate.

**Example 6: Dropbox historical import.**
1. Phase 6. Jason points `/ingest-dropbox-tree` at a bounded subtree (e.g., just 2025 meeting notes).
2. Server walks the tree, classifies each file, produces evidence records with `batch_id: dropbox-import-2026-04-20`.
3. Materializer rebuilds all affected entity pages.
4. Jason spot-checks pages. If anything's wrong, `/quarantine-batch dropbox-import-2026-04-20` hides the whole batch; fix the classifier; re-run.
5. When clean, next subtree. Eventually full import.

**Example 7: Stream ingest.**
1. Railway cron fetches Jason's X feed via RSS.
2. New posts since last fetch get stream records in `streams/jason-twitter/`.
3. For each post, entity-detection pass: if Mike Cottmeyer is mentioned, evidence record also created referencing his entity.
4. Jason's tweets appear in the stream view AND as evidence on mentioned entities' pages.

---

## 14. What we're explicitly NOT building in v1

- Page-level ACLs. All authenticated users see all namespaces.
- External user access (speakers, sponsors, attendees).
- Real-time collaboration or presence.
- Rich media (audio, video). Text/markdown only.
- SSO. Tokens issued manually and DM'd.
- Server-side ingest for Google Drive, MailerLite, Slack archive. All v1.1.
- Server-side Gmail collector (fallback for when users are away). v1.1 if needed. v1 uses user-side Gmail connector via Cowork scheduled tasks.
- Web UI. Cowork + CLI only.

---

## 15. v1.1 integration roadmap

| Integration | Runtime | Priority |
|---|---|---|
| Google Drive sync | Server-side | High |
| MailerLite sync | Server-side | High |
| Slack archive | Server-side | Medium |
| Calendar-to-brain | Server-side | Medium |
| Server-side Gmail fallback (for when users are away) | Server-side via dedicated brain@dentthefuture.com inbox | Medium |
| More streams (other team members) | Server-side | As needed |
| Page-level ACLs | Server-side | When first external user joins |

---

## 16. Build plan

Phases are sized for Claude Code + gstack, one coherent phase per focused work session.

### Phase 0 — Fork and baseline
- Fork gbrain to `dentthefuture/dent-brain`.
- Rename CLI entry point.
- Verify all gbrain tests pass.
- Deploy vanilla gbrain to Railway, confirm it starts.

### Phase 1 — Identity, auth, and Supabase
- Migrate to Supabase.
- Add users + tokens + audit tables.
- Middleware resolves bearer → user → request context.
- Admin CLI commands.
- Tests for auth middleware.

### Phase 2 — Evidence log and replay tooling (CRITICAL FOUNDATION)
- Define evidence schema in Postgres.
- Add `append_evidence` MCP tool.
- Build materializer: evidence → entity page.
- Implement `rebuild_entity` and `rebuild_all` commands.
- Implement `quarantine_batch` and `diff_entity` commands.
- Write unit tests covering: append idempotency, materializer determinism, rebuild correctness, quarantine round-trip.
- **Success gate:** can inject test evidence records, rebuild an entity, quarantine, restore.

### Phase 3 — Namespace structure and Dent schema
- Create `dent-brain-data` repo with full namespace layout.
- Write `DENT_SCHEMA.md` with entity types and conventions.
- Seed a few handwritten entity pages (Jason, Steve, Dent itself) to test.

### Phase 4 — Git archive (periodic snapshots, not transactional)
- Snapshot job runs hourly: rsync entity layer to git repo, commit with summary, push.
- Manual snapshot command for after batch jobs.
- Skip git entirely for evidence layer (stays in Postgres).

### Phase 5 — User-pushed ingest skills
- `/append-evidence` skill.
- `/ingest-granola-meetings` skill (fork gbrain's meeting-sync logic, swap data source).
- `/ingest-email` skill with a shared parser (handles both pasted email and emails fetched by `/ingest-gmail-today`).
- `/ingest-gmail-today` skill (wraps Claude's native Gmail connector, uses shared parser, writes evidence).
- `/ingest-notes` skill.
- Manual testing with real Dent content from Jason.

### Phase 6 — Server-side ingestors
- Dropbox drop folder cron.
- RSS ingestors for Jason's X, Steve's LinkedIn, Dent blog.
- Scraper webhook endpoint.
- Each ingestor has its own service token and audit trail.
- Health dashboard via `/ingest-status`.

### Phase 7 — Dropbox historical import
- Build `/ingest-dropbox-tree` with classification and staged import.
- Dry run on full tree; review classifications.
- Staged imports subtree by subtree.
- Full import on a branch, review diff, merge.

### Phase 8 — Dent-native intelligence skills
- `/prep-speaker`, `/sales-check`, `/dent-status`, `/session-plan`, `/dent-library`, `/who-knows-whom`, `/evaluate-session`, `/marketing-brief`.
- Test each with real content from Phase 7 import.

### Phase 9 — Cowork plugin bundle
- Plugin bundles: MCP connector config, skills, install instructions.
- Test install on fresh Cowork instance.

### Phase 10 — Team onboarding
- Admin setup for Jason and Steve.
- Jeff first (existing Granola user, alpha). Walk him through: Dent Brain connector, Gmail label creation and filter, first `/ingest-granola-meetings` run, first `/ingest-gmail-today` run, setting up daily scheduled tasks for both.
- Iterate on install flow based on Jeff's feedback.
- Roll out to Robin, Andreas, Morgan.
- Connect Jason's OpenClaw agent.

### Phase 11 — Observe, harden, v1.1 planning
- Two weeks of real use.
- Correctness metrics (see §17).
- Retro captured in the brain itself.
- Prioritize v1.1.

---

## 17. Success criteria

v1 is successful if, 30 days after rollout, ALL of these are true.

**Adoption:**
1. All 6 team members have used the brain at least weekly.
2. At least 100 entity pages exist.
3. At least 3 team members have a recurring Granola ingest running.
4. At least 3 team members have a recurring Gmail ingest running with a reasonable Dent label filter.

**Correctness (the metrics the adversarial review demanded):**
5. >95% of claims in entity confirmed-facts sections have valid source backlinks.
6. <5% of Granola meeting ingests produce a duplicate evidence record that wasn't caught by dedup.
7. <20% of Dropbox-imported files required human correction or reclassification.
8. Median time from ingest to searchable availability <5 minutes.
9. Zero silent conflicts — every contradiction is either flagged in the conflicts section or resolved with evidence.
10. `rebuild_all` completes cleanly without error and produces entity pages identical to the live versions.

**Hygiene:**
11. Jason can answer "where did this come from?" for any claim in <30 seconds via `get_provenance`.
12. No Jason personal context has leaked into Dent Brain; no Dent context trapped in Jason's personal brain.
13. At least one team member says "I can't imagine going back."

---

## 18. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Materializer has subtle bugs that silently corrupt entity pages | High | Rebuild from evidence is always possible; tests cover determinism; diff tool catches regressions |
| Evidence log grows unboundedly | Medium | Postgres can handle millions of rows; archive old evidence to cold storage if needed |
| Dropbox classification errors pollute entity pages | Medium | Staged import; quarantine tool; every import is a reversible batch |
| Granola speaker attribution wrong for 4+ person meetings | High | Skill flags ambiguous attributions; for critical meetings, prompt user to confirm |
| Stream RSS feeds break or change format | Low | Each ingestor logs to `/ingest-status`; stream failures don't block anything else |
| Team forgets to set up scheduled tasks | Medium | `/dent-status` surfaces ingest gaps; weekly reminder if no activity from a user |
| Gmail label filters capture wrong mail | Medium | Per-user controlled; `/ingest-status` shows what was ingested so users can audit; easy to adjust filter |
| Gmail attachments not ingested | Low | Known limitation; users drop important attachments into Dropbox drop folder for server-side ingest |
| Upstream gbrain changes break our layers | Medium | Our code sits above gbrain, not inside it; merge pain should be low |
| Scope creep from "just add an ACL" requests | Medium | v1.1 has a defined ACL roadmap; resist in v1 |
| Jason's personal Dropbox content leaks into Dent drop folder | Medium | Drop folder is a dedicated Dropbox folder only Dent team can access, separate from Jason's personal |

---

## 19. Cost estimate (monthly, steady state)

| Item | Cost |
|---|---|
| Railway (Bun server + volume) | $10-25 |
| Supabase (Pro for Postgres + pgvector) | $25 |
| GitHub (Dent org, private repo) | $0 |
| Granola (per-user) | $60-90 |
| Dropbox (shared team folder) | $0 (existing) |
| OpenAI API (embeddings) | $5-15 |
| Anthropic API (query expansion) | $0-10 |
| **Total** | **~$100-165/mo** |

Cheaper than v0.5's Circleback-based estimate because we dropped ngrok and are using Granola that three members already pay for.

---

## 20. Portability note (for future open-source or other-org use)

The architecture separates cleanly into three layers:
1. **Generic core** — evidence log, materializer, replay/rebuild tools, auth, audit. Not Dent-specific.
2. **Domain config** — namespace definitions, entity types, classification rules. Dent-specific but user-configurable.
3. **Skills** — intelligence layer. Mix of generic (append-evidence) and domain-specific (prep-speaker).

Another organization adopting this would customize layer 2 (their own namespaces and entity types) and layer 3 (their own skills), without touching layer 1. That's the portability story. Not a priority for v1, but the architecture supports it.

---

*End of v0.7. Design is locked. Next step: hand this doc to Claude Code with gstack and begin Phase 0 with `/office-hours` to pressure-test.*
