/**
 * Shared types for the email-sync collector (Layer 1 of the email pipeline).
 *
 * Layer 1 (this) is deterministic: pulls emails via Gmail API (direct OAuth),
 * filters noise, generates Gmail links, dedupes, writes a daily digest page
 * to the brain. No LLM in this layer — the email body never enters a model's
 * context.
 *
 * Layer 2 (skills/dent/process-inbox) is the cloud /schedule routine that
 * reads the digest pages and updates entity timelines.
 *
 * Auth: each teammate runs a one-time OAuth dance via install.sh against
 * the shared "Dent Brain" Google Cloud OAuth app (test mode, whitelisted).
 * The resulting refresh token is written to ~/.dent-brain/email-sync/google-tokens.json
 * (chmod 0600). The collector self-refreshes the access token on every run.
 */

/** A single Gmail message after collection + classification. */
export interface CollectedEmail {
  /** Gmail message id. Used for idempotency markers + Gmail links. */
  messageId: string;
  /** Gmail thread id (for replied-thread detection). */
  threadId: string;
  /** RFC 2822 Date header, parsed to ISO 8601. */
  date: string;
  /** Bare from address, e.g. "phil@example.com". */
  fromEmail: string;
  /** From display name when present. */
  fromName: string | null;
  /** All recipients (To + Cc + Bcc), bare addresses. */
  recipients: string[];
  /** Subject line, trimmed. */
  subject: string;
  /** ~250-char snippet from the body. NOT the full body — full body never
   *  enters a model's context, so we keep this terse. */
  snippet: string;
  /** Pre-built Gmail deep link with `authuser` parameter. */
  gmailLink: string;
  /** True if from is a noise sender (noreply, notifications@, etc.). */
  isNoise: boolean;
  /** True if subject or from matches a signature service (DocuSign etc.). */
  isSignature: boolean;
  /** True if the work-email-holder sent this (vs. received). */
  isOutbound: boolean;
}

/** Persistent cursor written to disk between runs. */
export interface SyncCursor {
  /** ISO timestamp of the most-recent message we've seen. */
  lastSyncedAt: string;
  /** Recent message ids (capped). Belt + suspenders against clock skew. */
  syncedMessageIds: string[];
  /** When this cursor was last written. */
  cursorUpdatedAt: string;
  /** Version of the collector that wrote this cursor. */
  syncVersion: string;
}

/** What lives in `~/.dent-brain/email-sync/config.json` after install. */
export interface SyncConfig {
  /** dent-brain MCP endpoint. Auto-discovered from ~/.claude.json. */
  serverUrl: string;
  /** Bearer token for the MCP endpoint. Auto-discovered. */
  bearerToken: string;
  /** Google OAuth 2.0 Client ID (Desktop app type). Shared across teammates;
   *  the install script bakes this in. Public — safe to ship in source. */
  googleClientId: string;
  /** Google OAuth 2.0 Client Secret. For Desktop app type, "secret" is a
   *  misnomer — Google treats this as a public identifier (it ships to
   *  every desktop install). Still kept in config to keep options open. */
  googleClientSecret: string;
  /** Path to the OAuth tokens file. Default: ~/.dent-brain/email-sync/google-tokens.json (chmod 0600). */
  googleTokensPath: string;
  /** The teammate's work email (e.g. steve@dentthefuture.com). The Gmail
   *  query strictly filters on this — emails on other addresses on the same
   *  inbox never come back. Privacy boundary. */
  workEmail: string;
  /** authuser index for Gmail link construction. Usually "0" for the
   *  primary account, "1" for a secondary, etc. Defaults to "0". */
  authUser: string;
  /** Path to the cursor JSON. */
  cursorPath: string;
  /** Path to the local digest cache (for debugging / re-runs). */
  cacheDir: string;
}

/** Per-run summary. Logged on every run for observability. */
export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  candidates: number;
  fetched: number;
  noise: number;
  signatures: number;
  /** Dropped by the teammate's user filter (after noise classification). */
  userFiltered: number;
  written: number;
  digestSlug: string | null;
  cursorAdvancedTo: string;
}

/**
 * Contract for a user-owned filter at `~/.dent-brain/email-sync/user/filter.ts`.
 *
 * Runs AFTER canonical `isNoise()` / `isSignature()` classification, BEFORE
 * grouping into daily digests. Decides whether each email reaches the shared
 * brain. The `email` argument carries `isNoise` and `isSignature` as hints —
 * the filter can use them or not.
 *
 * Iron rules:
 * - Pure function. No network, no fs, no env reads.
 * - Privacy bias: when ambiguous, `keep: false`. Inbound personal mail on the
 *   same address as work mail (rare but possible) is exactly what this filter
 *   exists to drop.
 * - Exclusion wins over inclusion if you compose both.
 */
export type FilterResult =
  | { keep: true; reason: string }
  | { keep: false; reason: string };

export interface UserFilterModule {
  /** Bumped only when the runtime contract changes. */
  RECIPE_VERSION: number;
  /** Required. Decides keep/skip per email. */
  filter: (email: CollectedEmail) => FilterResult;
}
