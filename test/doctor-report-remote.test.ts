/**
 * Tests for `doctorReportRemote()` — the focused thin-client doctor that
 * powers the run_doctor MCP op.
 *
 * Strategy: build a fresh PGLite engine + initSchema, run the report, assert
 * all 5 checks present + healthy. Uses the canonical PGLite test pattern
 * (beforeAll + afterAll, not beforeEach) per CLAUDE.md test-isolation rules.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { doctorReportRemote, computeDoctorReport, type DoctorReport, type Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let savedGbrainHome: string | undefined;
let tmpGbrainHome: string;

beforeAll(async () => {
  // Isolate $HOME so v0.31.8+ checks (minions_migration, sync_failures) that
  // read ~/.gbrain/migrations/completed.jsonl + sync-failures.jsonl don't
  // pull state from the developer machine. Without this, a wedged migration
  // on the host fails the test even though the brain itself is fresh.
  savedGbrainHome = process.env.GBRAIN_HOME;
  tmpGbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-test-'));
  process.env.GBRAIN_HOME = tmpGbrainHome;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { rmSync(tmpGbrainHome, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('doctorReportRemote', () => {
  test('runs all 5 checks on a fresh PGLite brain', async () => {
    const report = await doctorReportRemote(engine);
    expect(report.schema_version).toBe(2);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    const names = report.checks.map(c => c.name);
    expect(names).toContain('connection');
    expect(names).toContain('schema_version');
    expect(names).toContain('brain_score');
    expect(names).toContain('sync_failures');
    expect(names).toContain('queue_health');
  });

  test('connection check passes against a healthy engine', async () => {
    const report = await doctorReportRemote(engine);
    const conn = report.checks.find(c => c.name === 'connection');
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('ok');
    expect(conn!.message).toContain('Connected');
  });

  test('schema_version check shows the latest version', async () => {
    const report = await doctorReportRemote(engine);
    const sv = report.checks.find(c => c.name === 'schema_version');
    expect(sv).toBeDefined();
    // Fresh PGLite at LATEST_VERSION → status ok with "(latest)"
    expect(sv!.status).toBe('ok');
    expect(sv!.message.toLowerCase()).toContain('latest');
  });

  test('queue_health is informational on PGLite', async () => {
    const report = await doctorReportRemote(engine);
    const q = report.checks.find(c => c.name === 'queue_health');
    expect(q).toBeDefined();
    expect(q!.status).toBe('ok');
    // PGLite-specific message
    expect(q!.message).toContain('PGLite');
  });

  test('full report on healthy brain is "healthy" status', async () => {
    const report = await doctorReportRemote(engine);
    expect(report.status).toMatch(/healthy|warnings/);
    expect(report.health_score).toBeGreaterThanOrEqual(70);
  });
});

describe('computeDoctorReport — score + status math', () => {
  function check(status: Check['status']): Check {
    return { name: `check-${status}`, status, message: '' };
  }

  test('all-ok → healthy + 100', () => {
    const r = computeDoctorReport([check('ok'), check('ok'), check('ok')]);
    expect(r.status).toBe('healthy');
    expect(r.health_score).toBe(100);
  });

  test('one warn → warnings + score - 5', () => {
    const r = computeDoctorReport([check('ok'), check('warn'), check('ok')]);
    expect(r.status).toBe('warnings');
    expect(r.health_score).toBe(95);
  });

  test('one fail → unhealthy + score - 20', () => {
    const r = computeDoctorReport([check('ok'), check('fail'), check('ok')]);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(80);
  });

  test('mix of fail + warn → unhealthy (fail dominates)', () => {
    const r = computeDoctorReport([check('warn'), check('fail'), check('warn')]);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(70);
  });

  test('score floor at 0', () => {
    const fails: Check[] = [];
    for (let i = 0; i < 10; i++) fails.push(check('fail'));
    const r = computeDoctorReport(fails);
    expect(r.health_score).toBe(0);
  });

  test('schema_version is always 2', () => {
    const r: DoctorReport = computeDoctorReport([check('ok')]);
    expect(r.schema_version).toBe(2);
  });
});
