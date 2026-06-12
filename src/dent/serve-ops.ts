/**
 * Pure op-registry assembly for the dent HTTP MCP surface (single-brain
 * Stage C). Extracted from serve.ts so the registry shape is testable
 * without booting the server (serve.ts has module-level side effects:
 * env validation, engine connect, cron start).
 *
 * Trust boundary: the caller passes the upstream op set ALREADY filtered
 * through the canonical `operations.filter(op => !op.localOnly)` expression
 * — that filter must stay literally inside serve.ts where
 * scripts/check-operations-filter-bypass.sh pins it. This helper only owns
 * the merge order: upstream first, dent appended (tools/list ordering;
 * dispatch lookup is name-keyed).
 */

import type { Operation } from '../core/operations.ts';
import { entityDetectionOperations } from './operations/entity-detection.ts';
import { markdownWriteOperations } from './operations/markdown-write.ts';
import { exportOperations } from './operations/export.ts';

/**
 * Merge the (pre-filtered, remote-safe) upstream ops with the dent op sets.
 */
export function assembleServeOps(remoteSafeCoreOps: Operation[]): Operation[] {
  return [
    ...remoteSafeCoreOps,
    ...entityDetectionOperations,
    ...markdownWriteOperations,
    ...exportOperations,
  ];
}
