/**
 * Sync lock layer: the typed lock-busy error, the rich busy message,
 * `--break-lock` handling, and the partial-result envelope. Peeled out of
 * src/commands/sync.ts (containment sprint C13-C14) as a pure move —
 * `performSync` itself (the lock acquisition wrapper) stays in that file.
 */
import type { BrainEngine } from './engine.ts';
import type { SyncResult } from '../commands/sync.ts';

/**
 * v0.42.x (#1794, Part B): typed lock-busy error so callers can distinguish a
 * benign "another sync holds the lock, skip cleanly" from a real failure.
 * Subclasses Error so existing CLI handlers that print `err.message` keep the
 * rich `formatLockBusyMessage` text verbatim. The Minion `sync` handler catches
 * this to mark the job skipped (not failed) — single-flight backpressure: the
 * cron/autopilot sync defers to the holder instead of erroring + retrying noisily.
 */
export class SyncLockBusyError extends Error {
  readonly lockKey: string;
  constructor(message: string, lockKey: string) {
    super(message);
    this.name = 'SyncLockBusyError';
    this.lockKey = lockKey;
  }
}

/**
 * v0.41.6.0 D3: rich "Another sync is in progress" message that names the
 * holder PID, hostname, age, and the right --break-lock invocation to
 * recover. Falls back to the legacy message when inspectLock can't read
 * the row (best-effort — the lock itself was still busy).
 */
export async function formatLockBusyMessage(engine: BrainEngine, lockKey: string): Promise<string> {
  const { inspectLock } = await import('./db-lock.ts');
  let snap;
  try { snap = await inspectLock(engine, lockKey); }
  catch { snap = null; }

  if (!snap) {
    return (
      `Another sync is in progress (lock ${lockKey} held). ` +
      `Wait for it to finish, or run 'gbrain doctor' if it has been more than 30 minutes.`
    );
  }

  const ageHuman = formatAgeHuman(snap.age_ms);
  const breakHint = lockKey.startsWith('gbrain-sync:')
    ? `gbrain sync --break-lock --source ${lockKey.slice('gbrain-sync:'.length)}`
    : `gbrain sync --break-lock`;
  const ttlNote = snap.ttl_expired ? ' [TTL expired]' : '';
  return (
    `Another sync is in progress (lock ${lockKey} held by pid ${snap.holder_pid} on ${snap.holder_host}, ` +
    `started ${ageHuman} ago${ttlNote}).\n` +
    `If pid ${snap.holder_pid} is dead, re-run with --break-lock to clear it:\n` +
    `  ${breakHint}\n` +
    `Or wait for the holder to finish.`
  );
}

/**
 * Read `--flag value` OR `--flag=value`. The bare `args.find(a, i => args[i-1]
 * === '--source')` idiom used elsewhere in the sync CLI silently misses the
 * equals form; for a DESTRUCTIVE break that miss would fall through to the
 * ambient chain and clear a lock the operator never named.
 */
export function readFlagValue(args: string[], flag: string): string | null {
  const spaced = args.find((a, i) => args[i - 1] === flag);
  if (spaced !== undefined) return spaced;
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq === undefined ? null : eq.slice(flag.length + 1);
}

/**
 * CLI dispatcher for `gbrain sync --break-lock` / `--force-break-lock`:
 * decides WHICH source's lock key to target, then delegates each break to
 * `runBreakLock`. Returns the process exit code.
 *
 * The lock key is per-source (`gbrain-sync:<sourceId>`), so break-lock resolves
 * the source through the SAME precedence as the sync it is unblocking:
 * `--source` flag > `--repo`-derived > the ambient 6-tier chain. This used to
 * live inline in the CLI and read ONLY the `--source` flag, falling back to
 * `'default'` — so an operator whose source came from GBRAIN_SOURCE, a
 * `.gbrain-source` dotfile, or a cwd-matched `local_path` broke a key nobody
 * held and got "nothing to break" with exit 0 while the real lock stayed
 * wedged. Pinned by test/sync-break-lock-source-resolution.serial.test.ts.
 */
export async function runBreakLockCommand(
  engine: BrainEngine,
  opts: {
    explicitSource: string | null;
    /** `--repo <dir>`: anchors resolution at the repo, not the caller's cwd. */
    repoPath?: string;
    syncAll: boolean;
    force: boolean;
    json: boolean;
    maxAgeSeconds?: number;
  },
): Promise<number> {
  const { resolveSourceWithTier, resolveSourceForRepoPath } =
    await import('./source-resolver.ts');
  const per = { force: opts.force, json: opts.json, maxAgeSeconds: opts.maxAgeSeconds };

  /** Resolution failures must honor --json like every other exit in this file. */
  const failResolve = (msg: string): number => {
    if (opts.json) console.log(JSON.stringify({ status: 'error', error: msg }));
    else console.error(msg);
    return 1;
  };

  // `--all` skips resolution entirely, so an explicit narrowing flag alongside
  // it would be SILENTLY ignored and the run would go fleet-wide — a typo'd
  // `--source` becoming a force-delete of every lock. Contradictory intent is
  // refused, never resolved in favor of the destructive reading.
  if (opts.syncAll && (opts.explicitSource || opts.repoPath)) {
    return failResolve(
      `--all cannot be combined with ${opts.explicitSource ? '--source' : '--repo'} ` +
      `(--all breaks every source's lock; drop one to say which you meant).`,
    );
  }

  let sourceId = '';
  if (!opts.syncAll) {
    try {
      // #3765 parity: an explicit --repo anchors resolution at the REPO dir,
      // not the caller's cwd. Without this the break targets the cwd-resolved
      // key — the same wrong-key bug, one tier down.
      let resolved: { source_id: string } | null = null;
      if (!opts.explicitSource && opts.repoPath) {
        const derived = await resolveSourceForRepoPath(engine, opts.repoPath);
        if (derived) {
          const envSource = process.env.GBRAIN_SOURCE;
          if (envSource && envSource !== derived.source_id) {
            return failResolve(
              `--repo resolves to source '${derived.source_id}' (via ${derived.tier}) but ` +
              `GBRAIN_SOURCE='${envSource}' is set. Pass --source <id> to disambiguate.`,
            );
          }
          resolved = derived;
          process.stderr.write(
            `[gbrain] breaking the lock for source '${derived.source_id}' ` +
            `(resolved from --repo via ${derived.tier}).\n`,
          );
        }
      }
      sourceId = (resolved ?? await resolveSourceWithTier(engine, opts.explicitSource)).source_id;
    } catch (e) {
      // ARCHIVED sources must stay breakable. `assertSourceExists` filters
      // `archived = false`, so routing through the resolver would make a
      // wedged-then-archived source clearable only by hand-written SQL — and
      // break-lock is the recovery tool. An explicitly named source that
      // EXISTS (archived or not) is honored; a name that matches no row at all
      // stays a loud exit 1 so a typo can't silently "succeed".
      if (!opts.explicitSource) return failResolve(e instanceof Error ? e.message : String(e));
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = $1`,
        [opts.explicitSource],
      );
      if (rows.length === 0) return failResolve(e instanceof Error ? e.message : String(e));
      sourceId = rows[0].id;
      process.stderr.write(`[gbrain] source '${sourceId}' is archived — breaking its lock anyway.\n`);
    }
  }

  // Fan out ONLY on the explicit `--all` flag. An `__all__` sentinel arriving
  // from the resolver is deliberately NOT special-cased: `gbrain sync` has no
  // `__all__` handling either, so it hands the sentinel straight to
  // performSync, which takes `gbrain-sync:__all__`. Treating it as `--all`
  // here would force-delete every OTHER source's lock while leaving the very
  // key the wedged sync holds untouched — the exact asymmetry this function
  // exists to remove. Symmetry with sync is the invariant, not convenience.
  // v3's plan dropped the old --all refusal so cron can self-heal in one call.
  if (opts.syncAll) {
    const { listSources } = await import('./sources-ops.ts');
    const sources = await listSources(engine);
    // listSources omits archived sources by default. We also require
    // local_path because the lock key is per-source; pure-DB sources
    // (no local_path) don't hold sync locks.
    // NOTE: `sync --all` additionally filters `config.syncEnabled !== false`
    // (sync.ts, via its own SyncAllSourceRow query). This set is therefore
    // BROADER than the sync set — tracked in TODOS.md; matching it needs the
    // richer query, not `listSources`.
    const activeSources = sources.filter((s) => s.local_path);
    if (activeSources.length === 0) {
      if (opts.json) console.log(JSON.stringify({ status: 'no_sources' }));
      else console.error('No active sources to break-lock against.');
      return 0;
    }
    let worstExit = 0;
    for (const src of activeSources) {
      const exit = await runBreakLock(engine, `gbrain-sync:${src.id}`, src.id, per);
      if (exit > worstExit) worstExit = exit;
    }
    return worstExit;
  }

  return runBreakLock(engine, `gbrain-sync:${sourceId}`, sourceId, per);
}

/**
 * v0.41.6.0 D3: `gbrain sync --break-lock` / `--force-break-lock` worker.
 * Returns the process exit code (0 = lock cleared or absent; 1 = refused).
 *
 * Safe path (`force=false`): refuses unless the holder is on this host
 * AND either (a) TTL has expired (the lock is structurally available
 * already) OR (b) the holder PID is dead AND the lock is older than 60s
 * (the age guard defeats PID-reuse coincidence — Linux PID space wraps
 * at 32768 so a 10-day-old lock with pid=12345 may be falsely
 * refused-to-clear because an unrelated process now owns pid 12345; 60s
 * is the codex F7-amended minimum age that makes coincidence unlikely).
 *
 * Force path (`force=true`): skips liveness check, deletes the row,
 * warns loudly that the holder may still be writing.
 *
 * Both paths use the same atomic `DELETE ... RETURNING id` so a race
 * with another break-lock or with TTL-eviction can't produce confusing
 * post-conditions.
 */
export async function runBreakLock(
  engine: BrainEngine,
  lockKey: string,
  sourceId: string,
  opts: { force: boolean; json: boolean; maxAgeSeconds?: number },
): Promise<number> {
  const { inspectLock, deleteLockRow, deleteLockRowIfStale, classifyHolderLiveness } = await import('./db-lock.ts');
  const { hostname } = await import('os');
  const localHost = hostname();
  let snap;
  try { snap = await inspectLock(engine, lockKey); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.json) console.log(JSON.stringify({ status: 'error', error: msg, lock: lockKey }));
    else console.error(`Failed to inspect lock ${lockKey}: ${msg}`);
    return 1;
  }

  if (!snap) {
    // BUG 5 (v0.42.x): --force-break-lock used to emit the same terse "not
    // held" line and exit 0 even when a sync was genuinely wedged — sending the
    // operator down a dead end (the wedge was not a held lock). Keep rc=0
    // (breaking a non-existent lock is idempotently successful; flipping the
    // exit code would break automation that treats it as success), but under
    // --force say plainly that nothing was broken and point at the real next
    // step. The non-force path message is unchanged.
    if (opts.force) {
      const wedgeHint =
        `No lock is held on ${lockKey} — nothing to break. If a sync still ` +
        `appears wedged, the cause is not a held lock; inspect checkpoint/resume ` +
        `state with \`gbrain sync --source ${sourceId}\` or \`gbrain doctor\`.`;
      if (opts.json) {
        console.log(JSON.stringify({ status: 'absent', lock: lockKey, source_id: sourceId, wedge_hint: wedgeHint }));
      } else {
        console.log(wedgeHint);
      }
      return 0;
    }
    if (opts.json) console.log(JSON.stringify({ status: 'absent', lock: lockKey, source_id: sourceId }));
    else console.log(`Lock ${lockKey} is not held (nothing to break).`);
    return 0;
  }

  // v0.41.13.0 (T4 / D-V3-4 / D-V4-mech-4) — --max-age path: route through
  // deleteLockRowIfStale which runs a single atomic DELETE keyed on
  // (id, holder_pid, last_refreshed_at < NOW() - maxAge). Healthy refreshing
  // holders survive by construction (their last_refreshed_at is recent).
  // Wedged-but-alive holders (JS interval stopped firing) get broken.
  // No TOCTOU between inspect + delete; the WHERE clause is the gate.
  if (opts.maxAgeSeconds !== undefined && !opts.force) {
    // Cross-host guard preserved from the safe path: --max-age does NOT
    // bypass cross-host refusal because process.kill(pid, 0) is invalid
    // across hosts (PID is meaningful only on the same host). Operators
    // who need to clear a cross-host lock use --force-break-lock.
    if (snap.holder_host !== localHost) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused', reason: 'cross_host', lock: lockKey, source_id: sourceId,
          snapshot: snap, local_host: localHost,
        }));
      } else {
        console.error(`Lock ${lockKey} is held on a different host (${snap.holder_host}, this host is ${localHost}).`);
        console.error('Cross-host --max-age is unsupported. Use --force-break-lock when certain the remote holder is dead.');
      }
      return 1;
    }
    const { deleted, lastRefreshedAt } = await deleteLockRowIfStale(
      engine, lockKey, snap.holder_pid, opts.maxAgeSeconds,
    );
    if (opts.json) {
      console.log(JSON.stringify({
        status: deleted ? 'broken' : 'refused',
        reason: deleted ? 'max_age_breached' : 'within_max_age',
        lock: lockKey,
        source_id: sourceId,
        snapshot: snap,
        max_age_seconds: opts.maxAgeSeconds,
        last_refreshed_at: lastRefreshedAt ? lastRefreshedAt.toISOString() : null,
      }));
    } else if (deleted) {
      const ageStr = lastRefreshedAt ? formatAgeHuman(Date.now() - lastRefreshedAt.getTime()) : 'unknown';
      console.log(`Broke lock ${lockKey} (pid ${snap.holder_pid} on ${snap.holder_host}; last refresh was ${ageStr} ago, > --max-age=${opts.maxAgeSeconds}s).`);
    } else {
      // last_refreshed_at within --max-age window OR null (pre-v98 brain).
      // Distinguish the two cases for the operator.
      if (snap.last_refreshed_at === null) {
        console.error(`Lock ${lockKey} has NULL last_refreshed_at (pre-v98 brain or migration window).`);
        console.error('Run `gbrain apply-migrations --yes` to land v98, OR use --force-break-lock if you know the holder is dead.');
      } else {
        const ageStr = snap.ms_since_last_refresh != null ? formatAgeHuman(snap.ms_since_last_refresh) : 'unknown';
        console.error(`Refusing to break lock ${lockKey}: last refresh was ${ageStr} ago, within --max-age=${opts.maxAgeSeconds}s window.`);
        console.error('The holder is actively refreshing — likely a healthy long-running sync.');
      }
      return 1;
    }
    return 0;
  }

  // Force path: skip all guards, atomic DELETE, warn.
  if (opts.force) {
    const { deleted } = await deleteLockRow(engine, lockKey, snap.holder_pid);
    if (opts.json) {
      console.log(JSON.stringify({
        status: deleted ? 'force_broken' : 'race_already_cleared',
        lock: lockKey, source_id: sourceId, snapshot: snap,
      }));
    } else if (deleted) {
      console.log(`Force-broke lock ${lockKey} (was held by pid ${snap.holder_pid} on ${snap.holder_host}, age ${formatAgeHuman(snap.age_ms)}).`);
      console.log('WARNING: the holder may still be writing. Verify with `gbrain doctor` before re-running.');
    } else {
      console.log(`Lock ${lockKey} was already cleared by another process between our check and DELETE (race-safe).`);
    }
    return 0;
  }

  // Safe path: must be local host AND (TTL-expired OR (PID-dead AND age >= 60s)).
  if (snap.holder_host !== localHost) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'refused',
        reason: 'cross_host',
        lock: lockKey, source_id: sourceId, snapshot: snap, local_host: localHost,
      }));
    } else {
      console.error(`Lock ${lockKey} is held on a different host (${snap.holder_host}, this host is ${localHost}).`);
      console.error('Cross-host PID liveness is unsound. To break anyway, use --force-break-lock');
      console.error('(only safe when you KNOW the holder is dead — verify before forcing).');
    }
    return 1;
  }

  let safe = false;
  let reason: string;
  if (snap.ttl_expired) {
    safe = true;
    reason = 'ttl_expired';
  } else {
    // PID liveness on local host, via the shared predicate (v0.42 #1780 Gap 3).
    // Same gate as tryAcquireDbLock's auto-takeover: same-host + provably-dead
    // (ESRCH) + age >= 60s. EPERM is treated as ALIVE (the PID exists but isn't
    // ours) — never break a live lock. host is already == localHost here (the
    // cross-host branch returned above), so classify never yields 'cross_host'.
    const liveness = classifyHolderLiveness(snap.holder_pid, snap.holder_host, snap.age_ms);
    if (liveness === 'dead_eligible') {
      safe = true;
      reason = 'pid_dead_age_60s';
    } else if (liveness === 'too_young') {
      reason = 'pid_dead_but_lock_too_young';
    } else {
      // 'alive' | 'unknown' | 'cross_host' (the latter unreachable here).
      reason = 'pid_alive';
    }
  }

  if (!safe) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'refused', reason, lock: lockKey, source_id: sourceId, snapshot: snap,
      }));
    } else {
      console.error(`Refusing to break lock ${lockKey}: holder pid ${snap.holder_pid} appears alive on ${snap.holder_host} (age ${formatAgeHuman(snap.age_ms)}).`);
      if (reason === 'pid_dead_but_lock_too_young') {
        console.error('(PID is dead but the lock is younger than 60s — the PID may have been reused. Wait or use --force-break-lock if you are certain.)');
      } else {
        console.error('If the holder is wedged, kill it first then re-run --break-lock,');
        console.error('OR use --force-break-lock to clear regardless (the holder may still write afterwards).');
      }
    }
    return 1;
  }

  const { deleted } = await deleteLockRow(engine, lockKey, snap.holder_pid);
  if (opts.json) {
    console.log(JSON.stringify({
      status: deleted ? 'broken' : 'race_already_cleared',
      reason, lock: lockKey, source_id: sourceId, snapshot: snap,
    }));
  } else if (deleted) {
    console.log(`Broke lock ${lockKey} (was held by pid ${snap.holder_pid} on ${snap.holder_host}, age ${formatAgeHuman(snap.age_ms)}; reason: ${reason}).`);
  } else {
    console.log(`Lock ${lockKey} was already cleared by another process between our check and DELETE (race-safe).`);
  }
  return 0;
}

function formatAgeHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/**
 * v0.41.13.0 — build a SyncResult { status: 'partial' } envelope.
 *
 * D-V3-1 invariant: this is only ever called BEFORE the bookmark write at
 * sync.ts:writeSyncAnchor('last_commit'), so `last_commit` is NEVER advanced
 * on partial. The next sync re-walks last_commit..HEAD and `content_hash`
 * short-circuits already-imported files at ~10ms each. The caller's lock is
 * released by `withRefreshingLock`'s try/finally as soon as this returns.
 */
export function buildPartialResult(opts: {
  fromCommit: string | null;
  toCommit: string;
  filesImported: number;
  pagesAffected: string[];
  chunksCreated: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  reason: 'timeout' | 'pull_timeout' | 'pull_failed' | 'stall_timeout' | 'checkpoint_unavailable';
  bankedFiles?: number;
}): SyncResult {
  return {
    status: 'partial',
    fromCommit: opts.fromCommit,
    toCommit: opts.toCommit,
    added: opts.added,
    modified: opts.modified,
    deleted: opts.deleted,
    renamed: opts.renamed,
    chunksCreated: opts.chunksCreated,
    embedded: 0,
    pagesAffected: opts.pagesAffected,
    filesImported: opts.filesImported,
    reason: opts.reason,
    bankedFiles: opts.bankedFiles,
  };
}
