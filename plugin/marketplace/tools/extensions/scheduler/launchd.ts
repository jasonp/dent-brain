/**
 * macOS scheduler: launchd via `launchctl` + a LaunchAgents plist.
 *
 * Lifted verbatim (behavior-identical) from the inline launchctl logic that
 * lived in cli.ts (isLaunchdLoaded / cmdArm bootstrap+bootout / cmdUninstall
 * bootout). The plist is now rendered programmatically here instead of via the
 * old `sed` on com.dent.email-sync.plist.template — one source of truth,
 * unit-testable, no template drift.
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import type { Scheduler, ScheduleSpec, ArmResult } from './index.ts';

/** launchd runs daemons in a minimal environment, so PATH must be set
 * explicitly or `bun` (and anything it shells to) won't resolve. Matches the
 * pre-port plist template. */
const LAUNCHD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** Render the LaunchAgents plist. Exported for tests. Output is byte-for-byte
 * equivalent to the legacy com.dent.email-sync.plist.template substitution. */
export function renderPlist(spec: ScheduleSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${spec.label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${spec.bunPath}</string>
        <string>${spec.entryScript}</string>
    </array>
    <key>StartInterval</key>
    <integer>${spec.intervalSeconds}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${spec.logPath}</string>
    <key>StandardErrorPath</key>
    <string>${spec.logPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${LAUNCHD_PATH}</string>
        <key>HOME</key>
        <string>${spec.home}</string>
    </dict>
</dict>
</plist>
`;
}

function uid(): number | null {
  const u = process.getuid?.();
  return typeof u === 'number' ? u : null;
}

export class LaunchdScheduler implements Scheduler {
  readonly kind = 'launchd' as const;

  stage(spec: ScheduleSpec): void {
    writeFileSync(spec.definitionPath, renderPlist(spec));
  }

  isLoaded(spec: ScheduleSpec): boolean {
    const u = uid();
    if (u == null) return false;
    const r = spawnSync('launchctl', ['print', `gui/${u}/${spec.label}`], { encoding: 'utf-8' });
    return r.status === 0;
  }

  arm(spec: ScheduleSpec): ArmResult {
    const u = uid();
    if (u == null) {
      return { ok: false, error: 'cannot determine uid — launchctl needs gui/<uid>.' };
    }
    if (!existsSync(spec.definitionPath)) {
      return { ok: false, error: `plist not found at ${spec.definitionPath}. Re-run install.` };
    }
    // Idempotent: tear down any prior bootstrap first.
    if (this.isLoaded(spec)) {
      spawnSync('launchctl', ['bootout', `gui/${u}`, spec.definitionPath], { stdio: 'inherit' });
    }
    const r = spawnSync('launchctl', ['bootstrap', `gui/${u}`, spec.definitionPath], { stdio: 'inherit' });
    if (r.status !== 0) {
      return { ok: false, error: `launchctl bootstrap failed (exit ${r.status}). Check Console.app for launchd errors.` };
    }
    return { ok: true };
  }

  disarm(spec: ScheduleSpec): void {
    const u = uid();
    if (u == null) return;
    if (existsSync(spec.definitionPath) && this.isLoaded(spec)) {
      spawnSync('launchctl', ['bootout', `gui/${u}`, spec.definitionPath], { stdio: 'inherit' });
    }
  }

  removeDefinition(spec: ScheduleSpec): void {
    if (existsSync(spec.definitionPath)) {
      try { unlinkSync(spec.definitionPath); } catch { /* best-effort */ }
    }
  }
}
