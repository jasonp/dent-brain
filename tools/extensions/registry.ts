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
      'Hourly daemon that watches your local Granola cache and pushes Dent-related meeting notes + transcripts into the brain. Filters by title keyword + Dent team domain so personal/non-Dent meetings stay local.',
    kind: 'launchd-daemon',
    sourceDir: 'tools/granola-sync',
    installScript: 'install.sh',
    installDir: '${HOME}/.dent-brain/granola-sync',
    configPath: '${HOME}/.dent-brain/granola-sync/config.json',
    launchdLabel: 'com.dent.granola-sync',
    launchdPlistPath: '${HOME}/Library/LaunchAgents/com.dent.granola-sync.plist',
    entryScript: '${HOME}/.dent-brain/granola-sync/sync.ts',
    testArgs: ['--dry-run', '--verbose'],
    unconfiguredMarkers: [
      'REPLACE_WITH_YOUR_PERSONAL_DENT_BRAIN_TOKEN',
      'you@dentthefuture.com',
    ],
  },
  // Future extensions land here. Pattern:
  //
  // {
  //   id: 'gmail-watch',
  //   name: 'Gmail → Dent Brain inbox watcher',
  //   description: 'Watches a labeled Gmail folder and ingests messages.',
  //   kind: 'launchd-daemon',
  //   sourceDir: 'tools/gmail-watch',
  //   installScript: 'install.sh',
  //   installDir: '${HOME}/.dent-brain/gmail-watch',
  //   ...
  // },
];

export function findExtension(id: string): Extension | undefined {
  return EXTENSIONS.find((e) => e.id === id);
}
