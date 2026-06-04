/**
 * Windows scheduler: Task Scheduler via `schtasks` + a task-definition XML.
 *
 * Mirrors LaunchdScheduler. The task XML carries two triggers — a repeating
 * TimeTrigger (every `intervalSeconds`) and a LogonTrigger (the analogue of
 * launchd's RunAtLoad) — because `schtasks` command-line flags can express one
 * or the other but not both at once. `/xml` import is the only way to get the
 * combined schedule, which is why we render XML rather than pass flags.
 *
 * Untested on a real Windows box at author time (no Windows dogfood
 * environment). The render functions are pure and unit-tested on macOS CI;
 * runtime `schtasks` behavior is verified by the Windows teammate.
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import type { Scheduler, ScheduleSpec, ArmResult } from './index.ts';

/** Fixed, past StartBoundary so the rendered XML is deterministic (testable).
 * Task Scheduler computes the next occurrence from this anchor + the repetition
 * interval; combined with StartWhenAvailable the first run fires promptly. */
const START_BOUNDARY = '2024-01-01T00:00:00';

/** Convert seconds to an ISO-8601 duration Task Scheduler accepts for a
 * repetition interval (e.g. 21600 → "PT6H", 3600 → "PT1H", 5400 → "PT1H30M").
 * Exported for tests. Task Scheduler's minimum repetition interval is 1 minute;
 * our daemon intervals are hours, so sub-minute precision is dropped. */
export function secondsToIso8601Duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  let out = 'PT';
  if (hours > 0) out += `${hours}H`;
  if (minutes > 0) out += `${minutes}M`;
  // Guard against PT (zero) — fall back to whole seconds if under a minute.
  if (out === 'PT') out += `${seconds}S`;
  return out;
}

/** XML-escape the five predefined entities so paths with `&` etc. stay valid. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Render the Task Scheduler task-definition XML. Pure + deterministic.
 * Exported for tests. */
export function renderTaskXml(spec: ScheduleSpec): string {
  const interval = secondsToIso8601Duration(spec.intervalSeconds);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Dent Brain ${xmlEscape(spec.label)} ingester</Description>
    <URI>\\${xmlEscape(spec.label)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${START_BOUNDARY}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${interval}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(spec.bunPath)}</Command>
      <Arguments>${xmlEscape(spec.entryScript)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks /xml historically expects UTF-16LE with a BOM. Write it that way to
 * avoid the classic "The task XML is malformed" import failure on UTF-8 files. */
function writeTaskXml(path: string, xml: string): void {
  writeFileSync(path, '﻿' + xml, { encoding: 'utf16le' });
}

export class TaskSchedulerScheduler implements Scheduler {
  readonly kind = 'scheduled-task' as const;

  stage(spec: ScheduleSpec): void {
    writeTaskXml(spec.definitionPath, renderTaskXml(spec));
  }

  isLoaded(spec: ScheduleSpec): boolean {
    const r = spawnSync('schtasks', ['/Query', '/TN', spec.label], { encoding: 'utf-8' });
    return r.status === 0;
  }

  arm(spec: ScheduleSpec): ArmResult {
    if (!existsSync(spec.definitionPath)) {
      return { ok: false, error: `task XML not found at ${spec.definitionPath}. Re-run install.` };
    }
    // /F overwrites an existing task → idempotent arm (no separate teardown).
    const r = spawnSync('schtasks', ['/Create', '/TN', spec.label, '/XML', spec.definitionPath, '/F'], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      return { ok: false, error: `schtasks /Create failed (exit ${r.status}). Run \`schtasks /Query /TN ${spec.label}\` to inspect.` };
    }
    return { ok: true };
  }

  disarm(spec: ScheduleSpec): void {
    if (this.isLoaded(spec)) {
      spawnSync('schtasks', ['/Delete', '/TN', spec.label, '/F'], { stdio: 'inherit' });
    }
  }

  removeDefinition(spec: ScheduleSpec): void {
    if (existsSync(spec.definitionPath)) {
      try { unlinkSync(spec.definitionPath); } catch { /* best-effort */ }
    }
  }
}
