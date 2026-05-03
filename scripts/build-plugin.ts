#!/usr/bin/env bun
/**
 * Build the Dent Brain plugin marketplace.
 *
 * Produces a Claude Code-compatible marketplace at `plugin/dist/` so the
 * dent skills register as a real plugin Cowork can discover. The freeform
 * `~/.claude/skills/` install path (used by gstack-style direct copies)
 * works for Claude Code but NOT Cowork — Cowork only loads skills that
 * came in via a marketplace install.
 *
 * Layout produced (matches the marketplace.json schema Claude Code's
 * `claude plugin marketplace add` reads):
 *
 *   plugin/dist/
 *     .claude-plugin/
 *       marketplace.json          — declares the dent-brain plugin
 *     dent-brain/
 *       .claude-plugin/
 *         plugin.json             — points at .claude/skills/
 *       .claude/
 *         skills/
 *           dent-append-evidence/SKILL.md
 *           dent-enrich/SKILL.md
 *           dent-resolve-entity/SKILL.md
 *           dent-onboard-teammate/SKILL.md
 *       README.md
 *     install.sh                  — registers marketplace + installs plugin
 *     uninstall.sh                — uninstalls + removes marketplace
 *     INSTALL.md                  — human-readable instructions
 *     manifest.lock.json          — what got built (versions, file count)
 *
 * Install runs:
 *   claude plugin marketplace add <abs-path-to-plugin-dist>
 *   claude plugin install dent-brain@dent-brain
 *
 * Then the plugin's skills land in:
 *   ~/.claude/plugins/cache/dent-brain/dent-brain/<version>/.claude/skills/<name>/SKILL.md
 *
 * Cowork reads from there. So does Claude Code.
 *
 * The build is idempotent. Re-runnable after every code change. The dist
 * is gitignored — regenerate on demand.
 *
 * Usage:
 *   bun run build:plugin
 *   bash plugin/dist/install.sh
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, chmodSync, cpSync } from 'fs';
import { join } from 'path';

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
  const raw = readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as Manifest;
}

function applyPrefix(content: string, prefix: string): string {
  return content.replaceAll('{{prefix}}', prefix);
}

function copySkill(skillName: string, prefix: string): { src: string; dst: string; bytes: number } {
  const src = join(SKILLS_SRC_ROOT, skillName, 'SKILL.md');
  if (!existsSync(src)) {
    throw new Error(`Missing skill template: ${src}`);
  }
  const raw = readFileSync(src, 'utf-8');
  const substituted = applyPrefix(raw, prefix);

  const dstDir = join(DIST_ROOT, 'dent-brain', '.claude', 'skills', `${prefix}-${skillName}`);
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, 'SKILL.md');
  writeFileSync(dst, substituted);
  return { src, dst, bytes: Buffer.byteLength(substituted, 'utf-8') };
}

function buildMarketplaceJson(manifest: Manifest, builtSkills: string[]): string {
  // marketplace.json — top-level descriptor, points at the plugin source dir.
  // Schema: https://anthropic.com/claude-code/marketplace.schema.json
  const marketplace = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: 'dent-brain',
    description: 'Dent Brain skills for the markdown-canonical brain. Adds /dent-append-evidence, /dent-enrich, /dent-resolve-entity, /dent-onboard-teammate.',
    owner: {
      name: manifest.deploy.org_full_name,
      url: `https://github.com/dentthefuture/dent-brain-data`,
    },
    plugins: [
      {
        name: 'dent-brain',
        description: `${manifest.deploy.org_full_name} markdown-canonical brain skills (${builtSkills.length} skill${builtSkills.length === 1 ? '' : 's'}).`,
        version: VERSION,
        author: {
          name: manifest.deploy.org_full_name,
          url: `https://${manifest.deploy.org_email_domain}`,
        },
        source: './dent-brain',
        category: 'productivity',
        homepage: `https://${manifest.deploy.org_email_domain}`,
      },
    ],
  };
  return JSON.stringify(marketplace, null, 2) + '\n';
}

function buildPluginJson(manifest: Manifest): string {
  // plugin.json — per-plugin manifest. The "skills" field points at a
  // directory containing one subdir per skill. Same shape impeccable uses.
  const plugin = {
    name: 'dent-brain',
    version: VERSION,
    description: `${manifest.deploy.org_full_name} brain skills. Markdown-canonical writes through dent-brain MCP.`,
    author: {
      name: manifest.deploy.org_full_name,
      url: `https://${manifest.deploy.org_email_domain}`,
    },
    homepage: `https://${manifest.deploy.org_email_domain}`,
    repository: 'https://github.com/jasonp/dent-brain',
    license: 'MIT',
    keywords: ['dent-brain', 'markdown', 'mcp', 'cowork'],
    skills: './.claude/skills',
  };
  return JSON.stringify(plugin, null, 2) + '\n';
}

function buildPluginReadme(manifest: Manifest, builtSkills: string[], prefix: string): string {
  const skillList = builtSkills.map((n) => `- \`/${prefix}-${n}\``).join('\n');
  return `# Dent Brain plugin (v${VERSION})

Cowork-installable plugin for the Dent Brain markdown-canonical write path. Adds ${builtSkills.length} skill${builtSkills.length === 1 ? '' : 's'}:

${skillList}

The plugin assumes the dent-brain MCP connector is already registered in
your Claude Desktop config (the bearer-token install from
\`/${prefix}-onboard-teammate\`). The skills call that connector's tools
(\`markdown_append_to_page\`, \`detect_entities\`, \`fm_get_record\`, etc.)
to do real work — without the connector, the skill prose loads but tool
calls fail with "Unknown tool".

## Install

From the dent-brain repo root, run \`bash plugin/dist/install.sh\`.
That registers \`plugin/dist\` as a Claude Code marketplace and installs
the \`dent-brain\` plugin from it. After Claude Desktop restart, both
Code mode and Cowork mode see the slash commands.

## Source

This plugin is built from \`https://github.com/jasonp/dent-brain\` at
\`v${VERSION}\`. Rebuild after every code change with
\`bun run build:plugin\` from the repo root.
`;
}

function buildInstallScript(prefix: string, builtSkills: string[]): string {
  const skillNames = builtSkills.map((n) => `${prefix}-${n}`).join(' ');
  return `#!/usr/bin/env bash
# Dent Brain plugin installer (v${VERSION}).
#
# Registers plugin/dist/ as a local Claude Code marketplace, then installs
# the dent-brain plugin from it. Runs:
#
#   claude plugin marketplace add <abs-path-to-plugin/dist>
#   claude plugin install dent-brain@dent-brain
#
# Idempotent. Re-running after a rebuild updates the marketplace + bumps
# the installed plugin to the new version.
#
# Also: if a previous build of this plugin used the freeform
# ~/.claude/skills/dent-* install path, those directories are removed so
# the marketplace install becomes the single source of truth.

set -euo pipefail

DIST_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
TARGET_FREEFORM="$HOME/.claude/skills"
VERSION="${VERSION}"
MARKETPLACE_NAME="dent-brain"
PLUGIN_NAME="dent-brain"

echo "Installing dent-brain plugin v$VERSION via Claude Code marketplace"
echo "  source: $DIST_DIR"
echo ""

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH. Install Claude Code first:"
  echo "  https://claude.ai/download   (or)   ${'$'}HOME/.local/bin/claude"
  exit 1
fi

# 1. Clean up any previous freeform install (gstack-style direct copy).
#    Cowork doesn't read from there anyway; remove to avoid two sources of truth.
FREEFORM_REMOVED=0
for skill in ${skillNames}; do
  if [ -d "$TARGET_FREEFORM/$skill" ]; then
    rm -rf "$TARGET_FREEFORM/$skill"
    echo "  cleaned: $TARGET_FREEFORM/$skill (legacy freeform install)"
    FREEFORM_REMOVED=$((FREEFORM_REMOVED + 1))
  fi
done

# 2. Add the local dist directory as a marketplace. Idempotent — Claude
#    Code's marketplace add is a no-op if the source path is already
#    registered.
echo ""
echo "Registering marketplace at $DIST_DIR..."
claude plugin marketplace add "$DIST_DIR" 2>&1 | sed 's/^/  /' || true

# 3. Install / update the plugin.
echo ""
echo "Installing $PLUGIN_NAME@$MARKETPLACE_NAME..."
claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

# 4. Verify install landed.
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
echo "Next:"
echo "  1. Quit Claude Desktop completely (Cmd+Q) and relaunch."
echo "  2. Start a NEW Cowork chat (tool/skill registries cache per chat)."
echo "  3. Try: /${prefix}-append-evidence remember that ..."
echo ""
echo "Uninstall: bash $DIST_DIR/uninstall.sh"
`;
}

function buildUninstallScript(): string {
  return `#!/usr/bin/env bash
# Dent Brain plugin uninstaller. Removes the dent-brain plugin and its
# marketplace from Claude Code.

set -euo pipefail

MARKETPLACE_NAME="dent-brain"
PLUGIN_NAME="dent-brain"

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH."
  exit 1
fi

echo "Uninstalling $PLUGIN_NAME@$MARKETPLACE_NAME..."
claude plugin uninstall "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Removing marketplace $MARKETPLACE_NAME..."
claude plugin marketplace remove "$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Done. Restart Claude Desktop to clear the slash-command cache."
`;
}

function buildInstallReadme(prefix: string, builtSkills: string[]): string {
  const skillList = builtSkills.map((n) => `- \`/${prefix}-${n}\``).join('\n');
  return `# Dent Brain plugin — install (v${VERSION})

Built artifact in this directory. Two-command install.

## What this installs

A local Claude Code marketplace named \`dent-brain\` containing one plugin (\`dent-brain\`) with ${builtSkills.length} skill${builtSkills.length === 1 ? '' : 's'}:

${skillList}

(Plus a vendored FileMaker MCP server at \`fm-mcp/\` — separate install path.)

## Prerequisites

- The \`claude\` CLI is on PATH (\`which claude\`).
- The dent-brain MCP connector is already registered in your Claude
  Desktop config (admin gave you a one-paste Python block during
  \`/${prefix}-onboard-teammate\`). The skills are useless without the
  bearer token they call through.
- Claude Desktop installed.

## Install

\`\`\`bash
bash install.sh
\`\`\`

That:

1. Removes any legacy freeform \`~/.claude/skills/dent-*\` directories
   from a previous direct-copy install (those don't work for Cowork
   anyway).
2. Registers this directory as a Claude Code marketplace via
   \`claude plugin marketplace add\`.
3. Installs the plugin via \`claude plugin install dent-brain@dent-brain\`.
4. Verifies the install via \`claude plugin list\`.

Then:

1. **Quit Claude Desktop completely** (Cmd+Q, not just close the window).
2. **Relaunch.**
3. **Start a NEW Cowork chat.** Tool/skill registries cache per chat.
4. Try \`/${prefix}-append-evidence remember that ...\`. Cowork should
   autocomplete the slash command — that's how you know the plugin
   loaded.

## Uninstall

\`\`\`bash
bash uninstall.sh
\`\`\`

Removes the plugin and the marketplace. Backups aren't created — the
plugin source still lives in the dent-brain repo, so reinstall is
\`bash install.sh\`.

## Rebuild loop

From the dent-brain repo root:

\`\`\`bash
bun run build:plugin && bash plugin/dist/install.sh
\`\`\`

Re-running install after a rebuild bumps the installed plugin version
in place. No restart of Claude Desktop is needed for the plugin update
itself — only the very first install (when it appeared from nothing)
required restart for slash-command discovery.

## Troubleshooting

- **\`Unknown skill: dent-append-evidence\` in Cowork.** The plugin isn't
  installed via marketplace yet. Cowork doesn't read \`~/.claude/skills/\`
  directly. Run \`bash install.sh\` and restart Claude Desktop.
- **\`claude plugin list\` doesn't show the plugin.** The marketplace
  registration may have failed. Run \`claude plugin marketplace list\` —
  you should see \`dent-brain\`. If not, re-run \`bash install.sh\`.
- **Slash command works in Code mode but not Cowork.** You skipped the
  Cmd+Q restart. Window-close isn't enough on macOS.
- **Slash command exists but agent freelances on \`put_page\`.** The
  prose loaded but the agent decided to skip it. Try being explicit:
  type \`/${prefix}-append-evidence\` first, then the observation.
`;
}

function buildLockfile(prefix: string, skillResults: Array<{ name: string; bytes: number }>, manifest: Manifest): string {
  const lock = {
    deploy_id: manifest.deploy.deploy_id,
    org_prefix: prefix,
    plugin_version: VERSION,
    server_url: manifest.deploy.server_url,
    data_repo: manifest.deploy.data_repo,
    marketplace_name: 'dent-brain',
    plugin_name: 'dent-brain',
    install_command: 'claude plugin install dent-brain@dent-brain',
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

  console.log(`Building plugin marketplace for deploy '${manifest.deploy.deploy_id}' (prefix: ${prefix}, version: ${VERSION})`);

  // Clean dist root.
  if (existsSync(DIST_ROOT)) {
    rmSync(DIST_ROOT, { recursive: true });
  }
  mkdirSync(DIST_ROOT, { recursive: true });
  mkdirSync(join(DIST_ROOT, '.claude-plugin'), { recursive: true });
  mkdirSync(join(DIST_ROOT, 'dent-brain', '.claude-plugin'), { recursive: true });
  mkdirSync(join(DIST_ROOT, 'dent-brain', '.claude', 'skills'), { recursive: true });

  // Discover skill templates.
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
    const r = copySkill(name, prefix);
    skillResults.push({ name, bytes: r.bytes });
    console.log(`  built: ${prefix}-${name}  (${r.bytes} bytes)`);
  }

  // Marketplace + plugin manifests.
  writeFileSync(join(DIST_ROOT, '.claude-plugin', 'marketplace.json'), buildMarketplaceJson(manifest, toBuild));
  writeFileSync(join(DIST_ROOT, 'dent-brain', '.claude-plugin', 'plugin.json'), buildPluginJson(manifest));
  writeFileSync(join(DIST_ROOT, 'dent-brain', 'README.md'), buildPluginReadme(manifest, toBuild, prefix));

  // FM MCP vendored server (separate install — bundle as reference).
  if (manifest.fm_mcp?.enabled && existsSync(FM_MCP_SRC)) {
    const fmDst = join(DIST_ROOT, 'fm-mcp');
    copyDir(FM_MCP_SRC, fmDst);
    console.log(`  copied: fm-mcp/ (vendored server, separate install)`);
  }

  // Installer / uninstaller / readme / lockfile.
  const installSh = buildInstallScript(prefix, toBuild);
  writeFileSync(join(DIST_ROOT, 'install.sh'), installSh);
  chmodSync(join(DIST_ROOT, 'install.sh'), 0o755);

  const uninstallSh = buildUninstallScript();
  writeFileSync(join(DIST_ROOT, 'uninstall.sh'), uninstallSh);
  chmodSync(join(DIST_ROOT, 'uninstall.sh'), 0o755);

  writeFileSync(join(DIST_ROOT, 'INSTALL.md'), buildInstallReadme(prefix, toBuild));
  writeFileSync(join(DIST_ROOT, 'manifest.lock.json'), buildLockfile(prefix, skillResults, manifest));

  console.log('');
  console.log(`Built marketplace 'dent-brain' with plugin 'dent-brain' (${toBuild.length} skills) into ${DIST_ROOT}`);
  console.log(`Install: bash ${join(DIST_ROOT, 'install.sh')}`);
}

main();
