/**
 * RegFox / Webconnex API v2 response types.
 *
 * Source: https://docs.webconnex.io/api/v2/
 *
 * Only the fields the ingestor actually consumes are typed; the API
 * returns more (custom fieldData with arbitrary form responses,
 * billing/address detail, etc.). Extra fields ride along as `unknown`
 * via the index-signature on `RegfoxRegistrant`.
 */

export interface RegfoxBilling {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  street1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * `fieldData` is the customer's free-form custom-form responses. Shape
 * varies per form — the ingestor only extracts a few well-known paths
 * (discount/coupon code) on a best-effort basis. Everything else is
 * preserved on the registrant page later via `/dent-enrich` if needed.
 */
export type RegfoxFieldData = Record<string, unknown>;

export interface RegfoxRegistrant {
  id: number;
  displayId?: string;
  formId: number;
  formName?: string;
  customerId?: number;
  orderCustomerId?: number;
  orderId?: number;
  orderDisplayId?: string;
  orderNumber?: string;
  orderEmail?: string;
  orderEmailOptIn?: boolean;
  status?: string;
  sourceType?: string;
  total?: string | number;
  amount?: string | number;
  outstandingAmount?: string | number;
  currency?: string;
  checkedIn?: boolean;
  dateCheckedIn?: string;
  dateCreated?: string;
  dateUpdated?: string;
  billing?: RegfoxBilling;
  fieldData?: RegfoxFieldData;
  // Allow extra fields the API returns to ride along untyped.
  [k: string]: unknown;
}

export interface RegfoxApiResponse<T> {
  responseCode: number;
  data: T[];
  totalResults?: number;
  startingAfter?: number;
  hasMore?: boolean;
  error?: { code: number; message: string };
}

export interface RegfoxRateLimitInfo {
  /** Burst remaining in the current 15-minute window. */
  burstRemaining: number | null;
  /** Daily remaining. */
  dailyRemaining: number | null;
  /** Unix timestamp when burst window resets. */
  burstReset: number | null;
}
