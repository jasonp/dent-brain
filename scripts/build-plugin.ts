#!/usr/bin/env bun
/**
 * Build the Dent Brain plugin bundle.
 *
 * Reads:
 *   plugin/manifest.json       — deploy config (org_prefix, server_url, etc.)
 *   skills/dent/<name>/SKILL.md — skill templates (some use {{prefix}}; others have
 *                                the dent prefix already inlined as `/dent-<name>`).
 *   plugin/fm-mcp/             — vendored FileMaker MCP server.
 *
 * Writes:
 *   plugin/dist/skills/<prefix>-<name>/SKILL.md   — prefix-substituted skill files
 *   plugin/dist/fm-mcp/                           — copy of the vendored FM server
 *   plugin/dist/install.sh                         — one-shot installer
 *   plugin/dist/uninstall.sh                       — one-shot uninstaller
 *   plugin/dist/INSTALL.md                         — human-readable instructions
 *   plugin/dist/manifest.lock.json                 — what got built (versions, file count)
 *
 * The install path is direct: skill files go into ~/.claude/skills/<prefix>-<name>/
 * which Claude Code + Claude Desktop's Code mode + Cowork all read on session start.
 *
 * Idempotent. Safe to re-run after every code change. No marketplace dependency.
 *
 * Usage:
 *   bun run build:plugin
 *
 * Then on the install side:
 *   bash plugin/dist/install.sh
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, chmodSync, cpSync } from 'fs';
import { join, dirname } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'plugin', 'manifest.json');
const SKILLS_SRC_ROOT = join(REPO_ROOT, 'skills', 'dent');
const FM_MCP_SRC = join(REPO_ROOT, 'plugin', 'fm-mcp');
const DIST_ROOT = join(REPO_ROOT, 'plugin', 'dist');
const VERSION = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();

interface Manifest {
  manifest_version: string;
  deploy: {
    org_prefix: string;
    org_full_name: string;
    org_email_domain: string;
    deploy_id: string;
    server_url: string;
    server_url_dev?: string;
    data_repo: string;
  };
  skills: { templates: string[] };
  fm_mcp?: { enabled?: boolean; vendored_server_path?: string };
}

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as Manifest;
}

function applyPrefix(content: string, prefix: string): string {
  // Two patterns we actually substitute:
  //   {{prefix}}              -> dent
  //   {{server_url}}          -> https://dent-brain.dentthefuture.com/mcp
  // Other manifest fields aren't currently referenced in skill prose; if they
  // grow into the prose, add them here.
  return content.replaceAll('{{prefix}}', prefix);
}

function copySkill(skillName: string, prefix: string, manifest: Manifest): { src: string; dst: string; bytes: number } {
  const src = join(SKILLS_SRC_ROOT, skillName, 'SKILL.md');
  if (!existsSync(src)) {
    throw new Error(`Missing skill template: ${src}`);
  }
  const raw = readFileSync(src, 'utf-8');
  const substituted = applyPrefix(raw, prefix);

  // Final skill name is `${prefix}-${skillName}`. Two cases:
  //   - Templates that use {{prefix}}-<name> in their `name:` field (onboard-teammate).
  //     After substitution: `dent-onboard-teammate`. We need the directory to match.
  //   - Templates that already inline `/dent-<name>` in prose. The skill `name:` field
  //     is bare `<name>` (e.g. `name: append-evidence`). Directory becomes `dent-append-evidence`.
  //
  // Either way the on-disk directory under ~/.claude/skills/ is `${prefix}-${skillName}`.
  const dstDir = join(DIST_ROOT, 'skills', `${prefix}-${skillName}`);
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, 'SKILL.md');
  writeFileSync(dst, substituted);
  return { src, dst, bytes: Buffer.byteLength(substituted, 'utf-8') };
}

function buildInstallScript(prefix: string, skillNames: string[], manifest: Manifest): string {
  const fmEnabled = manifest.fm_mcp?.enabled === true;
  const skillDirs = skillNames.map((n) => `${prefix}-${n}`).join(' ');
  return `#!/usr/bin/env bash
# Dent Brain plugin installer (v${VERSION}).
# Copies the dent-prefixed skill files into ~/.claude/skills/ so Claude Code,
# Claude Desktop's Code mode, and Cowork mode all see the dent slash commands.
#
# Idempotent: re-run safely after a rebuild. Existing dent-* skill dirs in
# ~/.claude/skills/ are backed up to ~/.dent-brain/backups/ before overwrite.
#
# Usage:
#   bash plugin/dist/install.sh
# Then:
#   - Quit Claude Desktop fully (Cmd+Q) and relaunch.
#   - Open a NEW Cowork chat. (Tool + skill registries cache per chat — old
#     chats won't see the new slash commands until they're started fresh.)

set -euo pipefail

DEPLOY_ID="${manifest.deploy.deploy_id}"
PREFIX="${prefix}"
VERSION="${VERSION}"

DIST_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
SKILLS_DIR="$DIST_DIR/skills"
TARGET="$HOME/.claude/skills"
BACKUP_ROOT="$HOME/.dent-brain/backups"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$SKILLS_DIR" ]; then
  echo "FATAL: $SKILLS_DIR not found. Did the build run? ('bun run build:plugin' from the dent-brain repo)"
  exit 1
fi

mkdir -p "$TARGET"
mkdir -p "$BACKUP_ROOT"

echo "Installing dent-brain plugin v$VERSION (deploy: $DEPLOY_ID)"
echo "  source: $SKILLS_DIR"
echo "  target: $TARGET"
echo ""

INSTALLED=0
BACKED_UP=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name=$(basename "$skill_dir")
  target_dir="$TARGET/$skill_name"

  if [ -d "$target_dir" ]; then
    backup="$BACKUP_ROOT/$skill_name.$STAMP"
    cp -R "$target_dir" "$backup"
    rm -rf "$target_dir"
    BACKED_UP=$((BACKED_UP + 1))
    echo "  + $skill_name (backup: $backup)"
  else
    echo "  + $skill_name"
  fi

  cp -R "$skill_dir" "$target_dir"
  INSTALLED=$((INSTALLED + 1))
done

echo ""
echo "Installed $INSTALLED skill(s); $BACKED_UP previous version(s) backed up."

${
  fmEnabled
    ? `
# FileMaker MCP vendored server is present in the bundle but does NOT install
# automatically. FM MCP requires per-user FM credentials and is a separate
# stdio-mode connector registered in claude_desktop_config.json. If you need it,
# follow plugin/dist/fm-mcp/README.md (or the dent-setup-filemaker-mcp skill,
# once the per-org template lands).
echo ""
echo "Note: FileMaker MCP server is bundled at $DIST_DIR/fm-mcp/ but not auto-installed."
echo "      It needs per-user FM credentials — see plugin/dist/fm-mcp/README.md."
`
    : ''
}

echo ""
echo "Next:"
echo "  1. Quit Claude Desktop completely (Cmd+Q) and relaunch."
echo "  2. Start a NEW Cowork chat (tool/skill registries cache per chat)."
echo "  3. Try: \\\"/${prefix}-append-evidence remember that ...\\\""
echo ""
echo "Uninstall: bash $DIST_DIR/uninstall.sh"
`;
}

function buildUninstallScript(prefix: string, skillNames: string[]): string {
  return `#!/usr/bin/env bash
# Dent Brain plugin uninstaller. Removes ${prefix}-* skill directories from
# ~/.claude/skills/. Backups in ~/.dent-brain/backups/ are preserved.

set -euo pipefail

PREFIX="${prefix}"
TARGET="$HOME/.claude/skills"

REMOVED=0
${skillNames.map((n) => `if [ -d "$TARGET/${prefix}-${n}" ]; then rm -rf "$TARGET/${prefix}-${n}"; echo "  - ${prefix}-${n}"; REMOVED=$((REMOVED + 1)); fi`).join('\n')}

echo ""
echo "Removed $REMOVED dent-brain skill(s)."
echo "Backups preserved in ~/.dent-brain/backups/ — restore with: cp -R <backup> $TARGET/<name>"
`;
}

function buildInstallReadme(prefix: string, skillNames: string[], manifest: Manifest): string {
  const skillList = skillNames.map((n) => `- \`/${prefix}-${n}\``).join('\n');
  return `# Dent Brain plugin — install

Built from \`${manifest.deploy.deploy_id}\` deploy at v${VERSION}.

## What's in this bundle

${skillList}

(Plus the vendored FileMaker MCP server at \`fm-mcp/\` — separate install path.)

## Prerequisites

- The dent-brain MCP connector is already registered in your Claude Desktop config
  (admin gave you a one-paste Python block during \`/${prefix}-onboard-teammate\`,
  and it patched \`~/.claude.json\` + \`~/Library/Application Support/Claude/claude_desktop_config.json\`).
- Claude Desktop installed.

If your token isn't registered yet: stop here and ping the admin to run
\`/${prefix}-onboard-teammate\` for you. The skill files this bundle installs
are useless without the bearer token.

## Install

\`\`\`bash
bash install.sh
\`\`\`

That copies the ${skillNames.length} dent-prefixed skill folders into \`~/.claude/skills/\`.
Existing dent-* dirs are backed up to \`~/.dent-brain/backups/\` first.

Then:

1. **Quit Claude Desktop completely** (Cmd+Q, not just close the window).
2. **Relaunch** Claude Desktop.
3. **Start a NEW Cowork chat.** Tool/skill registries cache per chat — an
   already-open chat won't see the new slash commands.
4. Try \`/${prefix}-append-evidence remember that ...\` to confirm the skill
   loads. If Cowork autocompletes the command, the install worked.

## Uninstall

\`\`\`bash
bash uninstall.sh
\`\`\`

Removes the ${prefix}-* skill folders from \`~/.claude/skills/\`. Backups in
\`~/.dent-brain/backups/\` are preserved — restore with:

\`\`\`bash
cp -R ~/.dent-brain/backups/<skill-name>.<timestamp> ~/.claude/skills/<skill-name>
\`\`\`

## Rebuild

From the dent-brain repo root:

\`\`\`bash
bun run build:plugin && bash plugin/dist/install.sh
\`\`\`

Re-running install after a rebuild is safe — current versions get backed up,
new versions overwrite, you restart Claude Desktop.

## Troubleshooting

- **Cowork doesn't see the slash commands.** You skipped the relaunch + new
  chat step. Quit Claude Desktop fully (Cmd+Q), relaunch, start a new chat.
- **Slash command exists but Cowork agent freelances on \`put_page\`.** The
  skill prose loaded, but the agent decided to skip it. Try being explicit:
  \`/${prefix}-append-evidence\` before the observation text.
- **\`bash: install.sh: No such file or directory\`.** Run \`bun run build:plugin\`
  first to generate the dist directory.
`;
}

function buildLockfile(prefix: string, skillResults: Array<{ name: string; bytes: number }>, manifest: Manifest): string {
  const lock = {
    deploy_id: manifest.deploy.deploy_id,
    org_prefix: prefix,
    plugin_version: VERSION,
    server_url: manifest.deploy.server_url,
    data_repo: manifest.deploy.data_repo,
    built_at: new Date().toISOString(),
    skills: skillResults.map((r) => ({
      template: r.name,
      installed_as: `${prefix}-${r.name}`,
      bytes: r.bytes,
    })),
  };
  return JSON.stringify(lock, null, 2) + '\n';
}

function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

function main() {
  const manifest = readManifest();
  const prefix = manifest.deploy.org_prefix;
  if (!prefix || !/^[a-z][a-z0-9-]*$/.test(prefix)) {
    throw new Error(`Invalid org_prefix in manifest: ${JSON.stringify(prefix)}`);
  }

  console.log(`Building plugin for deploy '${manifest.deploy.deploy_id}' (prefix: ${prefix}, version: ${VERSION})`);

  // Clean dist root.
  if (existsSync(DIST_ROOT)) {
    rmSync(DIST_ROOT, { recursive: true });
  }
  mkdirSync(DIST_ROOT, { recursive: true });

  // Discover skill templates that exist on disk. The manifest declares the
  // canonical list; we enumerate `skills/dent/` and intersect, skipping any
  // template the manifest didn't declare.
  const onDisk = readdirSync(SKILLS_SRC_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const declared = manifest.skills.templates;
  const toBuild = declared.filter((name) => onDisk.includes(name));
  const missing = declared.filter((name) => !onDisk.includes(name));
  if (missing.length > 0) {
    console.log(`Note: ${missing.length} declared template(s) missing on disk: ${missing.join(', ')}`);
  }

  const skillResults: Array<{ name: string; bytes: number }> = [];
  for (const name of toBuild) {
    const r = copySkill(name, prefix, manifest);
    skillResults.push({ name, bytes: r.bytes });
    console.log(`  built: ${prefix}-${name}  (${r.bytes} bytes)`);
  }

  // Copy the FM MCP vendored server, if enabled.
  if (manifest.fm_mcp?.enabled && existsSync(FM_MCP_SRC)) {
    const fmDst = join(DIST_ROOT, 'fm-mcp');
    copyDir(FM_MCP_SRC, fmDst);
    console.log(`  copied: fm-mcp/ (vendored server)`);
  }

  // Write installer/uninstaller/readme/lockfile.
  const installSh = buildInstallScript(prefix, toBuild, manifest);
  writeFileSync(join(DIST_ROOT, 'install.sh'), installSh);
  chmodSync(join(DIST_ROOT, 'install.sh'), 0o755);

  const uninstallSh = buildUninstallScript(prefix, toBuild);
  writeFileSync(join(DIST_ROOT, 'uninstall.sh'), uninstallSh);
  chmodSync(join(DIST_ROOT, 'uninstall.sh'), 0o755);

  writeFileSync(join(DIST_ROOT, 'INSTALL.md'), buildInstallReadme(prefix, toBuild, manifest));
  writeFileSync(join(DIST_ROOT, 'manifest.lock.json'), buildLockfile(prefix, skillResults, manifest));

  console.log('');
  console.log(`Built ${toBuild.length} skill(s) into ${DIST_ROOT}`);
  console.log(`Install: bash ${join(DIST_ROOT, 'install.sh')}`);
}

main();
