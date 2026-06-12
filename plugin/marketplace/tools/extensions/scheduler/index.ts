/**
 * Cross-platform scheduler abstraction for Dent Brain daemon-kind extensions.
 *
 * The ingesters (email-sync, granola-sync) run on a periodic schedule plus at
 * login. macOS does this with launchd (plist + launchctl); Windows does it with
 * Task Scheduler (task XML + schtasks). Everything above this layer — the
 * install.ts core, the extensions CLI (arm/uninstall/status) — speaks one
 * interface and never branches on OS. `getScheduler()` returns the right impl
 * for `process.platform`.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ install.ts (linear core)   cli.ts (arm / uninstall / status)  │
 *   └───────────────┬───────────────────────────┬──────────────────┘
 *                   │  ScheduleSpec              │
 *                   ▼                            ▼
 *            ┌──────────────── Scheduler (interface) ───────────────┐
 *            │ stage · isLoaded · arm · disarm · removeDefinition    │
 *            └──────────┬───────────────────────────────┬───────────┘
 *        process.platform==='darwin'        process.platform==='win32'
 *                   ▼                                    ▼
 *          LaunchdScheduler                    TaskSchedulerScheduler
 *          (launchctl + plist)                 (schtasks + task XML)
 *
 * Schedule data (label, interval, paths) is platform-neutral; each impl renders
 * it into its own definition format and drives its own OS tool.
 */

import type { Extension } from '../types.ts';
import { LaunchdScheduler } from './launchd.ts';
import { TaskSchedulerScheduler } from './task-scheduler.ts';

/** Platform-neutral description of a scheduled daemon. Each Scheduler renders
 * this into a plist (macOS) or task XML (Windows). All paths are absolute and
 * already `~`-expanded by the caller. */
export interface ScheduleSpec {
  /** Unique identifier: launchd Label on macOS, task name on Windows. */
  label: string;
  /** Where the definition file (plist / task XML) is written. Absolute. */
  definitionPath: string;
  /** Absolute path to the `bun` executable that runs the entry script. */
  bunPath: string;
  /** Absolute path to the daemon entry script (e.g. .../collect.ts). */
  entryScript: string;
  /** Absolute path the daemon's stdout+stderr are redirected to. */
  logPath: string;
  /** How often the daemon fires, in seconds. */
  intervalSeconds: number;
  /** The user's home dir — injected into the daemon's environment. */
  home: string;
}

export interface ArmResult {
  ok: boolean;
  error?: string;
}

export interface Scheduler {
  /** 'launchd' (macOS) | 'scheduled-task' (Windows). */
  readonly kind: 'launchd' | 'scheduled-task';
  /** Render + write the definition file. Inert — does NOT register or start
   * the daemon. The arm step does that. Idempotent (overwrites). */
  stage(spec: ScheduleSpec): void;
  /** True if the schedule is currently registered with the OS scheduler. */
  isLoaded(spec: ScheduleSpec): boolean;
  /** Register + start the daemon. Idempotent: tears down any prior
   * registration first. Callers MUST check `ok` — a failed registration must
   * never be reported as armed (a Windows `schtasks /create` can fail and
   * leave nothing running). */
  arm(spec: ScheduleSpec): ArmResult;
  /** Stop + deregister. Best-effort; safe to call when not loaded. */
  disarm(spec: ScheduleSpec): void;
  /** Remove the staged definition file from disk. Best-effort. */
  removeDefinition(spec: ScheduleSpec): void;
}

/**
 * Return the scheduler for the current OS (or an explicit platform, for tests).
 * Throws on an unsupported platform — daemon-kind extensions are gated to
 * darwin/win32 by the registry `platform` field, so this should never fire in
 * normal flow.
 */
export function getScheduler(platform: NodeJS.Platform = process.platform): Scheduler {
  switch (platform) {
    case 'darwin':
      return new LaunchdScheduler();
    case 'win32':
      return new TaskSchedulerScheduler();
    default:
      throw new Error(
        `No scheduler for platform '${platform}'. Daemon extensions support darwin + win32 only.`,
      );
  }
}

/**
 * Build a ScheduleSpec from an Extension. `expand` resolves `${HOME}`
 * placeholders (the CLI's expand()). `bunPath` is the resolved bun executable.
 * Returns null when the extension lacks the daemon fields needed to schedule
 * (label/definition path differ by platform).
 */
export function buildSpec(
  ext: Extension,
  expand: (p: string | undefined) => string | undefined,
  bunPath: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): ScheduleSpec | null {
  const entryScript = expand(ext.entryScript);
  const installDir = expand(ext.installDir);
  if (!entryScript || !installDir || ext.scheduleIntervalSeconds == null) return null;

  const label = platform === 'win32' ? ext.taskName : ext.launchdLabel;
  const definitionPath = platform === 'win32' ? expand(ext.taskXmlPath) : expand(ext.launchdPlistPath);
  if (!label || !definitionPath) return null;

  return {
    label,
    definitionPath,
    bunPath,
    entryScript,
    logPath: `${installDir}/sync.log`,
    intervalSeconds: ext.scheduleIntervalSeconds,
    home,
  };
}
