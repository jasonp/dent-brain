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
  if (!configPath || !existsSync(configPath)) {
    // Config is REQUIRED only when the extension declares unconfiguredMarkers
    // (the installer writes a config and the placeholders matter).
    // Optional configs (e.g. granola-sync) are "configured" by default.
    const required = !!markers && markers.length > 0;
    return { exists: false, configured: !required, markersFound: [] };
  }
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
  const userFilterPath = expand(ext.userFilterPath);
  const hasUserFilter = !ext.userFilterPath ? true : (!!userFilterPath && existsSync(userFilterPath));

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
  // config.json is only treated as required when the extension declares
  // `unconfiguredMarkers` — that's the signal that the installer writes a
  // config and the placeholders matter. Granola-sync's config is optional
  // (everything auto-discovered) so we skip this check there.
  else if (!configCheck.exists && ext.unconfiguredMarkers && ext.unconfiguredMarkers.length > 0) {
    notes.push('Installed but config.json is missing.');
  }
  else if (!configCheck.configured) {
    notes.push(`Installed but config.json contains placeholder values: ${configCheck.markersFound.join(', ')}. Run \`dent-extensions configure ${ext.id}\`.`);
  }
  if (installed && ext.userFilterPath && !hasUserFilter) {
    notes.push(`No user filter at ${userFilterPath}. Daemon is inert. Run \`dent-extensions setup ${ext.id}\` (or in Claude Code: "set up ${ext.id}").`);
  }
  if (installed && hasUserFilter && !running && ext.kind === 'launchd-daemon') {
    notes.push(`Daemon is not armed. Preview first: \`dent-extensions preview ${ext.id}\`, then arm: \`dent-extensions arm ${ext.id}\`.`);
  }
  if (lastRunAt && logBytes != null && logBytes < 100) {
    notes.push('sync.log is nearly empty — first run may not have completed yet.');
  }

  return {
    id: ext.id,
    installed,
    configured: configCheck.configured,
    hasUserFilter,
    running,
    lastRunAt,
    logBytes,
    notes,
  };
}

function statusBadge(s: ExtensionStatus): string {
  if (!s.installed) return '○ not-installed';
  if (!s.configured) return '⚠ unconfigured';
  if (!s.hasUserFilter) return '⚠ no-filter';
  if (!s.running) return '⚠ not-armed';
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
  // `test` is preserved as an alias for `preview` so existing muscle memory works.
  cmdPreview(id);
}

function cmdPreview(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions preview <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  const entry = expand(ext.entryScript);
  if (!entry) {
    console.error(`Extension ${id} has no entry script. Preview unavailable.`);
    process.exit(1);
  }
  if (!existsSync(entry)) {
    console.error(`Entry script not found at ${entry}. Run \`dent-extensions install ${id}\` first.`);
    process.exit(1);
  }
  const userFilter = expand(ext.userFilterPath);
  if (ext.userFilterPath && (!userFilter || !existsSync(userFilter))) {
    console.error(`No user filter at ${userFilter}.`);
    console.error(`Preview is the verification gate AFTER you've authored user/filter.ts.`);
    console.error(`Run \`dent-extensions setup ${id}\` first (or in Claude Code: "set up ${id}").`);
    process.exit(1);
  }
  const args = ext.testArgs ?? ['--dry-run', '--verbose'];
  console.error(`==> Preview: bun ${entry} ${args.join(' ')}`);
  console.error(`    Reading user filter at ${userFilter}`);
  console.error(`    No data will reach the brain — this is a dry run.`);
  console.error();
  const r = spawnSync('bun', [entry, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function cmdSetup(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions setup <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  const installDir = expand(ext.installDir);
  if (!installDir || !existsSync(installDir)) {
    console.error(`Extension ${id} is not installed yet. Run \`dent-extensions install ${id}\` first.`);
    process.exit(1);
  }
  const userFilter = expand(ext.userFilterPath);
  const recipeDir = expand(ext.recipeDir);
  console.log(`==> Setup: ${ext.name} (${ext.id})`);
  console.log();
  console.log('  The setup flow generates a teammate-specific filter that decides which');
  console.log('  items reach the shared brain. Nothing will be filed until you (1) author');
  console.log('  user/filter.ts, (2) preview what would be captured, (3) explicitly arm.');
  console.log();
  console.log('  Recommended: run this in Claude Code on your laptop. The /dent-extensions');
  console.log('  skill will read your data, propose rules, write the filter for you, and');
  console.log('  loop on preview + edit until you approve.');
  console.log();
  if (recipeDir && existsSync(recipeDir)) {
    console.log(`  Recipe contract:  ${recipeDir}/RECIPE.md`);
    console.log(`  Starting point:   ${recipeDir}/filter.example.ts`);
  }
  if (userFilter) {
    const exists = existsSync(userFilter);
    console.log(`  Your filter:      ${userFilter}${exists ? ' (exists)' : ' (not yet written)'}`);
  }
  console.log();
  if (userFilter && !existsSync(userFilter)) {
    console.log('  Quick manual path (if you prefer hand-authoring):');
    console.log(`    cp ${recipeDir}/filter.example.ts ${userFilter}`);
    console.log(`    $EDITOR ${userFilter}`);
    console.log(`    dent-extensions preview ${ext.id}`);
    console.log(`    dent-extensions arm ${ext.id}`);
  } else if (userFilter) {
    console.log('  Next steps:');
    console.log(`    dent-extensions preview ${ext.id}   # dry-run, no writes`);
    console.log(`    dent-extensions arm ${ext.id}       # start the daemon`);
  }
}

function cmdArm(id: string | undefined) {
  if (!id) { console.error('Usage: dent-extensions arm <id>'); process.exit(1); }
  const ext = findExtension(id);
  if (!ext) { console.error(`Unknown extension: ${id}`); process.exit(1); }
  if (ext.kind !== 'launchd-daemon' || !ext.launchdLabel || !ext.launchdPlistPath) {
    console.error(`Extension ${id} is not a launchd daemon — nothing to arm.`);
    process.exit(1);
  }
  const installDir = expand(ext.installDir);
  if (!installDir || !existsSync(installDir)) {
    console.error(`Extension ${id} is not installed. Run \`dent-extensions install ${id}\` first.`);
    process.exit(1);
  }
  const userFilter = expand(ext.userFilterPath);
  if (ext.userFilterPath && (!userFilter || !existsSync(userFilter))) {
    console.error(`Cannot arm ${id}: no user filter at ${userFilter}.`);
    console.error(`Run \`dent-extensions setup ${id}\` first (the filter decides what reaches the brain).`);
    process.exit(1);
  }
  const plist = expand(ext.launchdPlistPath);
  if (!plist || !existsSync(plist)) {
    console.error(`Plist not found at ${plist}. Re-run \`dent-extensions install ${id}\`.`);
    process.exit(1);
  }
  // Strongly recommend a preview has been run, but don't gate on it — preview
  // writes no state to check against. The trust contract is: user authored
  // the filter, user is now flipping the switch. Their preview habit is on them.
  console.error(`==> Arming ${ext.name}…`);
  console.error(`    filter:  ${userFilter}`);
  console.error(`    plist:   ${plist}`);
  const uid = process.getuid?.();
  if (typeof uid !== 'number') {
    console.error(`    cannot determine uid — launchctl needs gui/<uid>. Run \`bash ${ext.sourceDir}/install.sh\` directly instead.`);
    process.exit(1);
  }
  // Tear down any prior bootstrap (idempotent arm).
  if (isLaunchdLoaded(ext.launchdLabel)) {
    console.error(`    bootout (refresh)…`);
    spawnSync('launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'inherit' });
  }
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`    bootstrap failed (exit ${r.status}). Check Console.app for launchd errors.`);
    process.exit(r.status ?? 1);
  }
  console.error(`    armed. Daemon is now live — first run will fire shortly.`);
  console.error();
  console.error(`    To watch: tail -f ${installDir}/sync.log`);
  console.error(`    To stop:  dent-extensions uninstall ${ext.id}`);
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
    `Dent Brain extensions manager\n\nLifecycle (in order):\n  dent-extensions install <id>                  Plumbing install (inert; no data flows yet)\n  dent-extensions setup <id>                    Print setup guidance; pairs with /dent-extensions skill\n  dent-extensions preview <id>                  Dry-run with your user filter; no writes\n  dent-extensions arm <id>                      Bootstrap launchd; daemon goes live\n\nInspect / manage:\n  dent-extensions list                          Show all extensions + status\n  dent-extensions status [<id>]                 Detailed status (all if no id)\n  dent-extensions configure <id>                Open config.json in $EDITOR\n  dent-extensions uninstall <id> [--keep-config]\n                                                Stop + remove the extension\n  dent-extensions help                          Show this message\n\nAliases:\n  dent-extensions test <id>                     Alias for \`preview\` (legacy)\n\nGlobal flags:\n  --json                                        Machine-readable output (where applicable)\n\nKnown extensions:\n${EXTENSIONS.map((e) => '  - ' + e.id + (e.id.length < 16 ? ' '.repeat(16 - e.id.length) : '  ') + e.name).join('\n')}\n`,
  );
}

switch (COMMAND) {
  case 'list':       cmdList(); break;
  case 'status':     cmdStatus(POSITIONAL[1]); break;
  case 'install':    cmdInstall(POSITIONAL[1]); break;
  case 'configure':  cmdConfigure(POSITIONAL[1]); break;
  case 'setup':      cmdSetup(POSITIONAL[1]); break;
  case 'preview':    cmdPreview(POSITIONAL[1]); break;
  case 'arm':        cmdArm(POSITIONAL[1]); break;
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
