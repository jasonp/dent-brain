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

export type ExtensionKind = 'launchd-daemon' | 'manual' | 'cron-script';

export interface Extension {
  /** Stable id (kebab-case). Used in CLI commands like `install <id>`. */
  id: string;
  /** Human-readable name shown in lists. */
  name: string;
  /** One-paragraph blurb shown in `list` + `status`. */
  description: string;
  /** Trigger / scope — what kind of teammate engagement it implies. */
  kind: ExtensionKind;
  /** Where this extension's source files live in the dent-brain repo
   * (relative to the repo root). */
  sourceDir: string;
  /** Path to the install script, relative to `sourceDir`. */
  installScript?: string;
  /** Where the extension installs its runtime (absolute path; `~` expanded). */
  installDir?: string;
  /** Where the extension reads its config (absolute path; `~` expanded). */
  configPath?: string;
  /** launchd label, if applicable. */
  launchdLabel?: string;
  /** launchd plist path, if applicable (absolute; `~` expanded). */
  launchdPlistPath?: string;
  /** Path to the runtime entrypoint for `test` (absolute; `~` expanded). */
  entryScript?: string;
  /** Optional CLI args appended to `bun <entryScript>` for the test action.
   * Defaults to `['--dry-run', '--verbose']`. */
  testArgs?: string[];
  /** Lines that, if found in `configPath`, mean the config is still
   * unconfigured (placeholder values). The CLI uses these to flag
   * "installed but needs configuration". */
  unconfiguredMarkers?: string[];
}

export interface ExtensionStatus {
  id: string;
  installed: boolean;
  configured: boolean;
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
