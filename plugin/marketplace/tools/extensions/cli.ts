#!/usr/bin/env bun
/**
 * Dent Brain extensions manager.
 *
 * A teammate-local CLI for managing the local-side ingestors (granola-sync
 * today, more later). Run from anywhere — the script uses `import.meta.dir`
 * to find the repo root.
 *
 *   bun tools/extensions/cli.ts list
 *   bun tools/extensions/cli.ts status [<id>]
 *   bun tools/extensions/cli.ts install <id>
 *   bun tools/extensions/cli.ts configure <id>
 *   bun tools/extensions/cli.ts test <id>
 *   bun tools/extensions/cli.ts uninstall <id>
 *
 * Or, after `bun link` from this repo:
 *   dent-extensions list
 *
 * Output is human-readable by default. `--json` switches to a structured
 * shape suitable for the Cowork skill or scripts to parse.
 */

import { existsSync, readFileSync, statSync, unlinkSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { EXTENSIONS, findExtension } from './registry.ts';
import type { Extension, ExtensionStatus } from './types.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const ARGS = process.argv.slice(2);
const FLAG_JSON = ARGS.includes('--json');
const COMMAND = ARGS.find((a) => !a.startsWith('-')) ?? 'list';
const POSITIONAL = ARGS.filter((a) => !a.startsWith('-'));

function expand(p: string | undefined): string | undefined {
  if (p == null) return undefined;
  return p.replace(/\$\{HOME\}/g, homedir());
}

function isLaunchdLoaded(label: string | undefined): boolean {
  if (!label) return false;
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${label}`], {
    encoding: 'utf-8',
  });
  return r.status === 0;
}

function checkConfigConfigured(configPath: string | undefined, markers: string[] | undefined): { exists: boolean; configured: boolean; markersFound: string[] } {
  if (!configPath || !existsSync(configPath)) return { exists: false, configured: false, markersFound: [] };
  const body = readFileSync(configPath, 'utf-8');
  const markersFound = (markers ?? []).filter((m) => body.includes(m));
  return { exists: true, configured: markersFound.length === 0, markersFound };
}

function logFileFor(ext: Extension): string | null {
  const installDir = expand(ext.installDir);
  if (!installDir) return null;
  const candidate = join(installDir, 'sync.log');
  return existsSync(candidate) ? candidate : null;
}

function getStatus(ext: Extension): ExtensionStatus {
  const installDir = expand(ext.installDir);
  const installed = !!installDir && existsSync(installDir);
  const configCheck = checkConfigConfigured(expand(ext.configPath), ext.unconfiguredMarkers);
  const running = ext.kind === 'launchd-daemon' ? isLaunchdLoaded(ext.launchdLabel) : false;

  let lastRunAt: string | null = null;
  let logBytes: number | null = null;
  const log = logFileFor(ext);
  if (log) {
    try {
      const s = statSync(log);
      lastRunAt = new Date(s.mtimeMs).toISOString();
      logBytes = s.size;
    } catch { /* best-effort */ }
  }

  const notes: string[] = [];
  if (!installed) notes.push('Not installed. Run `dent-extensions install ' + ext.id + '` to set it up.');
  else if (!configCheck.exists) notes.push('Installed but config.json is missing.');
  else if (!configCheck.configured) {
    notes.push(`Installed but config.json contains placeholder values: ${configCheck.markersFound.join(', ')}. Run \`dent-extensions configure ${ext.id}\`.`);
  }
  if (installed && configCheck.configured && !running && ext.kind === 'launchd-daemon') {
    notes.push(`launchd agent ${ext.launchdLabel} is not loaded. Run \`dent-extensions install ${ext.id}\` again to (re-)load it.`);
  }
  if (lastRunAt && logBytes != null && logBytes < 100) {
    notes.push('sync.log is nearly empty — first run may not have completed yet.');
  }

  return {
    id: ext.id,
    installed,
    configured: configCheck.configured,
    running,
    lastRunAt,
    logBytes,
    notes,
  };
}

function statusBadge(s: ExtensionStatus): string {
  if (!s.installed) return '○ not-installed';
  if (!s.configured) return '⚠ unconfigured';
  if (!s.running) return '⚠ not-running';
  return '● active';
}

function rel(t: string | null): string {
  if (!t) return 'never';
  const ago = Date.now() - new Date(t).getTime();
  if (!Number.isFinite(ago) || ago < 0) return t;
  const mins = Math.floor(ago / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------- Commands ----------

function cmdList() {
  const rows = EXTENSIONS.map((ext) => {
    const s = getStatus(ext);
    return { ext, status: s };
  });
  if (FLAG_JSON) {
    console.log(JSON.stringify(rows.map((r) => ({ ...r.ext, status: r.status })), null, 2));
    return;
  }
  console.log(`Dent Brain extensions (${rows.length}):\n`);
  for (const { ext, status } of rows) {
    const lastRun = status.lastRunAt ? ` (last run ${rel(status.lastRunAt)})` : '';
    console.log(`  ${statusBadge(status).padEnd(18)} ${ext.id.padEnd(16)} ${ext.name}${lastRun}`);
    console.log(`  ${' '.repeat(18)} ${ext.description}`);
    for (const n of status.notes) console.log(`  ${' '.repeat(18)} → ${n}`);
    console.log();
  }
  console.log(`Run \`dent-extensions status <id>\` for details.`);
}

function cmdStatus(id: string | undefined) {
  if (!id) { cmdList(); return; }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}\n\nKnown: ${EXTENSIONS.map((e) => e.id).join(', ')}`); process.exit(1); }
  const status = getStatus(ext);
  if (FLAG_JSON) { console.log(JSON.stringify({ ...ext, status }, null, 2)); return; }
  console.log(`${ext.name} (${ext.id})`);
  console.log(`  ${ext.description}`);
  console.log();
  console.log(`  status:       ${statusBadge(status)}`);
  console.log(`  installed:    ${status.installed ? 'yes' : 'no'}`);
  console.log(`  configured:   ${status.configured ? 'yes' : 'no'}`);
  if (ext.kind === 'launchd-daemon') console.log(`  running:      ${status.running ? 'yes' : 'no'}`);
  if (status.lastRunAt) console.log(`  last run:     ${rel(status.lastRunAt)} (${status.lastRunAt})`);
  if (status.logBytes != null) console.log(`  log size:     ${status.logBytes} bytes`);
  console.log();
  console.log(`  source:       ${ext.sourceDir}`);
  if (ext.installDir) console.log(`  install dir:  ${expand(ext.installDir)}`);
  if (ext.configPath) console.log(`  config:       ${expand(ext.configPath)}`);
  if (ext.launchdLabel) console.log(`  launchd label: ${ext.launchdLabel}`);
  if (ext.launchdPlistPath) console.log(`  launchd plist: ${expand(ext.launchdPlistPath)}`);
  if (status.notes.length > 0) {
    console.log();
    console.log(`  notes:`);
    for (const n of status.notes) console.log(`    - ${n}`);
  }
  if (status.lastRunAt) {
    console.log();
    console.log(`  Tail recent log:`);
    console.log(`    tail -50 ${join(expand(ext.installDir) ?? '', 'sync.log')}`);
  }
}

function cmdInstall(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions install <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  if (!ext.installScript) {
    console.error(`Extension ${id} has no installer script. See ${ext.sourceDir}/README.md.`);
    process.exit(1);
  }
  const scriptPath = join(REPO_ROOT, ext.sourceDir, ext.installScript);
  if (!existsSync(scriptPath)) {
    console.error(`Installer not found at ${scriptPath}. Did you \`git pull\`?`);
    process.exit(1);
  }
  console.error(`==> Running ${scriptPath}`);
  const r = spawnSync('bash', [scriptPath], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function cmdConfigure(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions configure <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  const cfg = expand(ext.configPath);
  if (!cfg) { console.error(`Extension ${id} has no config path.`); process.exit(1); }
  if (!existsSync(cfg)) {
    console.error(`Config file does not exist at ${cfg}. Run \`dent-extensions install ${id}\` first.`);
    process.exit(1);
  }
  const editor = process.env.EDITOR || 'open';
  console.error(`==> Opening ${cfg} in ${editor}…`);
  const r = spawnSync(editor, [cfg], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function cmdTest(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions test <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  const entry = expand(ext.entryScript);
  if (!entry) {
    console.error(`Extension ${id} has no entry script. Test mode unavailable.`);
    process.exit(1);
  }
  if (!existsSync(entry)) {
    console.error(`Entry script not found at ${entry}. Run \`dent-extensions install ${id}\` first.`);
    process.exit(1);
  }
  const args = ext.testArgs ?? ['--dry-run', '--verbose'];
  console.error(`==> bun ${entry} ${args.join(' ')}`);
  const r = spawnSync('bun', [entry, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function cmdUninstall(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions uninstall <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  console.error(`==> Uninstalling ${ext.name} (${ext.id})…`);

  // 1. Stop launchd agent if loaded
  if (ext.launchdLabel && ext.launchdPlistPath) {
    const plist = expand(ext.launchdPlistPath);
    if (plist && existsSync(plist) && isLaunchdLoaded(ext.launchdLabel)) {
      console.error(`    bootout ${ext.launchdLabel}…`);
      spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plist], { stdio: 'inherit' });
    }
    if (plist && existsSync(plist)) {
      try { unlinkSync(plist); console.error(`    removed plist: ${plist}`); }
      catch (e) { console.error(`    warn: could not remove ${plist}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // 2. Confirm before nuking install dir (it has the cursor + log + config!)
  const installDir = expand(ext.installDir);
  if (installDir && existsSync(installDir)) {
    if (ARGS.includes('--keep-config')) {
      console.error(`    --keep-config: leaving ${installDir} on disk.`);
    } else {
      console.error(`    removing ${installDir}…`);
      try { rmSync(installDir, { recursive: true, force: true }); }
      catch (e) { console.error(`    warn: could not remove ${installDir}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  console.error(`==> Uninstalled.`);
  console.error(`    To reinstall later: dent-extensions install ${ext.id}`);
}

function cmdHelp() {
  console.log(
    `Dent Brain extensions manager\n\nUsage:\n  dent-extensions list                          Show all extensions + status\n  dent-extensions status [<id>]                 Detailed status (all if no id)\n  dent-extensions install <id>                  Run the extension's installer\n  dent-extensions configure <id>                Open the config file in $EDITOR\n  dent-extensions test <id>                     Dry-run the extension to verify\n  dent-extensions uninstall <id> [--keep-config]\n                                                Stop + remove the extension\n  dent-extensions help                          Show this message\n\nGlobal flags:\n  --json                                        Machine-readable output (where applicable)\n\nKnown extensions:\n${EXTENSIONS.map((e) => '  - ' + e.id + (e.id.length < 16 ? ' '.repeat(16 - e.id.length) : '  ') + e.name).join('\n')}\n`,
  );
}

switch (COMMAND) {
  case 'list':       cmdList(); break;
  case 'status':     cmdStatus(POSITIONAL[1]); break;
  case 'install':    cmdInstall(POSITIONAL[1]); break;
  case 'configure':  cmdConfigure(POSITIONAL[1]); break;
  case 'test':       cmdTest(POSITIONAL[1]); break;
  case 'uninstall':  cmdUninstall(POSITIONAL[1]); break;
  case 'help':
  case '--help':
  case '-h':         cmdHelp(); break;
  default:
    console.error(`Unknown command: ${COMMAND}\n`);
    cmdHelp();
    process.exit(1);
}
