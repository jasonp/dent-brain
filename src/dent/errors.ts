/**
 * Dent-specific error codes layered on top of gbrain's `OperationError`.
 *
 * Per Eng-Review CQ5: minimum set is documented in
 * `~/gh/dent-brain-data/docs/ERROR_TAXONOMY.md` (private repo).
 *
 * `DentOperationError` extends `OperationError` so the http-mcp dispatcher's
 * `instanceof OperationError` check catches it and uses the same `toJSON()`
 * shape (`{error, message, suggestion?, docs?}`). The `code` field carries
 * a `DentErrorCode` value, narrowed for typing inside `src/dent/`.
 */

import { OperationError, type ErrorCode } from '../core/operations.ts';

export type DentErrorCode =
  | 'evidence_not_found'
  | 'evidence_entity_unknown'
  | 'entity_not_found'
  | 'auth_invalid'
  | 'fm_unreachable'
  | 'materializer_failed'
  | 'rate_limited';

export class DentOperationError extends OperationError {
  constructor(
    code: DentErrorCode,
    message: string,
    suggestion?: string,
    docs?: string,
  ) {
    super(code as unknown as ErrorCode, message, suggestion, docs);
    this.name = 'DentOperationError';
  }
}
