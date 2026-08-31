/**
 * REAL-binary door test — the gbrain CLAUDE CODE PLUGIN (the codex door's
 * sibling; see codex-plugin-install-real.serial.test.ts for the full contract
 * map). Stages a CLEAN tree via `git archive HEAD`, then:
 *
 *   1. VALIDATE + INSTALL (no auth turn): `claude plugin validate . --strict`,
 *      `claude plugin marketplace add <stage>`, `claude plugin install
 *      <plugin>@<marketplace>` (names read from the marketplace under test)
 *      — asserts the enable entry lands in the hermetic
 *      CLAUDE_CONFIG_DIR settings (the exact shape claudePluginProvidesName
 *      scans) and uninstall clears it.
 *
 *   2. SMOKE (live `claude -p` turn): the session's gbrain MCP server comes
 *      from the PLUGIN (inline mcpServers via ${CLAUDE_PLUGIN_ROOT} launcher);
 *      GBRAIN_* rides the parent env into the launcher. Asserts a gbrain MCP
 *      tool call in the stream AND the seeded fact in the final text.
 *
 * Hermetic per test; self-skips without a plugin-capable claude binary; the
 * SMOKE half additionally needs ANTHROPIC auth (claude's own login state).
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveClaudeBinary,
  claudeSupportsPlugins,
  hasClaudeAuth,
  claudeHeadlessTurn,
  seedBrainForAgent,
  hermeticChildEnv,
  ensureCompiledGbrain,
} from '../helpers/agent-harness.ts';
import { claudePluginProvidesName } from '../../src/core/bootstrap/harness.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const CLAUDE_BIN = resolveClaudeBinary();
const PLUGIN_CAPABLE = !!CLAUDE_BIN && claudeSupportsPlugins(CLAUDE_BIN);

/**
 * The marketplace + plugin names are GENERATED from `manifest.deploy.org_prefix`
 * (scripts/build-plugin.ts → `<prefix>-brain`), so a fork ships its own names.
 * Reading them out of the marketplace.json under test keeps this door pinned to
 * whatever the repo actually publishes instead of a hardcoded upstream spelling
 * — the old `gbrain@gbrain` literals turned every rebranded fork red with
 * `Plugin "gbrain" not found in marketplace "gbrain"`.
 *
 * The PRIMARY entry is the one whose name matches the marketplace; any other
 * entry is a persona variant (upstream ships gbrain-coding / gbrain-daily).
 */
function readMarketplace(root: string): { marketplace: string; primary: string; variants: string[] } {
  const path = join(root, '.claude-plugin', 'marketplace.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    name?: string;
    plugins?: Array<{ name: string }>;
  };
  const names = (parsed.plugins ?? []).map((p) => p.name).filter(Boolean);
  if (!parsed.name || names.length === 0) {
    throw new Error(`${path} declares no marketplace name or no plugins — nothing to install.`);
  }
  const primary = names.includes(parsed.name) ? parsed.name : names[0];
  return { marketplace: parsed.name, primary, variants: names.filter((n) => n !== primary) };
}

/**
 * Collection-time view, for the variant skip predicate only (the staged tree is
 * `git archive HEAD` of this repo). This runs at module load, BEFORE any
 * `skipIf`, so it must never throw: a repo with no marketplace should skip the
 * door, not crash the whole file at import. The in-test calls stay strict —
 * a STAGED tree missing its marketplace is a real failure worth surfacing.
 */
function readMarketplaceSafe(root: string): { marketplace: string; primary: string; variants: string[] } {
  try {
    return readMarketplace(root);
  } catch {
    return { marketplace: '', primary: '', variants: [] };
  }
}

const MARKETPLACE = readMarketplaceSafe(REPO_ROOT);

function stageCleanTree(): string {
  const stage = mkdtempSync(join(tmpdir(), 'gb-cplugin-stage-'));
  execFileSync('sh', ['-c', `git -C '${REPO_ROOT}' archive HEAD | tar -x -C '${stage}'`]);
  return stage;
}

function gbrainBinForTests(dir: string): string {
  const compiled = ensureCompiledGbrain(REPO_ROOT);
  if (compiled.binPath) return compiled.binPath;
  const shim = join(dir, 'gbrain-shim');
  writeFileSync(shim, `#!/bin/sh\nexec bun run '${CLI}' "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function makeClaudeRunner(home: string, configDir: string) {
  return (argv: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      env: hermeticChildEnv({ HOME: home, CLAUDE_CONFIG_DIR: configDir, ...extraEnv }) as Record<string, string>,
      timeout: 120_000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe.skipIf(!PLUGIN_CAPABLE)('claude plugin door — VALIDATE + INSTALL (no live turn)', () => {
  test('validate --strict → marketplace add → install → enable entry → uninstall', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-host-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      const run = makeClaudeRunner(home, configDir);

      // (a) The shipped manifests validate strict-clean.
      const validate = run([CLAUDE_BIN!, 'plugin', 'validate', stage, '--strict']);
      expect(validate.code, validate.stdout + validate.stderr).toBe(0);

      // (b) marketplace add from the CLEAN staged tree.
      const addMkt = run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]);
      expect(addMkt.code, addMkt.stderr).toBe(0);

      // (c) install — enable entry lands in the hermetic settings, in the
      // exact shape the coexistence detector scans.
      const { marketplace, primary } = readMarketplace(stage);
      const spec = `${primary}@${marketplace}`;
      const install = run([CLAUDE_BIN!, 'plugin', 'install', spec]);
      expect(install.code, install.stderr).toBe(0);
      const settingsPath = join(configDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      expect(claudePluginProvidesName(settingsPath, primary)).toBe(spec);

      // (d) uninstall clears the enable entry.
      const un = run([CLAUDE_BIN!, 'plugin', 'uninstall', spec]);
      expect(un.code, un.stderr).toBe(0);
      expect(claudePluginProvidesName(settingsPath, primary)).toBeNull();
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);

  // Persona variants (cathedral-7, prove-before-publish [CX11]): each extra
  // marketplace entry installs from its self-contained variant root BEFORE the
  // entries ship to real users.
  // Skipped on a build whose marketplace publishes only the primary entry —
  // scripts/build-plugin.ts emits one `<prefix>-brain` plugin, so a fork has no
  // variant to prove. The pin stays live for any build that does ship them.
  test.skipIf(MARKETPLACE.variants.length === 0)('persona variants install from the same marketplace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-variant-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      const run = makeClaudeRunner(home, configDir);
      const addMkt = run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]);
      expect(addMkt.code, addMkt.stderr).toBe(0);

      const { marketplace, variants } = readMarketplace(stage);
      // skipIf reads the WORKING TREE but the stage is `git archive HEAD`. If
      // they disagree the loop body would run zero assertions and pass green.
      expect(variants.length, 'staged marketplace publishes no variants').toBeGreaterThan(0);
      const settingsPath = join(configDir, 'settings.json');
      for (const variant of variants) {
        const spec = `${variant}@${marketplace}`;
        const install = run([CLAUDE_BIN!, 'plugin', 'install', spec]);
        expect(install.code, install.stderr).toBe(0);
        expect(claudePluginProvidesName(settingsPath, variant)).toBe(spec);

        const un = run([CLAUDE_BIN!, 'plugin', 'uninstall', spec]);
        expect(un.code, un.stderr).toBe(0);
        expect(claudePluginProvidesName(settingsPath, variant)).toBeNull();
      }
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);
});

describe.skipIf(!PLUGIN_CAPABLE || !hasClaudeAuth())('claude plugin door — SMOKE (live turn)', () => {
  test('plugin-provided MCP server answers from the brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-smoke-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      const sourceId = 'workspace';
      const seeded = await seedBrainForAgent(home, sourceId);

      const run = makeClaudeRunner(home, configDir);
      const { marketplace, primary } = readMarketplace(stage);
      expect(run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]).code).toBe(0);
      expect(run([CLAUDE_BIN!, 'plugin', 'install', `${primary}@${marketplace}`]).code).toBe(0);

      const binDir = mkdtempSync(join(tmpdir(), 'gb-cplugin-bin-'));
      const gbrainBin = gbrainBinForTests(binDir);

      const prompt =
        `You have a gbrain MCP tool connected to a knowledge brain (provided by the gbrain plugin). ` +
        `Using ONLY that brain (do not guess, do not use general knowledge), answer: ` +
        `${seeded.query} Report exactly what the brain says.`;

      const fact = 'rivermouth';
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';
      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await claudeHeadlessTurn({
          prompt,
          cwd: home,
          home,
          claudeConfigDir: configDir,
          timeoutMs: 230_000,
          extraEnv: { GBRAIN_BIN: gbrainBin, GBRAIN_HOME: home, GBRAIN_SOURCE: sourceId },
        });
        // Plugin-provided servers are plugin-namespaced (observed live:
        // `mcp__plugin_gbrain_gbrain__search`); a bootstrap-lane server would
        // be `mcp__gbrain__…`. Match both shapes.
        const usedMcp = turn.toolCalls.some((c) => /^mcp__.*gbrain.*__/.test(c));
        const gotFact = turn.finalText.toLowerCase().includes(fact);
        lastEvidence =
          `[claude plugin smoke attempt ${attempt}/${maxAttempts}] exit=${turn.exitCode} ` +
          `timedOut=${turn.timedOut} usedMcp=${usedMcp} gotFact=${gotFact}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\nfinalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);
        if (usedMcp && gotFact) passed = true;
      }
      expect(passed, `claude plugin SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);

      rmSync(binDir, { recursive: true, force: true });
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 900_000);
});
