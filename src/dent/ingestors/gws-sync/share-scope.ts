/**
 * Share-scope filter: decide whether a Drive file is "team-shared enough" to
 * earn a pointer-card. The brain is read by the whole team, but the crawl runs
 * as a superset identity (a founder account that can see private + founder-only
 * material). So a file gets a card only if it's shared beyond you and a
 * configured set of confidential pairings.
 *
 * Rules (when a config with self-emails is supplied — otherwise the filter is
 * inactive and every file is included, preserving the metadata-only default):
 *   - On a shared drive            → INCLUDE (inherently team-accessible).
 *   - Any group/domain/anyone grant → INCLUDE (broadly shared).
 *   - Sharing not readable by us    → EXCLUDE (can't verify scope; fail closed).
 *   - Otherwise INCLUDE iff someone OTHER than you (selfEmails) and your
 *     confidential pairings (excludePairEmails) has access. So: private-to-you,
 *     you-only-across-your-own-accounts, and you+<excluded-person>-only all
 *     EXCLUDE; you+<anyone-else> and you+excluded+third-party INCLUDE.
 *
 * Emails are real PII and live in env config, never in committed source.
 */

import type { DriveFile } from './types.ts';

export interface ShareScopeConfig {
  /** Your own identities (lowercased). Filter is inactive when this is empty. */
  selfEmails: Set<string>;
  /** People whose two-person docs with you stay private (lowercased). */
  excludePairEmails: Set<string>;
}

export function shareScopeActive(cfg: ShareScopeConfig | undefined): cfg is ShareScopeConfig {
  return !!cfg && cfg.selfEmails.size > 0;
}

/** Broad grant types that make a file team-(or world-)accessible on their own. */
const BROAD_TYPES = new Set(['group', 'domain', 'anyone']);

/** A grant that confers no live access (revoked/deleted account, or expired). */
function isInactiveGrant(p: { deleted?: boolean; expirationTime?: string }, nowMs: number): boolean {
  if (p.deleted === true) return true;
  if (p.expirationTime) {
    const t = Date.parse(p.expirationTime);
    if (!Number.isNaN(t) && t <= nowMs) return true;
  }
  return false;
}

export function shouldIncludeByShareScope(file: DriveFile, cfg: ShareScopeConfig, nowMs: number = Date.now()): boolean {
  if (file.driveId) return true; // shared drive → team-accessible
  const perms = file.permissions ?? [];
  if (perms.length === 0) return false; // sharing opaque to us → fail closed

  const principals = new Set<string>();
  for (const p of perms) {
    // Only an explicit broad grant force-includes. An unexpected/unknown type
    // must NOT (a malformed `type` could otherwise leak a private doc) — it
    // falls through to the principal path, which fails toward exclusion.
    if (p.type && BROAD_TYPES.has(p.type)) return true;
    if (p.type && p.type !== 'user') continue; // unknown non-user type → ignore
    if (isInactiveGrant(p, nowMs)) continue; // deleted/expired → no real access
    if (p.emailAddress) principals.add(p.emailAddress.toLowerCase());
  }
  for (const o of file.owners ?? []) if (o.emailAddress) principals.add(o.emailAddress.toLowerCase());

  for (const e of cfg.selfEmails) principals.delete(e);
  for (const e of cfg.excludePairEmails) principals.delete(e);
  // Anyone left = a real other party has access → worth a team pointer.
  return principals.size > 0;
}

/** Parse a comma/space-separated env value into a lowercased email set. */
export function parseEmailSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}
