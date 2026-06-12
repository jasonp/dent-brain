# Dent Brain — Teammate Guide

How to work with Dent Brain as a teammate (not the deploy admin).
Two modes — pick whichever fits the moment.

> **Not installed yet?** This doc is the post-install reference. For the
> first-time install walkthrough (MCP connector, Cowork plugin, optional
> data-repo clone), see **[`TEAMMATE_INSTALL.md`](TEAMMATE_INSTALL.md)** —
> written so Cowork can read the URL and walk you through conversationally.

## Mode 1: Cowork-only (the default)

If you just want to talk to Dent Brain through Cowork — search the brain,
ask questions, log observations — you don't need to install anything beyond
the connector your admin set up for you. The admin onboards you with the
`/dent-onboard-teammate` skill, which gives you a one-paste install command
that registers the dent-brain MCP connector in Claude Desktop.

That's it. Open Cowork, ask a question. The brain answers from server-side
hybrid search.

## Mode 2: Browse the git mirror (read-only)

> **⚠️ The write path changed in v0.45.** The brain's canonical store is
> Postgres, and `dent-brain-data` is now a **one-way nightly export
> mirror** (DB → git, 10:00 UTC). **Pushing markdown to the repo no
> longer ingests anything.** If you hand-edit a `<slug>.md` file, the
> next nightly export will overwrite it with the DB rendering (or delete
> it, if no live DB page matches). To change brain content, write
> through the brain — `/dent-append-evidence`, `markdown_append_to_page`,
> `markdown_replace_page`, `put_page` — never through git.

The clone is still useful as a **read-only** view: grep across every
page, browse offline, diff what changed night to night. This mode is
**optional**; Cowork-only works for everyone.

### One-time setup

You need:

- A GitHub account that has been added as a collaborator (read access is
  enough) on `dentthefuture/dent-brain-data`. Ask your admin if you
  don't have that yet.
- `git` installed.

Clone the repo somewhere convenient on your Mac:

```bash
mkdir -p ~/gh/dentthefuture
cd ~/gh/dentthefuture
git clone git@github.com:dentthefuture/dent-brain-data.git
cd dent-brain-data
```

### The workflow

1. **Pull to refresh.** The mirror advances one commit per nightly
   export (plus on-demand `export_brain_now` runs by the admin):

   ```bash
   cd ~/gh/dentthefuture/dent-brain-data
   git pull --ff-only
   ```

2. **Read, grep, diff.** Pages live under `entities/people/<name>.md`,
   `entities/companies/<name>.md`, `entities/projects/<name>.md`, and
   `meetings/YYYY-MM-DD-<slug>.md`. Note the mirror is at most ~24h
   behind the DB — for the current state of a page, ask Cowork or call
   `get_page`.

3. **To change something you spotted,** go back to Cowork: use
   `/dent-append-evidence` for a new observation, or ask the agent to
   fix the page (it writes via `markdown_append_to_page` /
   `markdown_replace_page`). The write lands in Postgres immediately
   and shows up in the mirror after the next export.

### What NOT to do

- **Don't hand-edit and push `<slug>.md` pages.** The exporter owns
  every nested `*.md` file; your edit will be overwritten by the next
  export, and it is never ingested into the brain.
- **Exception:** repo-root files and any path with a `.`- or
  `_`-prefixed segment (README, workflow notes, `_meta/…`) are
  human-owned — the exporter never touches those.
- **Don't commit large binaries.** The repo is markdown + git.

### Page history and attribution

Page history lives in the DB now, not in per-write git commits. Use
`get_versions` (and `revert_version`) on a slug to see who changed what
and when; mirror commits are one bulk export per night authored by
`dent-brain-server <noreply@dentthefuture.com>`, so `git log` no longer
identifies the author of an individual edit.

---

## Reference

- Server: `https://dent-brain.dentthefuture.com`
- Repo: `https://github.com/dentthefuture/dent-brain-data`
- Architecture: see the `[0.45.0.0]` entry in `CHANGELOG.md` and `skills/migrations/v0.45.md`
- Operator runbook: see `docs/dent-brain/DEPLOY.md`
