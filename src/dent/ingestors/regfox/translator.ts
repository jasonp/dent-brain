/**
 * Pure translator: RegFox registrant → ingestion plan.
 *
 * No side effects. The orchestrator (ingest.ts) takes the plan and
 * decides what to actually write (append to existing entity, create
 * new stub, or send to pending review).
 */

import type { RegfoxRegistrant } from './types.ts';

export interface TranslatedRegistrant {
  /** Lowercased + trimmed for case-insensitive comparison. */
  email: string | null;
  /** Trimmed full name for slug derivation + name-match dedup. */
  fullName: string | null;
  /** Billing first / last name (for identity matching). Fallback-split from fullName. */
  firstName: string | null;
  lastName: string | null;
  /** Kebab-case slug derived from full name (preferred) or email local part. */
  proposedSlug: string;
  /** ISO date (YYYY-MM-DD) of dateCreated, used in the bullet. */
  isoDate: string;
  /** The bulleted line to append under `## Timeline`. */
  bullet: string;
  /** Frontmatter to use when creating a new stub entity. */
  stubFrontmatter: Record<string, string | number | boolean>;
  /** Stub body content (after frontmatter fence). */
  stubBody: string;
}

/** Common-shape paths the discount/coupon code might live under in `fieldData`. */
const DISCOUNT_PATHS = [
  'discount_code',
  'discountCode',
  'coupon',
  'coupon_code',
  'couponCode',
  'discount',
];

export interface TranslatorOptions {
  /** Override path inside fieldData where the discount code lives. Tried first. */
  discountFieldPath?: string;
}

export function translateRegistrant(
  r: RegfoxRegistrant,
  opts: TranslatorOptions = {},
): TranslatedRegistrant {
  const email = normalizeEmail(r.orderEmail);
  const fullName = deriveFullName(r);
  const { firstName, lastName } = deriveNameParts(r, fullName);
  const proposedSlug = deriveSlug(fullName, email);
  const isoDate = isoDateOf(r.dateCreated);

  const totalStr = formatTotal(r.total ?? r.amount, r.currency);
  const discountCode = extractDiscountCode(r.fieldData ?? {}, opts.discountFieldPath);
  const discountClause = discountCode ? ` with discount code ${discountCode}` : '';
  const formName = (typeof r.formName === 'string' && r.formName.length > 0) ? r.formName : `form ${r.formId}`;
  const sourceRef = `regfox/${r.formId}/${r.id}`;

  const bullet = `- **${isoDate}** | Registered for ${formName}${totalStr}${discountClause}. [Source: ${sourceRef}]`;

  const stubFrontmatter: Record<string, string | number | boolean> = {
    title: fullName ?? (email ?? `RegFox attendee ${r.id}`),
    slug: `entities/people/${proposedSlug}`,
    type: 'person',
    created_via: 'regfox-ingestor',
    regfox_registrant_id: r.id,
    regfox_form_id: r.formId,
    updated: isoDate,
  };
  if (email) stubFrontmatter.email = email;
  if (r.status) stubFrontmatter.regfox_status = r.status;

  const stubBody = `# ${stubFrontmatter.title}\n\nStub created by the RegFox ingestor on ${isoDate}. Run \`/dent-enrich\` after the page accumulates more observations to flesh it out.\n\n## Timeline\n\n${bullet}\n`;

  return { email, fullName, firstName, lastName, proposedSlug, isoDate, bullet, stubFrontmatter, stubBody };
}

/** First/last from billing when present, else split the derived full name. */
function deriveNameParts(r: RegfoxRegistrant, fullName: string | null): { firstName: string | null; lastName: string | null } {
  const billing = r.billing ?? {};
  const first = (billing.firstName ?? '').trim();
  const last = (billing.lastName ?? '').trim();
  if (first || last) return { firstName: first || null, lastName: last || null };
  if (!fullName) return { firstName: null, lastName: null };
  const toks = fullName.trim().split(/\s+/);
  if (toks.length === 1) return { firstName: toks[0], lastName: null };
  return { firstName: toks[0], lastName: toks[toks.length - 1] };
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Bare sanity check — not a full RFC validator.
  if (!trimmed.includes('@') || !trimmed.includes('.')) return null;
  return trimmed;
}

function deriveFullName(r: RegfoxRegistrant): string | null {
  const billing = r.billing ?? {};
  const first = (billing.firstName ?? '').trim();
  const last = (billing.lastName ?? '').trim();
  if (first && last) return `${first} ${last}`;
  if (typeof billing.fullName === 'string' && billing.fullName.trim().length > 0) {
    return billing.fullName.trim();
  }
  if (first) return first;
  if (last) return last;
  return null;
}

function deriveSlug(fullName: string | null, email: string | null): string {
  if (fullName) {
    const slug = kebabize(fullName);
    if (slug.length > 0) return slug;
  }
  if (email) {
    const local = email.split('@')[0];
    const slug = kebabize(local);
    if (slug.length > 0) return slug;
  }
  return 'unknown-attendee';
}

/** Lowercase, ASCII-fold, replace non-alphanumeric runs with single hyphen. */
export function kebabize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isoDateOf(raw: unknown): string {
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function formatTotal(total: unknown, currency: unknown): string {
  if (total == null) return '';
  const num = typeof total === 'number' ? total : Number.parseFloat(String(total));
  if (!Number.isFinite(num)) return '';
  const cur = typeof currency === 'string' && currency.length > 0 ? currency.toUpperCase() : 'USD';
  return ` ($${num.toFixed(2)} ${cur})`;
}

function extractDiscountCode(fieldData: Record<string, unknown>, override?: string): string | null {
  const tryPath = (path: string): string | null => {
    const v = path.split('.').reduce<unknown>((acc, k) => {
      if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[k];
      }
      return undefined;
    }, fieldData);
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return null;
  };
  if (override) {
    const v = tryPath(override);
    if (v) return v;
  }
  for (const p of DISCOUNT_PATHS) {
    const v = tryPath(p);
    if (v) return v;
  }
  return null;
}
