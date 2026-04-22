# Upstream Notes

Known quirks and caveats in the gbrain substrate (`garrytan/gbrain`) that affect our fork. Not bugs we need to fix — just things to be aware of.

---

## Test suite: 3 flaky tests under full-suite run (2026-04-22)

**Symptom:** Running `bun test` in full-suite mode, 3 tests fail deterministically with `beforeEach`/`afterEach` hook timeouts around 6.8-7s:

- `test/extract-fs.test.ts`
- `test/e2e/search-quality.test.ts`
- `test/e2e/graph-quality.test.ts`

**Diagnosis:**
- All 3 files **pass** when run in isolation (`bun test test/extract-fs.test.ts` — 24/24 in 2.1s).
- They use heavy PGLite setup in `beforeAll` hooks — each spins up an in-process Postgres and runs 14 migrations.
- Under the full 2154-test suite (116 files, ~78s total), these 3 tests' setup hooks contend for resources and hit Bun test runner's default timeout (appears to be ~5-7s).
- Classic pattern for PGLite-heavy test suites. Not a correctness issue; a concurrency/resource issue.

**Impact on Dent Brain:**
- Zero. We haven't added any code yet, so this is purely an upstream gbrain quirk.
- Pass rate is 99.86% (1972/1975 active tests, excluding skips).

**When we add our own tests (`src/dent/`, `test/dent/`):**
- Run our tests separately: `bun test test/dent/` (won't contend with substrate tests).
- If we ever need to run the FULL suite deterministically (e.g., pre-ship), we can bump timeouts for the 3 flaky files or run them serially via test-level config.

**Reproducibility:**
- Determinism verified with 2 full-suite runs on 2026-04-22 (same 3 tests, similar timings).
- Bun version: 1.3.11.

**Not filed upstream yet.** If it becomes annoying in CI, we'll report it to `garrytan/gbrain`. For now, documented here.
