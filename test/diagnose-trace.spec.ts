import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diagnoseTraceBuffer,
  diagnoseTraceInfo,
  renderTraceReport,
} from '../src/trace/diagnose-trace';
import {
  parseTraceEvents,
  readTraceZip,
  SUPPORTED_TRACE_VERSIONS,
  TraceParseError,
  UnsupportedTraceVersionError,
} from '../src/trace/read-trace';
import { readZipEntry, zipEntryNames, ZipError } from '../src/trace/zip';
import { capConfidence } from '../src/host/confidence';
import { diagnose } from '../src/host/diagnose';
import { syntheticDelta } from '../src/host/synthetic-delta';

// #9 offline `diagnose-trace`. The engine is the shared diagnose(); these tests pin the trace-only
// contract: read a real trace.zip, reconstruct the failing action's cause from its error + call-log,
// and NEVER over-claim — every offline cause is clamped to `suspected`, and a non-actionability or
// unresolved failure stays `unsure` (never fabricated).

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/traces');
const fx = (name: string): Buffer => readFileSync(resolve(FX, `${name}.trace.zip`));
const ALL_FIXTURES = [
  'covered',
  'covered-testrunner',
  'disabled',
  'unresolved',
  'assertion',
  'detached',
] as const;

test('should_diagnose_covered_overlay_as_suspected_from_a_real_trace', () => {
  const d = diagnoseTraceBuffer(fx('covered'), 'covered.trace.zip');
  expect(d.action).toMatchObject({ method: 'click', selector: '#target' });
  expect(d.traceVersion).toBe(8);
  expect(d.playwrightVersion).toBeTruthy();
  expect(d.cause).toBe('covered-by-overlay');
  expect(d.confidence).toBe('suspected');
  // the diagnosis names the concrete covering element from the real DOM
  expect(d.diagnosed.diagnoses[0]?.detail).toContain('intercepts pointer events');
});

test('should_read_a_real_playwright_test_trace_with_split_members', () => {
  // The real-world input: a @playwright/test `trace: 'on'` archive splits the stream across
  // `test.trace` + `0-trace.trace`, with browser/version fields spread across two context-options
  // events. The reader merges all *.trace members and both context-options.
  const buf = fx('covered-testrunner');
  expect(
    zipEntryNames(buf)
      .filter((n) => n.endsWith('.trace'))
      .sort(),
  ).toEqual(['0-trace.trace', 'test.trace']);
  const d = diagnoseTraceBuffer(buf, 'covered-testrunner.trace.zip');
  expect(d.traceVersion).toBe(8);
  expect(d.browserName).toBe('chromium'); // merged from the second context-options
  expect(d.playwrightVersion).toBeTruthy();
  expect(d.action).toMatchObject({ method: 'click', selector: '#t' });
  expect(d.cause).toBe('covered-by-overlay');
  expect(d.confidence).toBe('suspected');
});

test('should_diagnose_disabled_from_a_real_trace', () => {
  const d = diagnoseTraceBuffer(fx('disabled'));
  expect(d.action).toMatchObject({ method: 'click' });
  expect(d.cause).toBe('disabled');
  expect(d.confidence).toBe('suspected');
});

test('should_never_emit_confirmed_offline_even_when_the_engine_would', () => {
  // LOAD-BEARING clamp (DW-03). Prove the clamp does real work: the SAME reconstructed error,
  // fed to the shared engine directly, yields `confirmed` (an authoritative PW error).
  const info = readTraceZip(fx('covered'));
  const rawLive = diagnose(syntheticDelta(info.chosenFailure!.errorText)).diagnoses;
  expect(rawLive.some((x) => x.confidence === 'confirmed')).toBe(true);

  // …yet through the offline path, NO fixture ever surfaces a `confirmed` — it is reconstructed,
  // not live-probed.
  for (const name of ALL_FIXTURES) {
    const d = diagnoseTraceBuffer(fx(name));
    expect(
      d.diagnosed.diagnoses.every((x) => x.confidence !== 'confirmed'),
      name,
    ).toBe(true);
    expect(d.confidence, name).not.toBe('confirmed');
  }
});

test('should_stay_unsure_for_a_non_actionability_failure', () => {
  const d = diagnoseTraceBuffer(fx('assertion'));
  expect(d.cause).toBe('unsure');
  expect(d.detached).toBe(false);
  expect(d.note).toContain('not a recognized');
  expect(d.diagnosed.diagnoses).toHaveLength(0); // nothing fabricated
});

test('should_flag_detached_and_not_fabricate_a_cause', () => {
  const d = diagnoseTraceBuffer(fx('detached'));
  expect(d.cause).toBe('unsure');
  expect(d.detached).toBe(true);
  expect(d.note).toContain('detached');
  expect(d.diagnosed.diagnoses).toHaveLength(0);
});

test('should_stay_unsure_when_the_locator_never_resolved', () => {
  const d = diagnoseTraceBuffer(fx('unresolved'));
  expect(d.cause).toBe('unsure');
  expect(d.detached).toBe(false);
});

test('should_refuse_an_unsupported_trace_version', () => {
  expect([...SUPPORTED_TRACE_VERSIONS]).toEqual([8]);
  expect(() => diagnoseTraceBuffer(fx('bad-version'))).toThrow(UnsupportedTraceVersionError);
  try {
    diagnoseTraceBuffer(fx('bad-version'));
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(UnsupportedTraceVersionError);
    expect((e as UnsupportedTraceVersionError).version).toBe(99);
    // the message tells the user which versions ARE supported, so they can regenerate
    expect(String((e as Error).message)).toContain('8');
  }
});

test('should_extract_the_concrete_cause_line_without_dumping_the_call_log', () => {
  const covered = readTraceZip(fx('covered')).chosenFailure!;
  expect(covered.causeLine).toContain('intercepts pointer events');
  expect(covered.errorText).not.toContain('Call log'); // not the giant retry dump
  expect(covered.errorText).not.toContain('locator resolved'); // stray-keyword line excluded
  expect(covered.errorText.split('\n').length).toBeLessThan(3);

  // disabled: the cause line names the state; the resolved-<button disabled …> line (which would
  // stray-match the `disabled` keyword) is excluded, so the code comes from the real cause.
  const disabled = readTraceZip(fx('disabled')).chosenFailure!;
  expect(disabled.causeLine).toContain('not enabled');
  expect(disabled.errorText).not.toContain('resolved to');
});

test('should_reject_a_non_trace_or_versionless_file', () => {
  // no context-options ⇒ not a Playwright trace
  expect(() => parseTraceEvents('{"type":"before","callId":"c1","method":"click"}')).toThrow(
    TraceParseError,
  );
  // version guard fires at the parse level too
  expect(() => parseTraceEvents('{"type":"context-options","version":99}')).toThrow(
    UnsupportedTraceVersionError,
  );
});

test('should_tolerate_a_truncated_trailing_line_and_report_no_failure_when_all_passed', () => {
  const passing = [
    '{"type":"context-options","version":8,"playwrightVersion":"1.61.1"}',
    '{"type":"before","callId":"c1","startTime":1,"method":"click","params":{"selector":"#a"}}',
    '{"type":"after","callId":"c1","endTime":2}',
    '{"type":"after","callId":"c2","endTime":3', // truncated / malformed trailing line
  ].join('\n');
  const info = parseTraceEvents(passing); // must not throw on the broken line
  expect(info.actions).toHaveLength(1);
  expect(info.failed).toHaveLength(0);
  expect(info.chosenFailure).toBeNull();

  const d = diagnoseTraceInfo(info);
  expect(d.action).toBeNull();
  expect(d.cause).toBe('unsure');
  expect(d.note).toContain('no failed action');
});

test('should_pick_the_last_failed_action_when_several_failed', () => {
  const events = [
    '{"type":"context-options","version":8}',
    '{"type":"before","callId":"c1","startTime":1,"method":"click","params":{"selector":"#a"}}',
    '{"type":"log","callId":"c1","time":2,"message":"element is not enabled"}',
    '{"type":"after","callId":"c1","endTime":3,"error":{"message":"Timeout 1ms exceeded."}}',
    '{"type":"before","callId":"c2","startTime":4,"method":"click","params":{"selector":"#b"}}',
    '{"type":"log","callId":"c2","time":5,"message":"<div class=\\"g\\"></div> intercepts pointer events"}',
    '{"type":"after","callId":"c2","endTime":6,"error":{"message":"Timeout 1ms exceeded."}}',
  ].join('\n');
  const info = parseTraceEvents(events);
  expect(info.failed).toHaveLength(2);
  expect(info.chosenFailure?.callId).toBe('c2');
  const d = diagnoseTraceInfo(info);
  expect(d.action).toMatchObject({ selector: '#b' });
  expect(d.cause).toBe('covered-by-overlay');
  expect(d.failedCount).toBe(2);
});

test('zip_reader_extracts_members_and_refuses_non_zip_bytes', () => {
  const buf = fx('covered');
  expect(zipEntryNames(buf)).toContain('trace.trace');
  const entry = readZipEntry(buf, 'trace.trace');
  expect(entry).not.toBeNull();
  expect(entry!.toString('utf8')).toContain('"type":"context-options"');
  expect(readZipEntry(buf, 'does-not-exist')).toBeNull();
  expect(() => zipEntryNames(Buffer.from('this is definitely not a zip archive'))).toThrow(
    ZipError,
  );
});

test('cap_confidence_never_upgrades_and_clamps_at_the_ceiling', () => {
  expect(capConfidence('confirmed', 'suspected')).toBe('suspected');
  expect(capConfidence('suspected', 'suspected')).toBe('suspected');
  expect(capConfidence('unknown', 'suspected')).toBe('unknown'); // weaker input untouched
  expect(capConfidence('confirmed', 'confirmed')).toBe('confirmed'); // no-op at ceiling
  expect(capConfidence('suspected', 'confirmed')).toBe('suspected'); // never upgrades
});

test('report_states_the_offline_suspected_only_contract', () => {
  const report = renderTraceReport(diagnoseTraceBuffer(fx('covered'), 'covered.trace.zip'));
  expect(report).toContain('diagnose-trace');
  expect(report).toContain('OFFLINE reconstruction');
  expect(report).toContain('covered-by-overlay (suspected)');
  expect(report).toContain('never `confirmed`');
  // the delta view + diagnostics section both render
  expect(report).toContain('diagnostics:');
});

test('report_never_prints_a_fabricated_verdict_for_an_unsure_failure', () => {
  // The synthetic delta carries a placeholder NOT-actionable verdict for the engine to read; the
  // human report must NOT surface it when no cause was attributed (Playwright never issued it).
  for (const name of ['assertion', 'detached', 'unresolved'] as const) {
    const report = renderTraceReport(diagnoseTraceBuffer(fx(name), `${name}.trace.zip`));
    expect(report, name).toContain('cause: unsure');
    expect(report, name).not.toContain('NOT-actionable');
    expect(report, name).toContain('no root cause reconstructed');
  }
});

test('cause_line_survives_a_trial_run_retry_suffix', () => {
  // Playwright logs `retrying click action (trial run)` / `…, attempt #N`; the boilerplate filter is
  // keyword-anchored so that retry line is stripped and the real cause still wins (recall guard).
  const events = [
    '{"type":"context-options","version":8}',
    '{"type":"before","callId":"c1","startTime":1,"method":"click","params":{"selector":"#x"}}',
    '{"type":"log","callId":"c1","time":2,"message":"<div class=\\"veil\\"></div> intercepts pointer events"}',
    '{"type":"log","callId":"c1","time":3,"message":"retrying click action (trial run)"}',
    '{"type":"log","callId":"c1","time":4,"message":"waiting 500ms"}',
    '{"type":"after","callId":"c1","endTime":5,"error":{"message":"Timeout 1ms exceeded."}}',
  ].join('\n');
  const info = parseTraceEvents(events);
  expect(info.chosenFailure?.causeLine).toContain('intercepts pointer events');
  expect(diagnoseTraceInfo(info).cause).toBe('covered-by-overlay');
});
