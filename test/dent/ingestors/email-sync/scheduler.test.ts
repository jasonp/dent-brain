/**
 * Cross-platform scheduler abstraction tests (v0.40.x Windows email-sync).
 *
 * Pure, deterministic coverage of the parts that can be tested on macOS CI
 * without a Windows box: task-XML / plist rendering, the seconds→ISO-8601
 * duration conversion, the platform→scheduler factory selection, buildSpec's
 * platform branching, and the registry platform gating data. Live `schtasks`
 * execution is the Windows teammate's dogfood — out of scope here.
 */

import { describe, test, expect } from 'bun:test';
import {
  getScheduler,
  buildSpec,
  type ScheduleSpec,
} from '../../../../tools/extensions/scheduler/index.ts';
import { LaunchdScheduler, renderPlist } from '../../../../tools/extensions/scheduler/launchd.ts';
import {
  TaskSchedulerScheduler,
  renderTaskXml,
  secondsToIso8601Duration,
} from '../../../../tools/extensions/scheduler/task-scheduler.ts';
import { EXTENSIONS, findExtension } from '../../../../tools/extensions/registry.ts';

const spec: ScheduleSpec = {
  label: 'DentBrain-EmailSync',
  definitionPath: 'C:\\Users\\teammate\\.dent-brain\\email-sync\\email-sync.task.xml',
  bunPath: 'C:\\Users\\teammate\\.bun\\bin\\bun.exe',
  entryScript: 'C:\\Users\\teammate\\.dent-brain\\email-sync\\collect.ts',
  logPath: 'C:\\Users\\teammate\\.dent-brain\\email-sync\\sync.log',
  intervalSeconds: 21600,
  home: 'C:\\Users\\teammate',
};

describe('secondsToIso8601Duration', () => {
  test('whole hours → PTnH', () => {
    expect(secondsToIso8601Duration(21600)).toBe('PT6H'); // email-sync: 6h
    expect(secondsToIso8601Duration(3600)).toBe('PT1H'); // granola: 1h
  });
  test('hours + minutes', () => {
    expect(secondsToIso8601Duration(5400)).toBe('PT1H30M');
  });
  test('sub-hour minutes only', () => {
    expect(secondsToIso8601Duration(900)).toBe('PT15M');
  });
  test('sub-minute falls back to seconds (avoids empty PT)', () => {
    expect(secondsToIso8601Duration(30)).toBe('PT30S');
  });
});

describe('renderTaskXml', () => {
  const xml = renderTaskXml(spec);

  test('is valid-looking Task Scheduler XML with the right namespace', () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"');
  });
  test('carries BOTH triggers (repeat + at-logon)', () => {
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Interval>PT6H</Interval>');
  });
  test('Exec action points bun at the entry script', () => {
    expect(xml).toContain(`<Command>${spec.bunPath}</Command>`);
    expect(xml).toContain(`<Arguments>${spec.entryScript}</Arguments>`);
  });
  test('runs at least privilege under an interactive token (no stored password)', () => {
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });
  test('StartWhenAvailable so a missed interval still fires', () => {
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });
  test('XML-escapes special chars in paths', () => {
    const evil = renderTaskXml({ ...spec, entryScript: 'C:\\a & b\\collect.ts', bunPath: 'C:\\x<y>\\bun.exe' });
    expect(evil).toContain('C:\\a &amp; b\\collect.ts');
    expect(evil).toContain('C:\\x&lt;y&gt;\\bun.exe');
    expect(evil).not.toContain('a & b'); // raw ampersand must not survive
  });
  test('is deterministic (fixed StartBoundary — no wall-clock leak)', () => {
    expect(renderTaskXml(spec)).toBe(renderTaskXml(spec));
    expect(xml).toContain('<StartBoundary>2024-01-01T00:00:00</StartBoundary>');
  });
});

describe('renderPlist', () => {
  const plistSpec: ScheduleSpec = {
    ...spec,
    label: 'com.dent.email-sync',
    definitionPath: '/Users/x/Library/LaunchAgents/com.dent.email-sync.plist',
    bunPath: '/opt/homebrew/bin/bun',
    entryScript: '/Users/x/.dent-brain/email-sync/collect.ts',
    logPath: '/Users/x/.dent-brain/email-sync/sync.log',
    home: '/Users/x',
  };
  const plist = renderPlist(plistSpec);

  test('reproduces the legacy plist semantics (label, interval, RunAtLoad)', () => {
    expect(plist).toContain('<string>com.dent.email-sync</string>');
    expect(plist).toContain('<integer>21600</integer>'); // StartInterval
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
  });
  test('ProgramArguments = [bun, entry]', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('<string>/Users/x/.dent-brain/email-sync/collect.ts</string>');
  });
  test('injects HOME + a usable PATH for the minimal launchd env', () => {
    expect(plist).toContain('<string>/Users/x</string>'); // HOME
    expect(plist).toContain('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });
});

describe('getScheduler factory', () => {
  test('darwin → LaunchdScheduler', () => {
    const s = getScheduler('darwin');
    expect(s).toBeInstanceOf(LaunchdScheduler);
    expect(s.kind).toBe('launchd');
  });
  test('win32 → TaskSchedulerScheduler', () => {
    const s = getScheduler('win32');
    expect(s).toBeInstanceOf(TaskSchedulerScheduler);
    expect(s.kind).toBe('scheduled-task');
  });
  test('unsupported platform throws', () => {
    expect(() => getScheduler('linux' as NodeJS.Platform)).toThrow(/No scheduler for platform/);
  });
});

describe('buildSpec platform branching', () => {
  const ext = findExtension('email-sync')!;
  const expand = (p: string | undefined) => p?.replace(/\$\{HOME\}/g, '/home/u');

  test('darwin uses launchd label + plist path', () => {
    const s = buildSpec(ext, expand, '/bin/bun', '/home/u', 'darwin')!;
    expect(s.label).toBe('com.dent.email-sync');
    expect(s.definitionPath).toBe('/home/u/Library/LaunchAgents/com.dent.email-sync.plist');
    expect(s.intervalSeconds).toBe(21600);
  });
  test('win32 uses task name + task XML path', () => {
    const s = buildSpec(ext, expand, '/bin/bun', '/home/u', 'win32')!;
    expect(s.label).toBe('DentBrain-EmailSync');
    expect(s.definitionPath).toBe('/home/u/.dent-brain/email-sync/email-sync.task.xml');
  });
  test('logPath derives from installDir', () => {
    const s = buildSpec(ext, expand, '/bin/bun', '/home/u', 'darwin')!;
    expect(s.logPath).toBe('/home/u/.dent-brain/email-sync/sync.log');
  });
});

describe('registry platform gating', () => {
  test('granola-sync is macOS-only', () => {
    expect(findExtension('granola-sync')!.platform).toEqual(['darwin']);
  });
  test('email-sync runs on both macOS and Windows', () => {
    expect(findExtension('email-sync')!.platform).toEqual(['darwin', 'win32']);
  });
  test('every daemon extension carries the fields buildSpec needs on both platforms', () => {
    const expand = (p: string | undefined) => p?.replace(/\$\{HOME\}/g, '/home/u');
    for (const ext of EXTENSIONS) {
      if (ext.kind !== 'launchd-daemon' && ext.kind !== 'scheduled-task') continue;
      // macOS spec is always buildable (every daemon has launchd fields).
      expect(buildSpec(ext, expand, '/bin/bun', '/home/u', 'darwin')).not.toBeNull();
      // win32 spec buildable only when the extension supports win32.
      if (ext.platform?.includes('win32')) {
        const s = buildSpec(ext, expand, '/bin/bun', '/home/u', 'win32');
        expect(s).not.toBeNull();
        expect(s!.label).toBe(ext.taskName!);
      }
    }
  });
});
