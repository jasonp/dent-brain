/**
 * The canonical registry of Dent Brain extensions.
 *
 * Each entry describes ONE extension. Adding a new extension is an additive
 * edit to this file — the CLI picks it up automatically.
 *
 * Convention: `${HOME}` placeholders in paths get expanded at runtime by
 * `expand()` in cli.ts. Don't pre-expand here, so the registry is portable
 * and serializes cleanly for `--json` output.
 */

import type { Extension } from './types.ts';

export const EXTENSIONS: Extension[] = [
  {
    id: 'granola-sync',
    name: 'Granola → Dent Brain sync',
    description:
      'Hourly daemon that watches your local Granola cache and pushes Dent-related meeting notes + transcripts into the brain. Filters via four signals (Granola folder, title keyword, body/transcript mention, attendee domain) so personal/non-Dent meetings stay local.',
    kind: 'launchd-daemon',
    sourceDir: 'tools/granola-sync',
    installScript: 'install.sh',
    installDir: '${HOME}/.dent-brain/granola-sync',
    configPath: '${HOME}/.dent-brain/granola-sync/config.json',
    launchdLabel: 'com.dent.granola-sync',
    launchdPlistPath: '${HOME}/Library/LaunchAgents/com.dent.granola-sync.plist',
    entryScript: '${HOME}/.dent-brain/granola-sync/sync.ts',
    testArgs: ['--dry-run', '--verbose'],
    // No unconfiguredMarkers: the daemon auto-discovers everything from
    // ~/.claude.json + macOS conventions, so as soon as it's installed
    // it's also configured. The skill detects setup problems via runtime
    // errors in sync.log, not via config-file inspection.
  },
  {
    id: 'email-sync',
    name: 'Email → Dent Brain sync',
    description:
      'Two-layer email pipeline. Layer 1 (this extension): laptop daemon, runs every 6h via launchd, pulls Gmail directly via Google OAuth (using the shared Dent Brain Google Cloud OAuth app), filters noise + classifies signatures, writes a daily digest page to the brain. Strict scope to one configured work email — emails on other addresses on the same inbox never enter the brain. Layer 2 (`dent-process-inbox`): a Claude Code Desktop scheduled task you create after install — fires daily at 3am on your laptop using your Claude subscription, reads the digests, and walks each Triage entry through entity resolution (brain query → FileMaker fallback) to append timeline bullets on the right entity pages.',
    kind: 'launchd-daemon',
    sourceDir: 'tools/email-sync',
    installScript: 'install.sh',
    installDir: '${HOME}/.dent-brain/email-sync',
    configPath: '${HOME}/.dent-brain/email-sync/config.json',
    launchdLabel: 'com.dent.email-sync',
    launchdPlistPath: '${HOME}/Library/LaunchAgents/com.dent.email-sync.plist',
    entryScript: '${HOME}/.dent-brain/email-sync/collect.ts',
    testArgs: ['--dry-run', '--verbose'],
    // unconfiguredMarkers: the installer writes real values, but if the
    // user hand-edits config and leaves a placeholder, surface that.
    unconfiguredMarkers: ['REPLACE_WITH_'],
  },
];

export function findExtension(id: string): Extension | undefined {
  return EXTENSIONS.find((e) => e.id === id);
}
