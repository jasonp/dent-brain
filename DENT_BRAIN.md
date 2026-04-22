# Dent Brain

**A collaborative knowledge operations system for the Dent Conference team.** Built as an extension of [gbrain](https://github.com/garrytan/gbrain), federating with an existing FileMaker CRM to combine unstructured evidence (meeting notes, emails, observations) with structured relationships (people, tags, registrations, payments).

**Owner:** Jason Preston (with the Dent team)
**Status:** Phase 0 in progress (substrate cloned, data repo seeded, plan eng-cleared)
**Substrate:** gbrain v0.16.0 (see `upstream` remote → `garrytan/gbrain`)
**This package's name:** `dbrain` — the open-source-distributable framework. The CLI binary is `dbrain` so personal `gbrain` installs and organizational `dbrain` installs coexist on the same machine.
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

This repo **is** a private fork of gbrain. gbrain is at `upstream` remote; this fork (`dbrain` framework, deployed as Dent Brain) is at `origin`.

**Policy:** we never modify gbrain's core files. All Dent-specific code lives under `src/dent/`, `skills/dent/`, `plugin/fm-mcp/`, or `docs/dent-brain/`. Upstream pulls are managed by:

```bash
bun run sync:upstream
# Wraps git fetch + merge + re-applies the gbrain → dbrain rename in package.json
# (the only file that conflicts on every pull)
# Then runs tests to confirm nothing else broke.
```

If non-rename conflicts arise, it means we crossed the line and modified gbrain core. Fix by moving our change into a layer above.

## Open-source posture and namespace separation

This framework is intended to be open-source-distributable in the future under the name `dbrain`. The CLI binary, package name, and build artifacts all use `dbrain` (not `gbrain`) so:

- Anyone running personal gbrain (Garry's reference distribution) keeps `gbrain` as their command.
- Anyone deploying organizational dbrain (this framework) gets `dbrain` as their command.
- Both can coexist on the same machine. Run personal queries via `gbrain ...`, run org-knowledge ops via `dbrain ...`.

**The substrate code (everything outside `src/dent/`, `skills/dent/`, `plugin/`, `docs/dent-brain/`) is gbrain code with the package metadata renamed.** When upstream gbrain ships features, we pull them via `bun run sync:upstream`.

## Multi-org architecture

`dbrain` is designed so multiple organizations can each deploy their own instance — Dent Brain is one such deployment. The architecture:

1. **Server deploys are single-tenant.** Each org runs their own Railway service, their own Postgres, their own data repo, their own bearer tokens. No multi-tenant code in the server (avoids data-isolation complexity entirely). Forking the repo and editing config is the deploy mechanism.

2. **Skill names get an org-prefix at plugin-build time.** The substrate provides skill TEMPLATES (e.g., `append-evidence`, `flag-fact`); the plugin builder substitutes the org-prefix from `plugin/manifest.json` (`deploy.org_prefix`) when packaging. For Dent: prefix is `dent`, so the skills installed in each Cowork are `/dent-append-evidence`, `/dent-flag-fact`, etc. For a hypothetical YC deployment: prefix would be `yc`, skills would be `/yc-append-evidence`, etc.

3. **Multi-org users coexist.** A team member who's in both Dent and another org installs both Cowork connectors (different URLs, different bearer tokens) and both skill bundles (different prefixes, no name collisions). They flow naturally: ask about Dent things, the prefixed-`dent-*` skills fire; ask about the other org's things, the other prefix fires.

The `plugin/manifest.json` is where org-specific configuration lives. Other orgs forking dbrain edit one file (manifest.json), rebuild the plugin, and they have their own deployment. The substrate code in `src/` is identical across all deployments.

## License

gbrain's `LICENSE` (MIT, from Garry Tan) governs the substrate code. Dent Brain's own additions (`plugin/fm-mcp/`, `src/dent/`, `skills/dent/`, `docs/dent-brain/`) are owned by Dent The Future, Inc. and licensed TBD (probably MIT once we're sure the substrate pattern holds).

## Credits

- **Substrate:** [Garry Tan](https://github.com/garrytan) — gbrain.
- **FileMaker MCP:** Steve Broback — custom 395-line Node.js stdio server that connects Claude Desktop to the Dent CRM via the FileMaker Data API. Adopted from `_reference/FMP Connector/FileMaker MCP/`.
- **Dent Brain design:** Jason Preston + Steve Broback + the Dent team.
