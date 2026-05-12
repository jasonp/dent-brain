---
name: dent-add-ingestor
description: |
  Wire a new signal source into the brain. An ingestor is a server-side
  worker that translates an external signal (RegFox webhook, a Gmail
  message, a Granola transcript, a Dropbox file) into one or more
  `markdown_append_to_page` calls so the observation lands as a real
  commit in the markdown data repo. This skill walks the admin through
  the five-step wiring: pick the source, configure auth, write the
  translator, deploy, smoke-test.

  **Runtime: Claude Code Desktop only** (edits TypeScript in the code
  repo, configures Railway env vars, runs `git push` to deploy). See
  `docs/reference/runtime-conventions.md`.
triggers:
  - "dent-add-ingestor"
  - "add a new ingestor"
  - "wire up RegFox"
  - "wire up Gmail"
  - "add a signal source"
mutating: true
writes_pages: false
---

# /dent-add-ingestor

> **Status:** Phase 5 work in progress. The skill prose below is the
> intended user flow; concrete ingestor frameworks land in subsequent
> versions. Today: this skill is a checklist + scaffolding.

The brain captures observations through three input channels:

1. **Cowork conversational capture** — `/dent-append-evidence`. Already wired (this is Phase 1+2 work).
2. **Teammate hand-edits** — direct git commits to the markdown repo. Already wired (Phase 3+4 work, see TEAMMATE_GUIDE.md).
3. **Server-side ingestors** — what this skill is for. RegFox attendee data, Gmail threads from key contacts, Granola meeting transcripts, Dropbox-dropped notes. Each ingestor is a long-running worker that watches its source and writes through `markdown_append_to_page` when a signal lands.

Channel 3 is the highest-throughput input. Until ingestors are wired, the brain only knows what someone explicitly logged via Cowork or hand-edited.

---

## The five-step wiring

### Step 1. Pick a source

Common ones, in rough order of payoff:

| Source | What it sees | Wiring difficulty |
|---|---|---|
| **RegFox** | Conference registrations, attendees, payment status | Low — clean webhook + structured JSON |
| **Gmail** | Email threads with key contacts | Medium — OAuth, label-based filtering, body extraction |
| **Granola** | Meeting transcripts | Medium — depends on Granola's API surface; may require local-machine-side ingest |
| **Dropbox** | File drops of meeting notes, decks, contracts | Medium — webhook + content-type routing |
| **FileMaker change log** | CRM updates already federated read-side | High — requires FM-side trigger or polling; out of scope for MVP |

Pick the one that creates the most signal soonest. For Dent's MVP, **RegFox is the right first pick** — webhook-driven, no OAuth dance, payload is structured per-attendee.

### Step 2. Configure the source's auth + endpoint

Each ingestor needs:

- **Inbound auth.** RegFox webhook secret, Gmail OAuth refresh token, Dropbox OAuth, etc. Stored as Railway env vars (`dent_REGFOX_WEBHOOK_SECRET=…`).
- **Inbound endpoint.** A new HTTP route on the dbrain server. RegFox would hit `POST /ingest/regfox` (or similar). Gmail would be poll-based (cron tick fetches latest unread on a label).
- **Per-source rate limit.** Ingestors should call `markdown_append_to_page` no faster than the per-token write cap (30/min default). Bursty sources need a queue.

### Step 3. Write the translator

The translator is the per-source code that converts an inbound signal into:

- `slug` — which entity the observation is about. Often requires `detect_entities` or a per-source mapping (RegFox attendee → entity slug via FM linkage).
- `content` — a bulleted markdown observation, in the canonical date-anchored shape:
  ```
  - **YYYY-MM-DD** | <one-sentence summary> [Source: <stable-source-ref>]
  ```
- `section` — usually `## Timeline` for date-anchored, omit for EOF.

The translator lives in `src/dent/ingestors/<source>/`. Convention:

```
src/dent/ingestors/regfox/
  webhook-handler.ts       # HTTP route handler
  translator.ts            # signal → markdown_append_to_page args
  types.ts                 # source's payload schema
test/dent/ingestors/regfox/
  translator.test.ts
```

### Step 4. Deploy

1. Add the env vars to Railway.
2. Add the route registration in `src/dent/serve.ts` (a small router branch under `/ingest/<source>`).
3. Push, redeploy via `railway up`.
4. Configure the source side (RegFox webhook URL, Gmail watch, etc.) to point at the deployed endpoint.

### Step 5. Smoke test

Trigger a known signal — sign up a test registrant in RegFox, send a test email, drop a test file. Within seconds, you should see:

- An audit-log row in `mcp_request_log` with `operation = tools/call:markdown_append_to_page`.
- A real commit in the markdown data repo.
- The bullet visible in `git log -p` for the affected entity page.
- Cowork queries surface the new content within the cron-pull lag window.

If any link in the chain fails, the audit log + Railway logs tell you which one. Fix forward.

---

## What ships in v0.x today

This skill ships the user-facing checklist. The ingestor framework itself (per-source folders, route registration helpers, queue + rate limit infra) lands in **Phase 5 proper** as separate ships. Until then:

- **Today:** the admin can wire an ingestor by hand following this checklist + the existing `markdown_append_to_page` MCP op.
- **Phase 5.1 (next ship after this one):** RegFox ingestor as the first concrete instance. Adds `src/dent/ingestors/regfox/` + its `/ingest/regfox` route + tests + RegFox-side webhook config docs.
- **Phase 5.2+:** Gmail, Granola, Dropbox in subsequent ships.

Track Phase 5 progress in `TODOS.md` under `## dent-brain (PLAN v2.0 follow-ups)`.

---

## Anti-patterns

- **Don't bypass `markdown_append_to_page`.** Ingestors that write directly to the markdown working clone (or that call `put_page` against Postgres) reintroduce the v1.8 bug — Postgres-only writes invisible to git history.
- **Don't translate without a stable source-ref.** Every inbound bullet needs `[Source: <stable-pointer>]` so the audit trail back to RegFox attendee #12345 (or Gmail message-id, or Dropbox path) survives. Without a stable ref, observations become unfindable claims.
- **Don't fan out to multiple entity pages from a single signal without a clear rule.** A RegFox attendee maps to ONE person entity; a Gmail thread might mention three. The translator decides; whatever rule it picks needs to be deterministic + idempotent, so re-running an ingestor doesn't duplicate bullets.
