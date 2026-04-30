/**
 * Dent-specific type extensions over the gbrain core contract.
 *
 * Kept separate from `src/core/` so upstream merges from `garrytan/gbrain`
 * never collide with our additions.
 */

import type { OperationContext } from '../core/operations.ts';

/**
 * OperationContext extended with the author identity of the calling user.
 *
 * Populated by `src/dent/server/http-mcp.ts` after bearer-token verification:
 * `author` is set to `access_tokens.name`, which the onboarding skill
 * (`/dent-onboard-teammate`) constrains to be a real human handle (`steve`,
 * `jeff`, etc). Phase 1 evidence rows carry this value through to the audit
 * trail without needing a separate users table.
 *
 * Dent operations cast `ctx` to `DentOperationContext` to read `author`. The
 * cast is safe because http-mcp.ts is the only entry point for dent ops and
 * always sets the field.
 */
export interface DentOperationContext extends OperationContext {
  author: string;
}
