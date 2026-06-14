# Bug Report: email-sync installer mishandles Gmail 429, triggers spurious re-auth and an escalating rate-limit lockout

**Component:** dent-brain → `tools/email-sync/` (laptop daemon + installer)
**Discovered:** 2026-06-12, during a `/dent-update` (v0.38.0.0 → v0.45.0.0 re-install) on macOS (darwin).
**Severity:** High — a transient Gmail rate-limit (429) is misclassified as an auth/config failure, which (a) forces an unnecessary OAuth re-consent, (b) prints a misleading error that sends the operator down the wrong path, and (c) hammers the Gmail API hard enough to trip a *sticky, self-extending* per-user rate limit that blocks setup for an extended window. A previously-working daemon ends up inert and un-armable.

> Status: fix landed in v0.46.0.0 (`tools/email-sync/{google-client,install,collect}.ts`,
> `tools/extensions/cli.ts`, `skills/dent/update/SKILL.md`). The `file:line` references below
> were read from the v0.45.0.0 bundle and verified against `main` during the fix. §B7
> (shared OAuth app / quota) is deferred — see TODOS.

---

## Summary of the three distinct defects

1. **Misleading/lossy error reporting.** `probeGmail()` swallows the underlying error and returns `null`; the installer then `die()`s with `"Gmail probe failed. Check that <email> is on the Google Cloud test-user list and the OAuth client is a 'Desktop app'."` The *actual* failure was `HTTP 429 User-rate limit exceeded`. The operator is told to check test-user lists and client type — both irrelevant.

2. **429 misclassified as invalid tokens → spurious OAuth re-consent.** The installer's "skip OAuth if existing tokens are valid" check calls `probeGmail()`. When that probe returns `null` *for any reason* (including a transient 429), the installer concludes `"Existing tokens did not validate — re-running OAuth flow"` and opens a full browser consent dance. The old refresh token was perfectly valid; it was rate-limited, not revoked. This destroys/overwrites working `google-tokens.json` for no reason.

3. **Escalating, self-extending rate-limit lockout.** Each Gmail call during install (token exchange, the "skip" probe, the final probe) and each subsequent `preview`/`status` hits `users.getProfile`. Google returns `429 ... Retry after <T>`, and **every additional call pushes `T` ~15 minutes further into the future** — even a call made *after* the advertised `T` still 429s and re-extends. The client has no Retry-After awareness and no backoff, so normal operator retries (and the still-loaded launchd daemon) keep the lockout alive. Observed progression: `Retry after 19:16:46Z` → (one probe) → `19:34:08Z` → (one probe) → `19:56:13Z`.

---

## Evidence (verbatim)

Real error, surfaced only by calling `GoogleClient.health()` directly (the installer hides it):

```
HEALTH ERROR: Gmail profile probe failed: 429
```

Raw Gmail API response body:

```json
{ "error": {
  "code": 429,
  "message": "User-rate limit exceeded.  Retry after 2026-06-12T19:16:46.648Z",
  "errors": [{ "message": "User-rate limit exceeded.  Retry after ...",
               "domain": "global", "reason": "rateLimitExceeded" }],
  "status": "RESOURCE_EXHAUSTED" } }
```

What the installer printed instead:

```
==> Found existing OAuth tokens at .../google-tokens.json.
    Existing tokens did not validate — re-running OAuth flow.
...
✓ Tokens saved to .../google-tokens.json (chmod 0600)
==> Probing Gmail with the issued token...
ERROR: Gmail probe failed.
Check that jason@dentthefuture.com is on the Google Cloud test-user list and the OAuth client is a "Desktop app".
```

Note the contradiction: fresh full-scope tokens were minted and saved, then the very next probe 429'd — proving the tokens were never the problem.

---

## Reproduction

1. Have a working v0.38-era email-sync install with valid `google-tokens.json` + `config.json` (incl. `googleClientSecret`).
2. Re-run the v0.45 installer (`bun tools/email-sync/install.ts`, feeding `DENT_EMAIL_WORK_EMAIL`/`DENT_GOOGLE_CLIENT_ID`/`DENT_GOOGLE_CLIENT_SECRET`/`DENT_EMAIL_AUTHUSER` from the existing config).
3. If Gmail returns 429 at the "skip OAuth" probe (easy to induce by running a couple of `getProfile` calls first), the installer re-runs OAuth, then dies on the final probe with the test-user/Desktop-app message.
4. Retrying `dent-extensions preview email-sync` repeatedly extends the 429 window instead of clearing it.

---

## Suspected root-cause locations (verify against current code)

- `tools/email-sync/install.ts`
  - `probeGmail()` (~L115–121): `try { ...health() } catch { return null }` — collapses all errors (429, 401, network) into `null`, discarding the HTTP status.
  - OAuth skip logic (~L187–204): treats `probeGmail() === null` as "tokens invalid → re-run OAuth". No distinction between 429 (transient) and 401/invalid_grant (real auth failure).
  - Final probe + `die()` (~L207–212): hardcoded "test-user list / Desktop app" message regardless of the real cause.
- `tools/email-sync/google-client.ts`
  - `health()` throws `"Gmail profile probe failed: 429"` — it knows the status code but the caller throws it away. The token-refresh path (~L171, `client_secret: this.opts.clientSecret`) is fine; not implicated.
- `tools/email-sync/collect.ts`
  - `~L236` constructs `GoogleClient` and runs a `health()` probe on every daemon fire (~6h). FATALs on 429. Each fire consumes quota and can re-arm the lockout while it's already hot.

---

## Impact

- A transient, self-healing condition (rate limit) is converted into: a destroyed refresh token, an unnecessary browser consent flow, a misleading diagnosis, and a multi-hour lockout that blocks `preview`/`arm`.
- During an upgrade, this leaves a previously-working email daemon **inert and un-armable** until Gmail quota recovers.
- Operators following the printed error waste time auditing test-user lists and OAuth client types that are not the problem.

---

## Remediation options (in priority order)

### A. Code fixes (highest leverage, do these regardless)

1. **Propagate the HTTP status.** `probeGmail()` should return a discriminated result (`{ok:true,email}` | `{ok:false,status:number,retryAfter?:string,message}`) instead of `string | null`. Have `health()` attach the status code and parsed `Retry after` to the thrown error.
2. **Never re-run OAuth on 429.** In the skip-OAuth check, only re-consent on genuine auth failures (`401`, `invalid_grant`). On `429`/`5xx`, treat existing tokens as still valid and **skip** the dance.
3. **Fix the death message.** On a final-probe 429, print: `Gmail is rate-limiting this account (429). Retry after <T>. This is transient — do NOT re-authorize; re-run preview/arm after <T> with no intervening Gmail calls.` Reserve the test-user/Desktop-app text for actual `403`/`access_denied`.
4. **Respect Retry-After + back off.** Parse the `Retry after` timestamp (and/or `Retry-After` header). On 429, stop immediately — do not retry in a loop. Surface the wait time. Consider a single bounded exponential backoff (e.g. 2 tries) but never a tight loop.
5. **Stop probing so often.** The installer probes Gmail 2–3× (skip-check + final). Collapse to a single probe. In `collect.ts`, consider skipping the standalone `getProfile` health probe and instead validating identity off the first real `messages.list` page response, so each run costs one fewer quota unit.
6. **Idempotent-upgrade guard (separate, lower-priority defect).** v0.45 added the `user/filter.ts` requirement that v0.38 lacked; re-installing silently renders the old daemon inert (`⚠ no-filter`). The installer/`/dent-update` should detect "upgrading over an install that predates the filter contract" and warn the operator that `setup` is required, rather than leaving a working daemon quietly dead.

### B. Server / OAuth-app config

7. **Per-teammate OAuth clients or quota review.** All teammates share one "Dent Brain" Google Cloud OAuth app in *test mode*. Gmail API per-user/per-project quotas are shared and easy to exhaust. Options: request a Gmail API quota increase in the GCP project; move the app from *test* to *production/verified*; or issue each teammate their own OAuth client so one person's burst doesn't throttle others. Check **GCP Console → APIs & Services → Gmail API → Quotas** for the specific limit being hit (per-user vs per-project).

### C. Google-side / operational

8. **Cool-down playbook.** Document that the only fix for an active per-user 429 is to make **zero** Gmail calls for the full window (≥15 min, longer if escalated), including unloading the launchd daemon (`launchctl bootout gui/$(id -u)/com.dent.email-sync`) so it can't re-arm the lockout. Then a *single* probe to confirm recovery.

---

## Workaround used in the field (2026-06-12)

- Authored `~/.dent-brain/email-sync/user/filter.ts` (excludelist; drops noise + e-signatures).
- Booted out `com.dent.email-sync` so the daemon can't auto-write before an approved preview.
- Left email-sync **disarmed**, pending Gmail recovery, then `preview` → `arm`.
- granola-sync was unaffected and is live on v0.45.0.0.
