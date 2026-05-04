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

## Mode 2: Hand-edit through git (PLAN v2.0 Phase 3)

Sometimes you want to edit a markdown page directly — fix a typo on someone's
page, add a structured fact you want phrased exactly your way, or write a
meeting note while offline. The brain treats markdown as canonical, so
hand-edits push back through GitHub and reach Cowork queries within a few
minutes.

This mode is **optional**. Cowork-only works for everyone. Hand-editing is
for teammates who'd rather work in a code editor than dictate to an agent.

### One-time setup

You need:

- A GitHub account that has been added as a collaborator to
  `dentthefuture/dent-brain-data` (the markdown repo). Ask your admin if
  you don't have that yet.
- `git` installed.

Clone the repo somewhere convenient on your Mac:

```bash
mkdir -p ~/gh/dentthefuture
cd ~/gh/dentthefuture
git clone git@github.com:dentthefuture/dent-brain-data.git
cd dent-brain-data
```

Verify your remote is set up correctly:

```bash
git remote -v
# origin  git@github.com:dentthefuture/dent-brain-data.git (fetch)
# origin  git@github.com:dentthefuture/dent-brain-data.git (push)
```

Configure your local git identity for this repo so commits are attributable
to you:

```bash
git config --local user.name "Your Name"
git config --local user.email "you@dentthefuture.com"
```

Done. From now on, the workflow is git-native.

### The workflow

1. **Always pull before you edit.**

   ```bash
   cd ~/gh/dentthefuture/dent-brain-data
   git pull --ff-only
   ```

   The Dent server pushes commits to this repo every time an agent writes
   (via `/dent-append-evidence` and friends), and other teammates push
   their hand-edits the same way. Pulling first reduces the chance of a
   merge conflict.

2. **Edit the markdown file** in your editor of choice. Pages live under
   `entities/people/<name>.md`, `entities/companies/<name>.md`,
   `entities/projects/<name>.md`, and `meetings/YYYY-MM-DD-<slug>.md`.
   Conventions:
   - Frontmatter goes at the top (between two `---` fences). Don't change
     `slug` or `filemaker_record_id` unless you know what you're doing.
   - Pages are **unstructured by default**. Don't impose section
     scaffolds — match whatever structure the page already has, or add a
     simple top-level prose paragraph.
   - Date-anchored bullets go under `## Timeline` in this exact format:
     ```
     - **2026-05-02** | The founder confirmed the 2026 conference dates in our 1:1. [Source: meetings/2026-05-02]
     ```
     The `- **YYYY-MM-DD** | …` shape is what gbrain's
     `parseTimelineEntries` recognizes and auto-extracts into a
     timeline-entries index. Get the format right and the bullet shows up
     in chronological queries for free.

3. **Commit and push.**

   ```bash
   git add path/to/edited-file.md
   git commit -m "Update the founder's page with 2026 dates"
   git push origin main
   ```

   Use a descriptive commit message — git history is the audit trail for
   who changed what.

4. **Wait ~5 minutes** for the server to pull your change and re-index.
   The Dent server runs a `git pull --ff-only` on `dent-brain-data` every
   `DENT_BRAIN_PULL_INTERVAL_SECONDS` seconds (default 300 = 5 minutes).
   After the pull, your edit is visible in Cowork queries.

5. **Verify** by asking Cowork:

   > "What do we know about the founder's role at the 2026 conference?"

   The new content should surface in the answer.

   If it doesn't surface within 10 minutes of your push, ping the admin —
   either the cron is misconfigured, or there's a sync error to debug.

### Conflict handling

Two scenarios:

**You edited but the server pushed a commit while you were typing.**

```bash
git pull --rebase
# resolve any conflicts (rare — agents and humans usually edit different
# parts of different pages)
git push origin main
```

The server only fast-forwards on its scheduled pull, so it won't fight
your push. The agent-write op (`markdown_append_to_page`) pulls before
committing AND retries with `git pull --rebase` if the push is rejected,
so concurrent agent + human writes converge automatically. Worst case:
the agent's bullet stacks above yours (or vice versa), no conflict.

**Two teammates pushed conflicting edits.**

Same `git pull --rebase` flow. This is a normal git workflow — resolve
the conflict in your editor, `git add`, `git rebase --continue`, push
again.

### What NOT to do

- **Don't push to other branches.** The Dent server only watches `main`.
  A push to a feature branch is invisible to Cowork until you merge.
- **Don't force-push to main.** The server's incremental sync logic
  uses commit ancestry to compute what changed. A force-push that
  rewrites history makes the server fall back to a full re-import,
  which is slow and racy.
- **Don't commit large binaries.** The repo is markdown + git. If you
  want to attach a file, link to it from cloud storage in the page body
  rather than committing it.
- **Don't edit `entities/people/_quarantined/`** by hand unless you're
  cleaning up after a bad agent write. That namespace is a soft-delete
  parking lot.

### The relationship to Cowork-mode writes

You can mix and match. Hand-edit a page when you want to write the prose
exactly right, then go back to Cowork and use `/dent-append-evidence` for
in-the-moment captures. Agent writes show up as commits authored by
`dent-brain-server <noreply@dentthefuture.com>`; your hand-edits show up
as commits authored by you. `git log` is the audit trail for both.

If you ever need to know who added a specific bullet to a page:

```bash
git log -L /<text-to-find>/,+1:entities/people/some-person.md
```

…produces the commit and author for the line that contains that text.

---

## Reference

- Server: `https://dent-brain.dentthefuture.com`
- Repo: `https://github.com/dentthefuture/dent-brain-data`
- Architecture: see `docs/dent-brain/PLAN_v2_MARKDOWN_CANONICAL.md`
- Operator runbook: see `docs/dent-brain/DEPLOY.md`
