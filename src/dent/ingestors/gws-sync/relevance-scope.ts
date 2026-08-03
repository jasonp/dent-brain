/**
 * Relevance-scope filter: decide whether a Drive file is *ours* enough to earn a
 * pointer-card. This is the second, orthogonal gate — share-scope (see
 * share-scope.ts) asks "is this confidential?", this one asks "is this work?".
 *
 * Why both. The crawl lists every Doc/Sheet the identity can SEE, which for a
 * long-lived Google account includes everything anyone has ever shared with you:
 * a friend's league roster, a vendor's proposal, another org's plan. Those pass
 * share-scope trivially — the outside owner alone counts as "someone other than
 * you has access" — so a confidentiality gate can never exclude them. Ownership
 * is the signal that separates the two cases, and it is the one thing an outside
 * sharer cannot forge.
 *
 * Rules (when a config is supplied — otherwise the filter is inactive and every
 * file is included, preserving the pre-filter default):
 *   - On a shared drive → INCLUDE, subject to driveIds when that set is
 *     non-empty (a shared drive is inherently a team artifact).
 *   - Owner email in ownerEmails (your own accounts + named collaborators)
 *     → INCLUDE.
 *   - Owner's domain in ownerDomains (your company) → INCLUDE.
 *   - Everything else → EXCLUDE. No owner and no shared drive also excludes:
 *     we cannot attribute the file, so we fail closed the way share-scope does.
 *
 * Emails and domains are real PII and live in env config, never in committed
 * source.
 */

import type { DriveFile } from './types.ts';
import { parseEmailSet } from './share-scope.ts';

export interface RelevanceScopeConfig {
  /** Bare domains, no '@' (lowercased). e.g. the company's Workspace domain. */
  ownerDomains: Set<string>;
  /** Individual owner emails that qualify: your own accounts + collaborators. */
  ownerEmails: Set<string>;
  /** Shared-drive ids that qualify. EMPTY MEANS ALL shared drives qualify. */
  driveIds: Set<string>;
}

/**
 * The filter is inactive until at least one owner rule exists. driveIds alone
 * does NOT activate it — that set only narrows the shared-drive branch, so
 * treating it as an activator would silently exclude every My Drive file.
 */
export function relevanceScopeActive(cfg: RelevanceScopeConfig | undefined): cfg is RelevanceScopeConfig {
  return !!cfg && (cfg.ownerDomains.size > 0 || cfg.ownerEmails.size > 0);
}

export function shouldIncludeByRelevanceScope(file: DriveFile, cfg: RelevanceScopeConfig): boolean {
  // Shared drives are team containers by construction. When driveIds is
  // configured it acts as an allowlist; empty means every shared drive counts.
  if (file.driveId) return cfg.driveIds.size === 0 || cfg.driveIds.has(file.driveId);

  const owner = file.owners?.[0]?.emailAddress?.trim().toLowerCase();
  if (!owner) return false; // unattributable + not a shared drive → fail closed

  if (cfg.ownerEmails.has(owner)) return true;

  const at = owner.lastIndexOf('@');
  if (at < 0) return false; // malformed owner address → fail closed
  const domain = owner.slice(at + 1);
  return domain.length > 0 && cfg.ownerDomains.has(domain);
}

/**
 * Parse a comma/space-separated env value into a lowercased bare-domain set.
 * Tolerates '@example.com' and 'user@example.com' forms so a fat-fingered env
 * value still yields the intended domain rather than silently matching nothing.
 */
/**
 * Build the relevance-scope config from raw env values, or undefined when the
 * gate is off. Pure + exported so the ACTIVATION RULE is unit-testable — the
 * serve.ts block that would otherwise own it runs at module scope and needs a
 * live DATABASE_URL, so nothing could pin the rule there.
 *
 * The rule: activate on the NEW vars only (ownerDomains / collaboratorEmails).
 * selfEmails is already set in every deployed brain, so letting it activate the
 * gate would turn a routine deploy into a silent mass-prune of every card owned
 * by a teammate. selfEmails still CONTRIBUTES to ownerEmails once active, so
 * docs you own on a personal domain survive an owner-domains-only config.
 */
export function buildRelevanceScope(
  env: {
    ownerDomains?: string;
    collaboratorEmails?: string;
    includeDriveIds?: string;
  },
  selfEmails: Set<string>,
): RelevanceScopeConfig | undefined {
  const ownerDomains = parseDomainSet(env.ownerDomains);
  const collaboratorEmails = parseEmailSet(env.collaboratorEmails);
  if (ownerDomains.size === 0 && collaboratorEmails.size === 0) return undefined;
  return {
    ownerDomains,
    ownerEmails: new Set([...selfEmails, ...collaboratorEmails]),
    driveIds: parseIdSet(env.includeDriveIds),
  };
}

/**
 * Parse a comma/space-separated env value into a set of opaque ids. Unlike
 * parseEmailSet this does NOT lowercase — Drive file/drive ids are
 * case-sensitive, and folding them would silently match nothing.
 */
export function parseIdSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function parseDomainSet(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (raw ?? '').split(/[,\s]+/)) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    const at = t.lastIndexOf('@');
    const domain = at >= 0 ? t.slice(at + 1) : t;
    if (domain) out.add(domain);
  }
  return out;
}
