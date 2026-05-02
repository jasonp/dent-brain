/**
 * Phase 4 entity-detection MCP op.
 *
 * Thin wrapper over the TS service at src/dent/entity-detection/service.ts
 * so Cowork-side skills (/dent-append-evidence, future Phase 6 amplifier)
 * can call the same primitive that the server-side Dropbox importer
 * (Phase 5) imports directly.
 */

import type { Operation } from '../../core/operations.ts';
import { DentOperationError } from '../errors.ts';
import { detectEntities } from '../entity-detection/service.ts';

const detect_entities: Operation = {
  name: 'detect_entities',
  description:
    "Tier-1 entity detection: scan text for mentions of brain entities (person/company/project pages) by exact title, alias, or first-name fallback. Returns matches with their filemaker_record_id when linked, plus capitalized name-like 'unknowns' the caller should escalate to FM lookup. Does NOT call FileMaker — FM access is per-user stdio; the calling skill runs the FM tier itself.",
  params: {
    text: {
      type: 'string',
      required: true,
      description: 'The text to scan (a meeting note, an email body, a Cowork message — anything).',
    },
  },
  handler: async (ctx, p) => {
    const text = p.text;
    if (typeof text !== 'string') {
      throw new DentOperationError(
        'evidence_entity_unknown',
        'detect_entities: text must be a string',
      );
    }
    return detectEntities(text, ctx);
  },
};

export const entityDetectionOperations: Operation[] = [detect_entities];
