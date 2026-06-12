/**
 * Admin op for the one-way DB→git export mirror (single-brain Stage B).
 *
 * `export_brain_now` triggers exportBrainToGit on demand — the same code
 * path the nightly exporter cron runs — and returns its result. Scope
 * 'admin': it forks git + pushes to the dent-brain-data mirror, which is
 * operational machinery, not knowledge access.
 */

import type { Operation } from '../../core/operations.ts';
import { DentOperationError } from '../errors.ts';
import { ensureMirrorRepo } from '../exporter/repo.ts';
import { exportBrainToGit } from '../exporter/export.ts';

const export_brain_now: Operation = {
  name: 'export_brain_now',
  description:
    'Run the DB→git export immediately: render every live dent page to markdown in the dent-brain-data mirror, prune stale files, and push one commit. Same code path as the nightly exporter cron. Returns {written, deleted, committed, commit_sha?}. Requires the export mirror to be configured (DENT_BRAIN_DATA_DEPLOY_KEY).',
  params: {},
  mutating: true,
  scope: 'admin',
  handler: async (ctx, _p) => {
    if (!process.env.DENT_BRAIN_DATA_DEPLOY_KEY) {
      throw new DentOperationError(
        'fm_unreachable',
        'Export mirror is not configured on this server (DENT_BRAIN_DATA_DEPLOY_KEY unset).',
        'Set DENT_BRAIN_DATA_DEPLOY_KEY (and optionally DENT_BRAIN_DATA_REPO_URL / DENT_BRAIN_DATA_PATH) and redeploy.',
      );
    }
    if (ctx.dryRun) {
      return { dry_run: true, action: 'export_brain_now' };
    }
    const repoCtx = await ensureMirrorRepo(ctx.engine);
    const result = await exportBrainToGit(ctx.engine, repoCtx);
    if (result.status === 'busy') {
      throw new DentOperationError(
        'rate_limited',
        'An export is already running (dent-export lock held). Retry in a moment.',
      );
    }
    if (result.status === 'error') {
      throw new DentOperationError('fm_unreachable', `export failed: ${result.error}`);
    }
    return result;
  },
};

export const exportOperations: Operation[] = [export_brain_now];
