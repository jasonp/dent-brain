/**
 * Shared types for the Dent Brain extensions manager.
 *
 * An "extension" is anything that runs LOCALLY on a teammate's laptop and
 * pushes signal into the shared brain. As of today: granola-sync. Future:
 * gmail-watch, transcript-from-other-services, dropbox-watcher, etc.
 *
 * Each extension is described by an `Extension` object. The CLI (cli.ts)
 * reads the registry of extensions and offers a uniform manage/install/
 * status interface. Adding a new extension is an O(1) edit to registry.ts.
 */

export type ExtensionKind = 'launchd-daemon' | 'scheduled-task' | 'manual' | 'cron-script';

/** Operating systems an extension can install on. Maps to `process.platform`
 * values. We only support the two teammates run today. */
export type Platform = 'darwin' | 'win32';

export interface Extension {
  /** Stable id (kebab-case). Used in CLI commands like `install <id>`. */
  id: string;
  /** Human-readable name shown in lists. */
  name: string;
  /** One-paragraph blurb shown in `list` + `status`. */
  description: string;
  /** Trigger / scope — what kind of teammate engagement it implies.
   * `launchd-daemon` and `scheduled-task` are the macOS and Windows daemon
   * kinds respectively; both are scheduled by the scheduler abstraction
   * (scheduler/index.ts) — the right one is picked by `process.platform`
   * at runtime, so a single extension can declare `launchd-daemon` and still
   * install on Windows when `platform` includes `'win32'`. */
  kind: ExtensionKind;
  /** OSes this extension can install on. Unset = all supported platforms.
   * The CLI refuses `install` when `process.platform` is not in this list.
   * Example: granola-sync is `['darwin']` (Granola.app is Mac-only). */
  platform?: Platform[];
  /** Where this extension's source files live in the dent-brain repo
   * (relative to the repo root). */
  sourceDir: string;
  /** Path to the install script, relative to `sourceDir`. */
  installScript?: string;
  /** Where the extension installs its runtime (absolute path; `~` expanded). */
  installDir?: string;
  /** Where the extension reads its config (absolute path; `~` expanded). */
  configPath?: string;
  /** launchd label, if applicable (macOS). */
  launchdLabel?: string;
  /** launchd plist path, if applicable (absolute; `~` expanded). */
  launchdPlistPath?: string;
  /** Windows Task Scheduler task name, if applicable. The scheduler
   * abstraction uses this with `schtasks` (Windows analogue of launchdLabel). */
  taskName?: string;
  /** Windows Task Scheduler task-definition XML path (absolute; `~` expanded).
   * Staged at install, registered at arm — the analogue of launchdPlistPath. */
  taskXmlPath?: string;
  /** How often the daemon runs, in seconds. Platform-neutral schedule data
   * the scheduler renders into the plist (StartInterval) or task XML
   * (Repetition Interval). Required for daemon-kind extensions. */
  scheduleIntervalSeconds?: number;
  /** Path to the runtime entrypoint for `test` (absolute; `~` expanded). */
  entryScript?: string;
  /** Optional CLI args appended to `bun <entryScript>` for the test action.
   * Defaults to `['--dry-run', '--verbose']`. */
  testArgs?: string[];
  /** Lines that, if found in `configPath`, mean the config is still
   * unconfigured (placeholder values). The CLI uses these to flag
   * "installed but needs configuration". */
  unconfiguredMarkers?: string[];
  /** Where the teammate-authored filter lives (absolute; `~` expanded).
   * If unset, the extension has no per-user customization surface. */
  userFilterPath?: string;
  /** Where the recipe doc + example live in the install dir (absolute;
   * `~` expanded). Surfaced in `setup` output. */
  recipeDir?: string;
}

export interface ExtensionStatus {
  id: string;
  installed: boolean;
  configured: boolean;
  /** True if `userFilterPath` exists. Extensions without user-filter customization
   * report `true` to keep older display logic working. */
  hasUserFilter: boolean;
  /** True if the launchd agent (or other scheduler) is loaded + active. */
  running: boolean;
  /** Most recent run timestamp from log mtime, or null. */
  lastRunAt: string | null;
  /** Most recent log size in bytes — useful as a "have we logged anything"
   *  proxy when timestamps are unreliable. */
  logBytes: number | null;
  /** Free-form details for display: notes, warnings, recent errors. */
  notes: string[];
}
