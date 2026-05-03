#!/usr/bin/env bun
/**
 * Build the org's plugin marketplace from skill templates.
 *
 * Reads:
 *   plugin/manifest.json       — deploy config (org_prefix, server_url, etc.)
 *   skills/<prefix>/<name>/SKILL.md
 *                              — skill templates with {{prefix}} placeholders
 *   plugin/fm-mcp/             — vendored FileMaker MCP server (when enabled)
 *
 * Writes:
 *   .claude-plugin/marketplace.json
 *                              — TOP-LEVEL marketplace, makes the repo
 *                                Cowork-installable as `add github:<owner>/<repo>`.
 *                                Points at ./plugin/marketplace as the plugin source.
 *   plugin/marketplace/.claude-plugin/plugin.json
 *                              — plugin manifest, declares "skills": "./.claude/skills"
 *   plugin/marketplace/.claude/skills/<prefix>-<name>/SKILL.md
 *                              — prefix-substituted skill files, both the
 *                                directory name and the frontmatter `name:`
 *                                field carry the org prefix.
 *   plugin/marketplace/README.md
 *   plugin/marketplace/manifest.lock.json
 *   plugin/marketplace/install-local.sh
 *                              — local-machine helper that registers this
 *                                directory as a Claude Code marketplace via
 *                                `claude plugin marketplace add`. Useful for
 *                                Code-mode use without Cowork. Cowork install
 *                                goes through GitHub.
 *   plugin/marketplace/uninstall-local.sh
 *
 * The whole `plugin/marketplace/` tree is COMMITTED to git. Forks regenerate
 * by running `bun run build:plugin` after editing `plugin/manifest.json`
 * (or via the guided `bun run setup` script).
 *
 * The committed top-level `.claude-plugin/marketplace.json` is what makes
 * `claude plugin marketplace add github:<owner>/<repo>` work. Cowork's
 * marketplace-add flow uses the same path.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, chmodSync, cpSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'plugin', 'manifest.json');
const FM_MCP_SRC = join(REPO_ROOT, 'plugin', 'fm-mcp');
const VERSION = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();

/** The committed marketplace artifact. Forks regenerate this and commit it. */
const MARKETPLACE_DIR = join(REPO_ROOT, 'plugin', 'marketplace');

/** The top-level repo-root marketplace.json that makes the repo
 *  Cowork-installable as `add github:<owner>/<repo>`. */
const TOP_LEVEL_MARKETPLACE_DIR = join(REPO_ROOT, '.claude-plugin');

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
    /** GitHub `owner/repo` of THIS fork — used in the committed marketplace
     *  metadata so cross-references (homepage, repository) resolve. Defaults
     *  to deriving from `git remote get-url origin` if absent. */
    code_repo?: string;
  };
  skills: { templates: string[] };
  fm_mcp?: { enabled?: boolean; vendored_server_path?: string };
}

function readManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as Manifest;
}

function applyPrefix(content: string, prefix: string): string {
  return content.replaceAll('{{prefix}}', prefix);
}

function copySkill(skillName: string, prefix: string, skillsSrcRoot: string): { src: string; dst: string; bytes: number } {
  const src = join(skillsSrcRoot, skillName, 'SKILL.md');
  if (!existsSync(src)) {
    throw new Error(`Missing skill template: ${src}`);
  }
  const raw = readFileSync(src, 'utf-8');
  const substituted = applyPrefix(raw, prefix);

  const dstDir = join(MARKETPLACE_DIR, '.claude', 'skills', `${prefix}-${skillName}`);
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, 'SKILL.md');
  writeFileSync(dst, substituted);
  return { src, dst, bytes: Buffer.byteLength(substituted, 'utf-8') };
}

function buildTopLevelMarketplaceJson(manifest: Manifest): string {
  const orgPrefix = manifest.deploy.org_prefix;
  const pluginName = `${orgPrefix}-brain`;
  const marketplaceName = `${orgPrefix}-brain`;
  return JSON.stringify(
    {
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: marketplaceName,
      description: `${manifest.deploy.org_full_name} markdown-canonical brain. Cowork plugin: agent-side observation logging via /${orgPrefix}-append-evidence, page synthesis via /${orgPrefix}-enrich, entity disambiguation via /${orgPrefix}-resolve-entity, teammate onboarding via /${orgPrefix}-onboard-teammate.`,
      owner: {
        name: manifest.deploy.org_full_name,
        url: `https://${manifest.deploy.org_email_domain}`,
      },
      plugins: [
        {
          name: pluginName,
          description: `${manifest.deploy.org_full_name} brain skills.`,
          version: VERSION,
          source: './plugin/marketplace',
          category: 'productivity',
          author: {
            name: manifest.deploy.org_full_name,
            url: `https://${manifest.deploy.org_email_domain}`,
          },
          homepage: `https://${manifest.deploy.org_email_domain}`,
        },
      ],
    },
    null,
    2,
  ) + '\n';
}

function buildPluginJson(manifest: Manifest): string {
  const orgPrefix = manifest.deploy.org_prefix;
  return JSON.stringify(
    {
      name: `${orgPrefix}-brain`,
      version: VERSION,
      description: `${manifest.deploy.org_full_name} brain skills. Markdown-canonical writes through the ${orgPrefix}-brain MCP.`,
      author: {
        name: manifest.deploy.org_full_name,
        url: `https://${manifest.deploy.org_email_domain}`,
      },
      homepage: `https://${manifest.deploy.org_email_domain}`,
      repository: manifest.deploy.code_repo ? `https://github.com/${manifest.deploy.code_repo}` : undefined,
      license: 'MIT',
      keywords: [`${orgPrefix}-brain`, 'markdown', 'mcp', 'cowork'],
      skills: './.claude/skills',
    },
    null,
    2,
  ) + '\n';
}

function buildPluginReadme(manifest: Manifest, builtSkills: string[]): string {
  const orgPrefix = manifest.deploy.org_prefix;
  const skillList = builtSkills.map((n) => `- \`/${orgPrefix}-${n}\``).join('\n');
  return `# ${manifest.deploy.org_full_name} Brain — Cowork plugin (v${VERSION})

Adds ${builtSkills.length} slash command${builtSkills.length === 1 ? '' : 's'}:

${skillList}

These run on top of the \`${orgPrefix}-brain\` MCP server at \`${manifest.deploy.server_url}\`.

## Prerequisites

The MCP connector must be registered in your Claude Desktop config first.
The admin runs \`/${orgPrefix}-onboard-teammate\` for you, which produces a
one-paste install command.

## Installing this plugin in Cowork

In a Cowork chat, ask: *"Add a custom marketplace from \`github:${manifest.deploy.code_repo ?? '<your-fork>'}\` and install the ${orgPrefix}-brain plugin."*

Cowork pulls the repo, registers it as a marketplace, and installs the
plugin into its own per-session cache. After Claude Desktop restart and
a fresh chat, the slash commands are available.

For full setup (admin: provision server, deploy keys, ingestors), see
\`docs/dent-brain/SETUP.md\` in the source repo.

## Installing this plugin in Code mode (terminal CLI)

\`\`\`bash
bash plugin/marketplace/install-local.sh
\`\`\`

This registers the local \`plugin/marketplace\` as a Claude Code marketplace
and installs the plugin via \`claude plugin install\`. Code mode reads from
\`~/.claude/plugins/cache\`, separate from Cowork's store.

## Source

Built from \`${manifest.deploy.code_repo ? `https://github.com/${manifest.deploy.code_repo}` : '<your-fork>'}\` at v${VERSION}.
Rebuild from source skill templates with \`bun run build:plugin\` from the
source repo root. Forks customize via \`bun run setup\`.
`;
}

function buildLocalInstallScript(manifest: Manifest, builtSkills: string[]): string {
  const orgPrefix = manifest.deploy.org_prefix;
  const pluginName = `${orgPrefix}-brain`;
  const skillNames = builtSkills.map((n) => `${orgPrefix}-${n}`).join(' ');
  return `#!/usr/bin/env bash
# ${manifest.deploy.org_full_name} Brain plugin — Code-mode local installer (v${VERSION}).
#
# Registers plugin/marketplace/ as a local Claude Code marketplace, then
# installs the plugin from it. This is for Code mode (terminal CLI / Claude
# Desktop's Code mode) only — Cowork has a separate plugin store.
#
# For Cowork install: in a Cowork chat, ask Cowork to "add a custom
# marketplace from github:<your-fork>" and install ${pluginName}.

set -euo pipefail

DIST_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
TARGET_FREEFORM="$HOME/.claude/skills"
MARKETPLACE_NAME="${pluginName}"
PLUGIN_NAME="${pluginName}"

echo "Installing $PLUGIN_NAME plugin v${VERSION} via Claude Code marketplace"
echo "  source: $DIST_DIR"
echo ""

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH. Install Claude Code first:"
  echo "  https://claude.ai/download"
  exit 1
fi

# Clean up any legacy freeform install from the v0.29 build pattern.
FREEFORM_REMOVED=0
for skill in ${skillNames}; do
  if [ -d "$TARGET_FREEFORM/$skill" ]; then
    rm -rf "$TARGET_FREEFORM/$skill"
    echo "  cleaned: $TARGET_FREEFORM/$skill (legacy freeform install)"
    FREEFORM_REMOVED=$((FREEFORM_REMOVED + 1))
  fi
done

echo ""
echo "Registering local marketplace at $DIST_DIR..."
claude plugin marketplace add "$DIST_DIR" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Installing $PLUGIN_NAME@$MARKETPLACE_NAME..."
claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Verifying install..."
if claude plugin list 2>/dev/null | grep -q "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
  echo "  ✓ $PLUGIN_NAME@$MARKETPLACE_NAME is installed"
else
  echo "  ✗ install verification failed — run 'claude plugin list' to debug"
  exit 2
fi

echo ""
echo "Done. $FREEFORM_REMOVED legacy freeform install(s) cleaned, plugin installed."
echo ""
echo "Code mode will see the slash commands on the next session start."
echo ""
echo "For Cowork: open Cowork and ask"
echo "    'Add a custom marketplace from github:<your-fork> and install $PLUGIN_NAME'"
echo "Cowork has its own separate plugin store; the local marketplace this"
echo "script registered does NOT reach Cowork."
echo ""
echo "Uninstall (Code mode): bash $DIST_DIR/uninstall-local.sh"
`;
}

function buildLocalUninstallScript(manifest: Manifest): string {
  const orgPrefix = manifest.deploy.org_prefix;
  const pluginName = `${orgPrefix}-brain`;
  return `#!/usr/bin/env bash
# Uninstall the local Code-mode marketplace registration. Cowork install
# (if any) is unaffected — it uses a separate store.

set -euo pipefail

MARKETPLACE_NAME="${pluginName}"
PLUGIN_NAME="${pluginName}"

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH."
  exit 1
fi

echo "Uninstalling $PLUGIN_NAME@$MARKETPLACE_NAME (Code mode only)..."
claude plugin uninstall "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Removing local marketplace $MARKETPLACE_NAME..."
claude plugin marketplace remove "$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Done. Restart Claude Desktop / Code session to clear cached state."
`;
}

function buildLockfile(prefix: string, skillResults: Array<{ name: string; bytes: number }>, manifest: Manifest): string {
  const lock = {
    deploy_id: manifest.deploy.deploy_id,
    org_prefix: prefix,
    plugin_version: VERSION,
    plugin_name: `${prefix}-brain`,
    marketplace_name: `${prefix}-brain`,
    server_url: manifest.deploy.server_url,
    data_repo: manifest.deploy.data_repo,
    code_repo: manifest.deploy.code_repo,
    cowork_install_hint: `Ask Cowork: "Add a custom marketplace from github:${manifest.deploy.code_repo ?? '<your-fork>'} and install ${prefix}-brain"`,
    code_install_command: 'bash plugin/marketplace/install-local.sh',
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

  const skillsSrcRoot = join(REPO_ROOT, 'skills', prefix);
  if (!existsSync(skillsSrcRoot)) {
    throw new Error(
      `Skill source dir not found: ${skillsSrcRoot}\n` +
      `Expected: skills/${prefix}/  (matches manifest.deploy.org_prefix).\n` +
      `Forks: rename skills/dent/ → skills/${prefix}/ before building, or run \`bun run setup\` to do it for you.`,
    );
  }

  console.log(`Building plugin marketplace for deploy '${manifest.deploy.deploy_id}' (prefix: ${prefix}, version: ${VERSION})`);

  // Clean and recreate the marketplace dir.
  if (existsSync(MARKETPLACE_DIR)) {
    rmSync(MARKETPLACE_DIR, { recursive: true });
  }
  mkdirSync(MARKETPLACE_DIR, { recursive: true });
  mkdirSync(join(MARKETPLACE_DIR, '.claude-plugin'), { recursive: true });
  mkdirSync(join(MARKETPLACE_DIR, '.claude', 'skills'), { recursive: true });

  // Discover skill templates.
  const onDisk = readdirSync(skillsSrcRoot, { withFileTypes: true })
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
    const r = copySkill(name, prefix, skillsSrcRoot);
    skillResults.push({ name, bytes: r.bytes });
    console.log(`  built: ${prefix}-${name}  (${r.bytes} bytes)`);
  }

  // Plugin manifest + README + lockfile in plugin/marketplace/
  writeFileSync(join(MARKETPLACE_DIR, '.claude-plugin', 'plugin.json'), buildPluginJson(manifest));
  writeFileSync(join(MARKETPLACE_DIR, 'README.md'), buildPluginReadme(manifest, toBuild));
  writeFileSync(join(MARKETPLACE_DIR, 'manifest.lock.json'), buildLockfile(prefix, skillResults, manifest));

  // Local install scripts (Code mode helper).
  writeFileSync(join(MARKETPLACE_DIR, 'install-local.sh'), buildLocalInstallScript(manifest, toBuild));
  chmodSync(join(MARKETPLACE_DIR, 'install-local.sh'), 0o755);
  writeFileSync(join(MARKETPLACE_DIR, 'uninstall-local.sh'), buildLocalUninstallScript(manifest));
  chmodSync(join(MARKETPLACE_DIR, 'uninstall-local.sh'), 0o755);

  // FM MCP vendored server (if enabled — bundled as reference, separate install).
  if (manifest.fm_mcp?.enabled && existsSync(FM_MCP_SRC)) {
    copyDir(FM_MCP_SRC, join(MARKETPLACE_DIR, 'fm-mcp'));
    console.log('  copied: fm-mcp/ (vendored server, separate install)');
  }

  // TOP-LEVEL marketplace.json — the file that makes
  // `add github:<owner>/<repo>` work (both Code and Cowork).
  mkdirSync(TOP_LEVEL_MARKETPLACE_DIR, { recursive: true });
  writeFileSync(join(TOP_LEVEL_MARKETPLACE_DIR, 'marketplace.json'), buildTopLevelMarketplaceJson(manifest));

  console.log('');
  console.log(`Built marketplace '${prefix}-brain' with plugin '${prefix}-brain' (${toBuild.length} skills)`);
  console.log(`  top-level:        ${join(TOP_LEVEL_MARKETPLACE_DIR, 'marketplace.json')}`);
  console.log(`  plugin source:    ${MARKETPLACE_DIR}`);
  console.log('');
  console.log('Next:');
  console.log(`  Cowork:    ask Cowork to "add a custom marketplace from github:<your-fork> and install ${prefix}-brain"`);
  console.log(`  Code mode: bash plugin/marketplace/install-local.sh`);
  console.log(`  Commit:    git add .claude-plugin plugin/marketplace && git commit -m "build: plugin v${VERSION}"`);
}

main();
