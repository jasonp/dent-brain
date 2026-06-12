# Markdown Write Internal Errors + Large-Page Append Failure

> Filed 2026-06-10 from a live `/dent-append-evidence` session (filing a speaker
> suggestion). Three distinct issues surfaced in one workflow.

## Summary

While capturing a single observation via `/dent-append-evidence`, three problems
showed up:

1. **`markdown_append_to_page` consistently fails on a very large page.** Every
   attempt (5×, including a 20s backoff) to append a one-line Timeline bullet to
   `entities/people/dean-browell` returned `Error: Internal error`. That page is
   unusually large — hundreds of Timeline entries plus two full LinkedIn profile
   dumps pasted inline. Strong suspicion: the splice/commit/re-index op times out
   (or OOMs) on pages past some size threshold.
2. **`markdown_replace_page` returns transient `Internal error`.** Creating the
   new `entities/people/amy-kurtz` page failed once with `Error: Internal error`,
   then succeeded on an immediate retry with identical input (commit `fa186ac`).
   Non-deterministic — points at a flaky/transient failure (timeout, connection
   reset, race) rather than bad input.
3. **FileMaker MCP unreachable.** `fm_find_records` against the People layout
   returned `Error: fetch failed` on both attempts, so the new person page could
   not be auto-linked to a `filemaker_record_id`. May be environmental (FM bridge
   down at the time) rather than a code bug, but worth confirming.

## Problem

**What the user sees:** Filing one observation took multiple silent retries.
The primary write (Amy Kurtz page) eventually landed, but the secondary
cross-reference bullet on the referrer's page (Dean Browell) could not be written
at all — the op just keeps returning a generic `Internal error` with no actionable
detail. A new person also couldn't be linked to FileMaker.

**Impact:**
- Large/hot entity pages become effectively **append-locked** — any future ingest
  pipeline or skill targeting `dean-browell` (a board member, so a frequent
  target) will fail the same way. This is a silent data-loss risk: an ingestor
  that doesn't retry/surface will drop the observation.
- Transient `Internal error` on writes means skills must defensively retry every
  write, and a single non-retried call can lose data.
- Generic `Internal error` gives no signal (timeout? lock? size cap? push
  conflict?), making diagnosis hard from the client side.

## Repro

1. `markdown_append_to_page({ slug: "entities/people/dean-browell",
   section: "## Timeline", content: "<one bullet>", commit_note: "..." })`
   → `Error: Internal error`, reproducible 5/5 (with a 20s pause before the last).
2. `markdown_replace_page` for a brand-new slug → `Internal error` once, then
   `status: "ok"` on identical retry.
3. `fm_find_records({ layout: "People", query: [{ "Full_Name": "Amy Kurtz" }] })`
   → `Error: fetch failed`, 2/2.

## What landed despite the errors

- `entities/people/amy-kurtz.md` created — commit `fa186ac522bf66fb940cdbfe9680f1edd9cd76e3`.
- The Dean Browell back-reference bullet did **not** write (the suggestion itself
  is fully captured on Amy's page, which names Dean as referrer).

## Suspected causes / next steps

- **Large-page append:** profile `markdown_append_to_page` against `dean-browell`.
  Check for a timeout on the read→splice→commit→re-index path; consider a size
  guard, streaming/append-only commit that skips full-page reparse, or chunking
  oversized pages. Separately: why does this page have two inline LinkedIn PDF
  dumps? Page bloat itself may be the root cause and worth a cleanup/`/dent-enrich`
  pass.
- **Transient replace error:** add structured error detail (distinguish timeout
  vs. lock-busy vs. push-rebase-failed vs. internal) instead of collapsing to
  `Internal error`, so callers can retry intelligently.
- **FM unreachable:** confirm whether the FileMaker MCP bridge was down at the
  time or whether this is a recurring connectivity issue. The new `amy-kurtz`
  page has no `filemaker_record_id` and should be re-linked once FM is reachable.
