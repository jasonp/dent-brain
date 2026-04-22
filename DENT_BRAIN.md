# Dent Brain

**A collaborative knowledge operations system for the Dent Conference team.** Built as an extension of [gbrain](https://github.com/garrytan/gbrain), federating with an existing FileMaker CRM to combine unstructured evidence (meeting notes, emails, observations) with structured relationships (people, tags, registrations, payments).

**Owner:** Jason Preston (with the Dent team)
**Status:** Pre-Phase-0 (plan approved, bootstrap underway)
**Substrate:** gbrain v0.16.0 (see `upstream` remote → `garrytan/gbrain`)
**Data repo:** `dentthefuture/dent-brain-data` (private, Dent-owned)
**Eng-cleared plan:** [`docs/dent-brain/PLAN.md`](docs/dent-brain/PLAN.md) (MVP v1.1)

## What this is

Dent Brain is a shared brain used by the Dent Conference team (Jason, Steve, Jeff, Robin, Andreas, Morgan) through Claude Desktop + Cowork. Every observation the team makes — a text exchange with a speaker, a lunch conversation, an email thread, a meeting summary — lands as an immutable evidence record in Postgres. A materializer synthesizes evidence into compiled entity pages (confirmed facts, working inferences, open questions, conflicts, evidence timeline) published as markdown to a private GitHub repo. Entity pages reference FileMaker record IDs and federate at query time with Steve's custom FileMaker MCP, so structured truth (identity, tags, registrations, payments) stays authoritative in FM while unstructured knowledge ops happen here.

## Architecture at a glance

```
┌──────────────────────────────────────────────┐
│ Each team member's Mac                       │
│   Claude Desktop (+ Cowork sessions)         │
│     ├── FM MCP       (stdio, local)          │ ─► FileMaker Server
│     │     • Steve's server (plugin/fm-mcp/)  │     (sea-17.fmsdb.com)
│     │     • Per-user mcp_<user> account      │
│     │                                        │
│     └── Dent Brain   (HTTP, remote)          │ ─► Railway
│           • Remote connector URL             │      • Dent Brain server (this repo)
│           • Per-user bearer token            │      • Postgres + pgvector
│                                              │      • Materializer queue (pg-boss)
└──────────────────────────────────────────────┘      • Audit log
```

**Dent Brain = shared state** (Postgres evidence, materializer, audit) → centralized HTTP service.
**FM MCP = per-user auth, no shared state** → local stdio, installed per Mac via `/setup-filemaker-mcp`.

## What lives where (this repo)

| Path | What |
|---|---|
| `src/`, `skills/`, `recipes/`, `templates/`, `test/`, `eval/`, `scripts/` | **gbrain substrate** — unchanged from upstream. Pull upstream updates via `git fetch upstream && git merge upstream/master`. |
| `plugin/fm-mcp/` | **Steve's FileMaker MCP** (Node.js stdio, adopted from `_reference/FMP Connector/FileMaker MCP/`, credit preserved). Ships as part of the Dent Brain plugin bundle. |
| `docs/dent-brain/PLAN.md` | Current MVP plan (v1.1). Single source of truth. |
| `docs/dent-brain/design-history/` | All prior plan revisions (v0.7 → v1.1). Don't edit — history. |
| `docs/dent-brain/reference/` | FileMaker schema screenshots, Steve's install guide, `mcp_claude` setup reference. |

**Future additions** (per PLAN.md Phase 0-8) will live alongside gbrain's code:
- `src/dent/evidence/` — evidence log schema + append API
- `src/dent/materializer/` — synthesis, validator, rollback
- `src/dent/federation/` — FM MCP client wrapper
- `src/dent/auth/` — user / token / audit tables
- `skills/dent/` — `/append-evidence`, `/flag-fact`, `/setup-filemaker-mcp`, etc.

Keeping Dent additions under `dent/` subdirectories by construction — upstream merges from gbrain stay clean because we never touch `src/<top-level>/`.

## Getting started

```bash
# Clone (once you have access)
git clone https://github.com/jasonp/dent-brain.git ~/gh/dent-brain
cd ~/gh/dent-brain

# gbrain install (this is Phase 0)
bun install
bun link
gbrain init                     # local brain, ready in 2 seconds (PGLite)

# Run gbrain's existing tests to verify substrate works
bun test
```

Then follow `docs/dent-brain/PLAN.md` from Phase 0 onward. The plan is eng-review-cleared with 10 architecture + 7 code-quality + 3 performance decisions locked.

## Relationship to gbrain (upstream)

This repo **is** a private fork of gbrain. gbrain is at `upstream` remote; Dent Brain is at `origin`.

**Policy:** we never modify gbrain's core files. All Dent-specific code lives under `src/dent/`, `skills/dent/`, `plugin/fm-mcp/`, or `docs/dent-brain/`. Upstream pulls are clean merges:

```bash
git fetch upstream
git merge upstream/master
# Expect zero conflicts as long as we respect the namespace rule above
```

If conflicts ever arise, it means we crossed the line and modified gbrain core. Fix by moving our change into a layer above.

## License

gbrain's `LICENSE` (MIT, from Garry Tan) governs the substrate code. Dent Brain's own additions (`plugin/fm-mcp/`, `src/dent/`, `skills/dent/`, `docs/dent-brain/`) are owned by Dent The Future, Inc. and licensed TBD (probably MIT once we're sure the substrate pattern holds).

## Credits

- **Substrate:** [Garry Tan](https://github.com/garrytan) — gbrain.
- **FileMaker MCP:** Steve Broback — custom 395-line Node.js stdio server that connects Claude Desktop to the Dent CRM via the FileMaker Data API. Adopted from `_reference/FMP Connector/FileMaker MCP/`.
- **Dent Brain design:** Jason Preston + Steve Broback + the Dent team.
