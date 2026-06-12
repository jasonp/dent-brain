# State of the Union — Distributed Brain public-readiness work

_Snapshot for picking work back up after a reboot. Written 2026-05-26._

## Where things stand

Two separate threads are in flight, on two branches.

### Thread A — Windows email-sync (branch `windows-email-sync`)
Cross-platform email-sync shipped (Bun installer, Task Scheduler abstraction).
**Status: done, awaiting real-world feedback.** Andreas (andreas@dentthefuture.com)
was onboarded as a Windows teammate; he has his install bundle and will report
bugs. No code action pending unless he hits issues.

- His onboarding token was minted live (`andreas` in `access_tokens`).
- Windows onboarding guide saved at `/Users/jasonpreston/gh/dent-brain-windows-onboarding.md`
  (top-level `~/gh`, not committed). Not yet given a fetchable URL — offered to
  commit it as `docs/dent-brain/TEAMMATE_INSTALL_WINDOWS.md` but didn't (your call).

### Thread B — Public-readiness rebrand (branch `docs/distributed-brain-rebrand`) ← CURRENT BRANCH
Preparing the repo to be shared publicly. **Two commits landed, nothing pushed, no PR.**

```
a85123c3 chore: keep real deploy identity out of git; untrack internal TODOS
30484f51 docs: rename product to "Distributed Brain"; de-identify for public release
```

Branched off `main` (good git hygiene — kept separate from the Windows work).

## What's DONE on the rebrand branch

**Commit 1 — rename + doc de-identification:**
- Product display name `Dent Brain` → **Distributed Brain**. Kept the `dent-brain`
  identifier (repo/package/MCP server/paths), the `dbrain` binary/shorthand, the
  `/dent-*` command prefix, and `{{prefix}}` templating. Added a naming note to the README.
- De-identified org-specific refs across docs/skills/tool-READMEs: `dentthefuture.com`
  → `example.com`, GitHub orgs → `your-org`, `DentCRM` → `the CRM`, standalone "Dent"
  → generic placeholders (Acme Conf, your team, the brain server), illustrative real
  names → placeholders (Alice/Alice Chen). Regenerated the plugin marketplace bundle.

**Commit 2 — manifest de-identification + TODOS untracking:**
- `plugin/manifest.json` now ships PLACEHOLDER deploy identity; real values live in
  `plugin/manifest.local.json` (**gitignored, present locally, intact**).
- `build:plugin` reads only the committed placeholder manifest → published bundle is
  always placeholder-safe (no `/ship`-leaks-real-bundle hazard).
- Onboarding skill reads `manifest.local.json` first (where the real server_url is
  needed); setup skill updated too.
- New `scripts/check-deploy-identity.sh` gate wired into `verify` — fails if real org
  identity reaches the public bundle surface.
- `TODOS.md` untracked (`git rm --cached`) + gitignored. **Local file kept.** References
  in CLAUDE.md / select-e2e.ts / add-ingestor skill updated.

`bun run verify` passes (deploy-identity + plugin-version + typecheck gates green).

## What's OPEN (next session) — flagged, NOT yet done

Code/history leaks beyond the docs+manifest scope:

1. **`src/dent/markdown-writer/repo.ts:95`** — hardcoded Dent fallback for the
   `DENT_BRAIN_DATA_REPO_URL` env var (+ `noreply@dentthefuture.com` git email default).
   FUNCTIONAL/live-config — only safe to placeholder if Railway actually sets that env var.
   **Next step: verify the Railway env, then genericize the fallback.**
2. **Test fixtures + `scripts/dent/test-markdown-write.ts`** still reference `dentthefuture`
   (test data / usage comments). Low risk; changing fixtures can shift assertions — small
   dedicated pass.
3. **Git history + CHANGELOG** still contain the real identity throughout. A truly clean
   public release needs a fresh/squashed history or `git filter-repo`. Significant,
   irreversible — plan explicitly before doing.

Decided/closed:
- Crediting **Steve Broback** as the FileMaker MCP author: keeping it (your call). No action.

## Important local-only files (gitignored — do NOT commit)
- `plugin/manifest.local.json` — real deploy identity (server_url, org, code_repo). The
  onboarding skill depends on this. **If it's ever lost, recover from `git show <pre-rebrand-sha>:plugin/manifest.json`.**
- `TODOS.md` — internal backlog (real names/data). Kept local; never commit.

## Pre-existing untracked (not mine, leave alone)
`.agents/`, `skills-lock.json` — were untracked before this work started.

## Resume checklist
1. `git checkout docs/distributed-brain-rebrand`
2. Confirm `plugin/manifest.local.json` and `TODOS.md` still present locally.
3. `bun run verify` should be green.
4. Pick up open item #1 (check Railway env → genericize repo.ts fallback), then #2, then
   scope #3 (history scrub) with the user.
5. Decide whether to push this branch / open a PR (not done yet) and whether to commit the
   Windows onboarding guide into docs/.
