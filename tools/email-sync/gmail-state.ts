/**
 * Daemon-side Gmail call-avoidance state for email-sync.
 *
 * Two jobs, both about NOT calling Gmail:
 *
 * 1. **Cool-down.** A 429 hands back a rolling ~16-minute window, restarted by
 *    every call. Measured 2026-08-11: a scheduled fire and a manual probe 52
 *    minutes apart each got a retry-after exactly 15m56s in the future.
 *
 *    Note what this does NOT mean. The original bug report
 *    (`docs/issues/email-sync-429-and-reauth-ux.md` §3) read the window as
 *    *escalating*, because rapid operator retries kept restarting it. At the
 *    daemon's 6h cadence that cannot happen — it waits ~22x the stated window
 *    and still gets 429'd, which means the underlying quota is exhausted for
 *    hours regardless of what we do. **The pooled per-project quota (TODOS §B7)
 *    is the cause of the multi-hour stalls; this module is not a fix for them.**
 *
 *    What banking the window does buy: an operator or manual run cannot poke a
 *    known-live window, and a run that starts fine but hits its limit partway
 *    through stops instead of grinding the remaining fetches into 429s.
 *
 * 2. **Identity memo.** The wrong-account guard only needs to run when the
 *    tokens change, not on every fire. We remember which account a given
 *    refresh token verified as, so a steady-state run costs one fewer
 *    `users.getProfile` call (issue doc §A5). The token itself is never
 *    stored — only a salted-by-nothing SHA-256 prefix used for equality.
 *
 * Pure functions plus a small JSON file. No network, no process exit.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';

/**
 * Floor for a banked cool-down. The issue doc's cool-down playbook (§C8) puts
 * the minimum useful quiet period at 15 minutes; anything shorter risks poking
 * the window again and re-extending it, which is the whole failure mode.
 */
export const MIN_COOLDOWN_MS = 15 * 60_000;

/**
 * Ceiling for a banked cool-down. Gmail's retry-after is server-supplied, so a
 * bogus or wildly future value must not wedge the daemon indefinitely. 24h is
 * well past any observed window (the worst seen in the field was ~6h).
 */
export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/** Used when a 429 arrives with no parseable retry-after timestamp. */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

export interface VerifiedAccount {
  /** The Gmail address these tokens resolved to. */
  email: string;
  /** SHA-256 prefix of the refresh token that was verified. Not the token. */
  tokenFingerprint: string;
}

export interface GmailState {
  /** ISO timestamp before which we must make no Gmail calls. Null = clear. */
  cooldownUntil: string | null;
  /** Which call tripped the cool-down, for the operator reading the log. */
  cooldownReason: string | null;
  /** Identity memo, so the getProfile probe runs once per token, not per fire. */
  verifiedAccount: VerifiedAccount | null;
}

export function emptyGmailState(): GmailState {
  return { cooldownUntil: null, cooldownReason: null, verifiedAccount: null };
}

/**
 * Read the state file. Tolerant by design: a missing, unreadable, or malformed
 * file yields empty state rather than throwing. This file is an optimization
 * and a courtesy to the quota — never a reason to fail a run.
 */
export function loadGmailState(path: string): GmailState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return emptyGmailState();
  }
  if (!raw || typeof raw !== 'object') return emptyGmailState();
  const o = raw as Record<string, unknown>;
  const va = o.verifiedAccount as Record<string, unknown> | null | undefined;
  return {
    cooldownUntil: typeof o.cooldownUntil === 'string' ? o.cooldownUntil : null,
    cooldownReason: typeof o.cooldownReason === 'string' ? o.cooldownReason : null,
    verifiedAccount:
      va && typeof va.email === 'string' && typeof va.tokenFingerprint === 'string'
        ? { email: va.email, tokenFingerprint: va.tokenFingerprint }
        : null,
  };
}

export function saveGmailState(path: string, state: GmailState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  // Carries an account address; keep it owner-only like the tokens file.
  chmodSync(path, 0o600);
}

/**
 * Stable, non-reversible identifier for a refresh token, so we can tell
 * "same tokens as last run" from "re-authorized since last run" without ever
 * writing the credential to a second file.
 */
export function tokenFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
}

/**
 * Milliseconds left on the cool-down, or 0 when there is none / it has passed.
 * An unparseable `cooldownUntil` is treated as expired — fail open, since the
 * alternative is a daemon permanently unable to sync on a corrupt file.
 */
export function cooldownRemainingMs(state: GmailState, nowMs: number): number {
  if (!state.cooldownUntil) return 0;
  const until = Date.parse(state.cooldownUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - nowMs);
}

/**
 * Bank a cool-down from a Gmail 429.
 *
 * `retryAfter` is Gmail's own ISO timestamp when it gave us one (parsed by
 * `parseRetryAfter`). It is honored as-is inside [MIN, MAX] — we clamp rather
 * than trust blindly, so neither an over-eager short window nor an absurd long
 * one can hurt us.
 */
export function startCooldown(
  state: GmailState,
  retryAfter: string | null,
  nowMs: number,
  reason: string,
): GmailState {
  const parsed = retryAfter ? Date.parse(retryAfter) : NaN;
  const requested = Number.isNaN(parsed) ? nowMs + DEFAULT_COOLDOWN_MS : parsed;
  const clamped = Math.min(
    Math.max(requested, nowMs + MIN_COOLDOWN_MS),
    nowMs + MAX_COOLDOWN_MS,
  );
  return { ...state, cooldownUntil: new Date(clamped).toISOString(), cooldownReason: reason };
}

export function clearCooldown(state: GmailState): GmailState {
  return { ...state, cooldownUntil: null, cooldownReason: null };
}

/**
 * True when the wrong-account guard must actually call Gmail: no memo yet, or
 * the tokens have changed since the memo was written (re-auth, account switch).
 */
export function needsIdentityProbe(state: GmailState, fingerprint: string): boolean {
  return state.verifiedAccount?.tokenFingerprint !== fingerprint;
}

export function recordVerifiedAccount(
  state: GmailState,
  email: string,
  fingerprint: string,
): GmailState {
  return { ...state, verifiedAccount: { email, tokenFingerprint: fingerprint } };
}

/** Human-readable duration for log lines, e.g. "5h 12m" / "42m" / "38s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
