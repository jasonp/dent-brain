/**
 * Mailchimp member types — unified across CSV exports and (future) Marketing API.
 *
 * The CSV columns vary by export type (subscribed/unsubscribed/cleaned/recent),
 * but the underlying member shape is consistent. The CSV parser normalizes into
 * `MailchimpMember`; the translator is then csv-vs-api agnostic.
 */

export type MailchimpStatus = 'subscribed' | 'unsubscribed' | 'cleaned' | 'nonsubscribed';

export interface MailchimpMember {
  /** Lowercased + trimmed primary email. The `[Source: mailchimp/<EUID>]`
   * idempotency tag is built from EUID, but email is the entity-resolution key. */
  email: string;
  /** Mailchimp's stable member identifier (`EUID` column). Used for idempotency
   * tags and as the deduplication key. Required — members without an EUID are
   * dropped at the parser layer. */
  euid: string;
  /** Mailchimp internal subscriber ID (`LEID`). Optional, kept for cross-ref. */
  leid?: string;
  status: MailchimpStatus;
  /** When the member opted into the list. `OPTIN_TIME` column (subscribed
   * exports) or original signup timestamp from other exports. ISO date string. */
  optinDate?: string;
  /** When the member unsubscribed (status=unsubscribed only). ISO date. */
  unsubDate?: string;
  /** When Mailchimp cleaned (bounced) the address (status=cleaned only). ISO date. */
  cleanDate?: string;
  /** Last engagement / last_changed timestamp (best-effort). ISO date. */
  lastChanged?: string;
  /** Self-reported first name. */
  firstName?: string;
  /** Self-reported last name. */
  lastName?: string;
  organization?: string;
  title?: string;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  linkedinUrl?: string;
  /** Member rating 1–5. Mailchimp's engagement score. */
  memberRating?: number;
  /** Tag list — Mailchimp's TAGS column is a stringified JSON-ish list of
   * double-quoted entries. The parser splits and unquotes these. */
  tags: string[];
  /** Why the unsub fired (for unsubscribed members). Mailchimp `UNSUB_REASON`. */
  unsubReason?: string;
  /** The campaign that triggered the unsub (for unsubscribed members). */
  unsubCampaignTitle?: string;
  /** The campaign that triggered the bounce/clean (for cleaned members). */
  cleanCampaignTitle?: string;
  /** Original CSV row index — used for error reporting only. */
  rowIndex: number;
  /** Which CSV file this member came from. Used for provenance + filtering. */
  sourceFile: string;
}
