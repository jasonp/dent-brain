/**
 * Regression — one malformed file must not freeze the whole sync.
 *
 * The 2026-06 incident: two granola files carried a SLUG_MISMATCH. The legacy
 * gate blocked the *entire* `last_commit` advance on ANY per-file failure, so a
 * deterministic content error that no retry can fix silently stalled indexing
 * for 17 days. `shouldBlockOnSyncFailures` is the policy that now distinguishes
 * deterministic content failures (quarantine + proceed) from potentially
 * transient ones (keep blocking so the next sync retries).
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldBlockOnSyncFailures,
  classifyErrorCode,
  DETERMINISTIC_PARSE_CODES,
} from '../src/core/sync.ts';

// The literal message importFromFile throws for the incident's failure mode.
const SLUG_MISMATCH_MSG =
  'Frontmatter slug "meetings/x-outreach-" does not match path-derived slug "meetings/x-outreach"';
const slugFail = { error: SLUG_MISMATCH_MSG };
const yamlFail = { error: 'YAML parse failed: bad indentation' };
const timeoutFail = { error: 'canceling statement due to statement timeout' };
const headDriftFail = { error: 'git HEAD drifted during sync: captured abc, now def' };

describe('classifyErrorCode + DETERMINISTIC_PARSE_CODES', () => {
  test('the incident message classifies as a deterministic SLUG_MISMATCH', () => {
    expect(classifyErrorCode(SLUG_MISMATCH_MSG)).toBe('SLUG_MISMATCH');
    expect(DETERMINISTIC_PARSE_CODES.has('SLUG_MISMATCH')).toBe(true);
  });

  test('transient + infra failures are NOT deterministic', () => {
    expect(classifyErrorCode(timeoutFail.error)).toBe('STATEMENT_TIMEOUT');
    expect(DETERMINISTIC_PARSE_CODES.has('STATEMENT_TIMEOUT')).toBe(false);
    // The `<head>` git-drift sentinel has no pattern → UNKNOWN → must block.
    expect(classifyErrorCode(headDriftFail.error)).toBe('UNKNOWN');
    expect(DETERMINISTIC_PARSE_CODES.has('UNKNOWN')).toBe(false);
  });
});

describe('shouldBlockOnSyncFailures', () => {
  test('no failures never blocks', () => {
    expect(shouldBlockOnSyncFailures([])).toBe(false);
  });

  test('the incident — all deterministic content failures — does NOT block', () => {
    expect(shouldBlockOnSyncFailures([slugFail, yamlFail])).toBe(false);
  });

  test('a possibly-transient failure still blocks (so it gets retried)', () => {
    expect(shouldBlockOnSyncFailures([timeoutFail])).toBe(true);
    // Mixed: the transient one forces a block; the deterministic ones ride along
    // and are re-attempted on the next walk.
    expect(shouldBlockOnSyncFailures([slugFail, timeoutFail])).toBe(true);
  });

  test('git HEAD drift blocks (advancing would persist an inconsistent tree)', () => {
    expect(shouldBlockOnSyncFailures([headDriftFail])).toBe(true);
  });

  test('--strict-failures restores the legacy block-on-any-failure gate', () => {
    expect(shouldBlockOnSyncFailures([slugFail], { strictFailures: true })).toBe(true);
  });

  test('--skip-failed advances past everything, even transient/infra', () => {
    expect(shouldBlockOnSyncFailures([timeoutFail], { skipFailed: true })).toBe(false);
    expect(shouldBlockOnSyncFailures([headDriftFail], { skipFailed: true })).toBe(false);
  });

  test('a pre-classified code is honored without re-parsing the message', () => {
    expect(shouldBlockOnSyncFailures([{ error: 'whatever', code: 'SLUG_MISMATCH' }])).toBe(false);
    expect(shouldBlockOnSyncFailures([{ error: 'whatever', code: 'STATEMENT_TIMEOUT' }])).toBe(true);
  });
});
