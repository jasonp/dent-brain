/**
 * `gbrain ingest mailchimp <subcommand>`
 *
 *   bootstrap    Read N CSV exports and land bullets on existing entities
 *                (or create stubs). Idempotent on `[Source: mailchimp/<EUID>]`.
 *
 * Future subcommands (Phase 5.2-later):
 *   poll         Pull recent activity from the Mailchimp Marketing API and
 *                land bullets through the same translator.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { runMailchimpBootstrap } from '../dent/ingestors/mailchimp/csv-bootstrap.ts';

export async function runIngestMailchimp(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    process.exit(sub ? 0 : 1);
  }
  if (sub === 'bootstrap') {
    await runBootstrap(engine, args.slice(1));
    return;
  }
  console.error(`Unknown subcommand: ${sub}\n`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  process.stderr.write(
`Usage: gbrain ingest mailchimp <subcommand> [flags]

Subcommands:
  bootstrap   Import historical Mailchimp CSV exports as Timeline bullets.

Bootstrap flags:
  --csv-dir <path>             Directory containing Mailchimp CSV exports.
                               Files matching *subscribed*.csv / *unsubscribed*.csv /
                               *cleaned*.csv / *nonsubscribed*.csv will be picked up.
                               Status is inferred from filename.
  --csv <path>                 Explicit CSV path. Repeatable. Status inferred
                               from filename. Mutually exclusive with --csv-dir.
  --limit <n>                  Cap members processed. Useful for canary runs.
  --dry-run                    Read + count + report. No writes.
  --no-tags-bullet             Suppress the "Mailchimp tags: ..." bullet.
  --no-profile-bullet          Suppress the "Mailchimp profile — ..." bullet.

Examples:
  gbrain ingest mailchimp bootstrap --csv-dir ~/Dropbox/Mailchimp --limit 25 --dry-run
  gbrain ingest mailchimp bootstrap --csv-dir ~/Dropbox/Mailchimp
`,
  );
}

interface BootstrapFlags {
  csvDir?: string;
  csvs: string[];
  limit?: number;
  dryRun: boolean;
  emitTagsBullet: boolean;
  emitProfileBullet: boolean;
}

function parseBootstrapFlags(args: string[]): BootstrapFlags {
  const f: BootstrapFlags = {
    csvs: [],
    dryRun: false,
    emitTagsBullet: true,
    emitProfileBullet: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--csv-dir') f.csvDir = args[++i];
    else if (a === '--csv') f.csvs.push(args[++i]);
    else if (a === '--limit') f.limit = parseInt(args[++i], 10);
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--no-tags-bullet') f.emitTagsBullet = false;
    else if (a === '--no-profile-bullet') f.emitProfileBullet = false;
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return f;
}

const RECOGNIZED_FILENAME_PATTERNS = [
  /subscribed.*\.csv$/i,
  /unsubscribed.*\.csv$/i,
  /cleaned.*\.csv$/i,
  /nonsubscribed.*\.csv$/i,
];

function discoverCsvs(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const abs = join(dir, f);
    if (!statSync(abs).isFile()) continue;
    if (!f.toLowerCase().endsWith('.csv')) continue;
    if (RECOGNIZED_FILENAME_PATTERNS.some((p) => p.test(f))) {
      out.push(abs);
    }
  }
  return out.sort();
}

async function runBootstrap(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseBootstrapFlags(args);

  let csvPaths: string[] = [];
  if (flags.csvDir) {
    const dir = isAbsolute(flags.csvDir) ? flags.csvDir : resolve(process.cwd(), flags.csvDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`--csv-dir ${dir} does not exist or is not a directory`);
      process.exit(1);
    }
    csvPaths = discoverCsvs(dir);
    if (csvPaths.length === 0) {
      console.error(`No recognized Mailchimp CSV files in ${dir}`);
      process.exit(1);
    }
  }
  for (const c of flags.csvs) {
    const abs = isAbsolute(c) ? c : resolve(process.cwd(), c);
    if (!existsSync(abs)) {
      console.error(`--csv ${abs} does not exist`);
      process.exit(1);
    }
    csvPaths.push(abs);
  }
  if (csvPaths.length === 0) {
    console.error('At least one --csv-dir or --csv path is required.');
    process.exit(1);
  }

  process.stderr.write(`[mailchimp-bootstrap] CSVs: ${csvPaths.length}\n`);
  for (const p of csvPaths) process.stderr.write(`  - ${p}\n`);
  process.stderr.write(`[mailchimp-bootstrap] mode: ${flags.dryRun ? 'DRY RUN' : 'APPLY'}${flags.limit ? ` (limit ${flags.limit})` : ''}\n`);

  const outcome = await runMailchimpBootstrap(engine, {
    csvPaths,
    limit: flags.limit,
    dryRun: flags.dryRun,
    emitTagsBullet: flags.emitTagsBullet,
    emitProfileBullet: flags.emitProfileBullet,
  });
  process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
  if (!outcome.ok) process.exit(2);
}
