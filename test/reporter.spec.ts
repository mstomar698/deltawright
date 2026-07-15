import { test, expect } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  triageFailure,
  renderTriageText,
  DELTA_ATTACHMENT_NAME,
  type Sidecar,
  type TriageInput,
} from '../src/reporter/triage';
import DeltawrightReporter, { attachDiagnosis } from '../src/reporter';
import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { TestInfo } from '@playwright/test';
import type { Delta, DeltaNode } from '../src/index';

// Flake-triage side-car (#55). Exercises the PURE core (browser-free) — exactly the reporter's
// behavior; the Playwright Reporter wrapper only maps TestCase/TestResult onto this + writes files.

function input(over: Partial<TriageInput>): TriageInput {
  return { status: 'failed', title: 'suite > a test', errorMessages: [], attachments: [], ...over };
}

function deltaAttachment(delta: Delta): TriageInput['attachments'] {
  return [
    { name: DELTA_ATTACHMENT_NAME, contentType: 'application/json', body: JSON.stringify(delta) },
  ];
}

function coveredNode(over: Partial<DeltaNode> = {}): DeltaNode {
  return {
    ref: 'e1',
    kind: 'added',
    tag: 'button',
    role: 'button',
    name: 'Submit',
    interactive: true,
    parentRef: null,
    geometry: {
      rect: { x: 10, y: 10, width: 80, height: 30 },
      inViewport: true,
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
      hitSelf: false,
      coveredBy: 'div.overlay',
      offscreen: false,
    },
    actionability: {
      verdict: 'NOT-actionable',
      reason: 'covered-by div.overlay',
      geometryVerdict: 'NOT-actionable',
      playwright: { actionable: false, error: 'covered (intercepted)' },
      agreed: true,
    },
    ...over,
  };
}

test('should_attach_sidecar_only_on_failed_or_timedout_tests_and_never_alter_pass_fail', () => {
  // No side-car for a non-failure outcome (so nothing is attached on green).
  for (const status of ['passed', 'skipped', 'interrupted']) {
    expect(triageFailure(input({ status }))).toBeNull();
  }
  // A side-car for failed / timedOut.
  expect(triageFailure(input({ status: 'failed', errorMessages: ['boom'] }))).not.toBeNull();
  expect(triageFailure(input({ status: 'timedOut', errorMessages: ['boom'] }))).not.toBeNull();

  // Purely a producer of a report object — it returns a fresh side-car and touches no input (a
  // reporter structurally cannot alter pass/fail; the core has no side effects at all).
  const frozen = Object.freeze(input({ status: 'failed', errorMessages: ['x'] }));
  expect(() => triageFailure(frozen)).not.toThrow();
});

test('should_probe_the_failing_locator_with_zero_test_edits', () => {
  // No attachment (zero test edits): the Playwright actionability error alone yields a taxonomy cause
  // via the SAME diagnose() engine.
  const notVisible = triageFailure(
    input({
      errorMessages: ['locator.click: Timeout 5000ms exceeded. ... element is not visible'],
    }),
  )!;
  expect(notVisible.source).toBe('error-text');
  expect(notVisible.cause).toBe('not-visible');

  const disabled = triageFailure(input({ errorMessages: ['element is not enabled'] }))!;
  expect(disabled.cause).toBe('disabled');

  const covered = triageFailure(input({ errorMessages: ['<div> intercepts pointer events'] }))!;
  expect(covered.cause).toBe('covered-by-overlay');
});

test('should_never_fabricate_a_cause_from_a_non_actionability_failure_that_merely_contains_a_keyword', () => {
  // The passive path must NOT substring-match a taxonomy keyword out of an unrelated failure (an
  // assertion diff, an app error, a stack trace). Each of these CONTAINS a taxonomy word but is not a
  // Playwright actionability error → the honest output is `unsure`, never a fabricated confirmed cause.
  const nonActionability = [
    'AssertionError: expected the button to be disabled',
    'Error: the modal is not visible in our app state', // app-domain text, not a PW actionability log
    'TypeError: cannot read property of undefined\n  at requestAnimationFrame (app.js:42)',
    'expect(received).toBe(expected)\n  - covered\n  + uncovered',
    'Error: element hidden behind a feature flag',
    'the value is outside of the expected range',
    'read-only mode is enabled for this account',
  ];
  for (const msg of nonActionability) {
    const s = triageFailure(input({ errorMessages: [msg] }))!;
    expect(s.cause, `"${msg}" must not fabricate a cause`).toBe('unsure');
    expect(s.confidence).toBe('unknown');
    expect(s.detached).toBe(false);
  }
});

test('should_emit_a_taxonomy_labeled_cause_with_confidence_and_output_unsure_below_threshold', () => {
  const s = triageFailure(input({ errorMessages: ['element is not enabled'] }))!;
  expect(s.cause).toBe('disabled');
  expect(s.confidence).toBe('confirmed');

  // A generic failure with no actionability reason → unsure (never fabricated).
  const generic = triageFailure(input({ errorMessages: ['expect(received).toBe(expected)'] }))!;
  expect(generic.cause).toBe('unsure');

  // Threshold: a confirmed cause reported as unsure when the bar is raised past it is impossible, but
  // a suspected cause below a `confirmed` bar → unsure. Feed a delta whose only cause is suspected.
  const suspectedDelta: Delta = {
    action: 'x',
    nodes: [
      coveredNode({
        geometry: {
          rect: { x: 1, y: 1, width: 8, height: 8 },
          inViewport: true,
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          pointerEvents: 'none', // geometry self-cause → pointer-events-none / SUSPECTED
          hitSelf: false,
          coveredBy: 'div.behind',
          offscreen: false,
        },
        actionability: {
          verdict: 'NOT-actionable',
          reason: 'pointer-events:none',
          geometryVerdict: 'NOT-actionable',
          playwright: { actionable: false, error: 'covered (intercepted)' },
          agreed: true,
        },
      }),
    ],
    stats: {
      rawRecords: 1,
      settleMs: 1,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
    },
  };
  const atSuspected = triageFailure(input({ attachments: deltaAttachment(suspectedDelta) }))!;
  expect(atSuspected.cause).toBe('pointer-events-none');
  expect(atSuspected.confidence).toBe('suspected');
  const raised = triageFailure(input({ attachments: deltaAttachment(suspectedDelta) }), {
    minConfidence: 'confirmed',
  })!;
  expect(raised.cause).toBe('unsure'); // suspected < confirmed → unsure
});

test('should_degrade_to_detached_when_the_locator_is_already_gone', () => {
  for (const msg of [
    'locator.fill: Error: element is not attached to the DOM',
    // Playwright's auto-waiting locator retry phrasing — and a LATER "not visible" line in the same
    // log must NOT be mined into a fabricated cause; detached short-circuits it.
    'locator.click: Timeout\n  - waiting for locator\n  - element was detached from the DOM, retrying\n  - element is not visible',
    'Target page, context or browser has been closed',
  ]) {
    const s = triageFailure(input({ status: 'timedOut', errorMessages: [msg] }))!;
    expect(s.detached, msg).toBe(true);
    expect(s.cause, msg).toBe('unsure'); // never fabricate a cause for a gone element
    expect(s.detail).toContain('detached');
  }
});

test('should_carry_late_wave_and_stale_rect_flags', () => {
  const delta: Delta = {
    action: 'x',
    nodes: [coveredNode({ geometry: { ...coveredNode().geometry!, stable: false } })],
    stats: {
      rawRecords: 2,
      settleMs: 130,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
      lateStructural: true,
    },
  };
  const s = triageFailure(input({ attachments: deltaAttachment(delta) }))!;
  expect(s.source).toBe('delta-attachment');
  expect(s.cause).toBe('covered-by-overlay'); // the node cause still surfaces
  expect(s.lateWave).toBe(true);
  expect(s.staleRect).toBe(true);
  // …and they appear in the rendered triage text.
  const text = renderTriageText(s);
  expect(text).toContain('late-wave-suspected');
  expect(text).toContain('stale-rect-suspected');
});

// ── The Reporter WRAPPER (Feature A coverage guarantee + Feature B attachDiagnosis) ──────────────
// These exercise the DeltawrightReporter class against fake Playwright TestCase/TestResult/Suite
// objects (the reporter reads only a tiny slice of each) and a real temp output dir.

function coveredDelta(): Delta {
  return {
    action: 'x',
    nodes: [coveredNode()],
    stats: {
      rawRecords: 1,
      settleMs: 1,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
    },
  };
}

function fakeResult(over: Partial<TestResult> = {}): TestResult {
  return {
    status: 'failed',
    retry: 0,
    errors: [],
    attachments: [],
    ...over,
  } as unknown as TestResult;
}

function fakeTest(over: {
  titlePath: string[];
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: TestResult[];
}): TestCase {
  return {
    titlePath: () => over.titlePath,
    outcome: () => over.outcome,
    results: over.results,
  } as unknown as TestCase;
}

/** Drive the reporter over a suite + a set of onTestEnd calls; return the resolved output dir. */
function drive(opts: {
  suiteTests: TestCase[];
  ended?: Array<{ test: TestCase; result: TestResult }>;
}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'dw-rep-'));
  const reporter = new DeltawrightReporter({ outputDir: 'out' });
  reporter.onBegin(
    { rootDir: root } as unknown as FullConfig,
    {
      allTests: () => opts.suiteTests,
    } as unknown as Suite,
  );
  for (const e of opts.ended ?? []) reporter.onTestEnd(e.test, e.result);
  reporter.onEnd();
  return resolve(root, 'out');
}

function sidecars(dir: string): Sidecar[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.deltawright-sidecar.json'));
  } catch {
    return []; // dir never created → no side-cars
  }
  return files.map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Sidecar);
}

test('an interrupted-only test (outcome skipped) writes NO side-car and never crashes', () => {
  // REAL Playwright semantics (computeTestCaseOutcome): interrupted=1, expected=0, unexpected=0 →
  // outcome() === 'skipped'. An interrupted-ONLY test is therefore NOT finally-failed — it must write
  // NOTHING (neither the passive path nor the sweep covers it) and must not crash the run.
  const t = fakeTest({
    titlePath: ['suite', 'interrupted one'],
    outcome: 'skipped',
    results: [fakeResult({ status: 'interrupted' })],
  });
  const dir = drive({
    suiteTests: [t],
    ended: [{ test: t, result: fakeResult({ status: 'interrupted' }) }],
  });
  expect(sidecars(dir)).toHaveLength(0); // not finally-failed → no side-car, no false record
});

test('a passing test.fail() (outcome unexpected, last result passed) writes NO side-car', () => {
  // A `test.fail()`-annotated test that PASSES: result.status === 'passed' but outcome() ===
  // 'unexpected' (passed !== expectedStatus 'failed'). The sweep's last.status gate excludes it — its
  // final result is a PASS, not a failure — so no false failure side-car is written.
  const t = fakeTest({
    titlePath: ['suite', 'expected-to-fail but passed'],
    outcome: 'unexpected',
    results: [fakeResult({ status: 'passed' })],
  });
  const dir = drive({ suiteTests: [t] }); // no onTestEnd (a passing result is never failed/timedOut)
  expect(sidecars(dir)).toHaveLength(0); // passing test.fail() → no false failure record
});

test('a [failed, interrupted] retry keeps attempt-0 REAL diagnosis (never clobbered to unsure)', () => {
  // Regression pin: attempt 0 fails with a diagnosable actionability error; attempt 1 is interrupted.
  // outcome() === 'unexpected'. The later interrupted attempt must NOT overwrite the real attempt-0
  // diagnosis in `pending`, and the sweep must skip the test (already written) — so the one side-car
  // written carries the REAL cause, not a fabricated `unsure`.
  const attempt0 = fakeResult({
    status: 'failed',
    errors: [{ message: 'element is not enabled' }] as TestResult['errors'],
  });
  const attempt1 = fakeResult({ status: 'interrupted', retry: 1 });
  const t = fakeTest({
    titlePath: ['suite', 'failed-then-interrupted'],
    outcome: 'unexpected',
    results: [attempt0, attempt1],
  });
  const dir = drive({
    suiteTests: [t],
    ended: [
      { test: t, result: attempt0 },
      { test: t, result: attempt1 }, // the later interrupted attempt must NOT clobber attempt 0
    ],
  });
  const out = sidecars(dir);
  expect(out).toHaveLength(1);
  expect(out[0]!.cause).toBe('disabled'); // the REAL attempt-0 cause preserved, not fabricated unsure
  expect(out[0]!.status).toBe('failed');
});

test('onEnd sweeps the tree so a hook/fixture failure the passive path missed still gets a coverage side-car', () => {
  // A test that failed in a beforeAll hook never produces a failed/timedOut onTestEnd, but its
  // outcome() is 'unexpected' and it carries a last result — the sweep must cover it.
  const missed = fakeTest({
    titlePath: ['suite', 'hook-failed'],
    outcome: 'unexpected',
    results: [fakeResult({ status: 'failed' })],
  });
  const dir = drive({ suiteTests: [missed] }); // NOTE: no onTestEnd for it (the passive path missed it)
  const out = sidecars(dir);
  expect(out).toHaveLength(1);
  expect(out[0]!.cause).toBe('unsure');
  expect(out[0]!.detail).toContain('hook/fixture'); // the truthful coverage detail
});

test('a flaky-then-passed test writes NOTHING', () => {
  const flaky = fakeTest({
    titlePath: ['suite', 'flaky'],
    outcome: 'flaky', // failed attempt 0, passed on retry → finally green
    results: [fakeResult({ status: 'failed' }), fakeResult({ status: 'passed', retry: 1 })],
  });
  const dir = drive({
    suiteTests: [flaky],
    ended: [{ test: flaky, result: fakeResult({ status: 'failed' }) }],
  });
  expect(sidecars(dir)).toHaveLength(0); // no failure record for a finally-green test
});

test('the coverage sweep guarantees exactly one side-car per finally-failed (unexpected) test', () => {
  // A diagnosable failure (passive path), a hook failure the passive path missed, a flaky-then-passed
  // test, and a passing test. Coverage count must equal the number of `unexpected` tests (2).
  const diagnosable = fakeTest({
    titlePath: ['suite', 'disabled-button'],
    outcome: 'unexpected',
    results: [
      fakeResult({
        status: 'failed',
        errors: [{ message: 'element is not enabled' }] as TestResult['errors'],
      }),
    ],
  });
  const missedHook = fakeTest({
    titlePath: ['suite', 'hook-failed'],
    outcome: 'unexpected',
    results: [fakeResult({ status: 'failed' })],
  });
  const flaky = fakeTest({
    titlePath: ['suite', 'flaky'],
    outcome: 'flaky',
    results: [fakeResult({ status: 'failed' }), fakeResult({ status: 'passed', retry: 1 })],
  });
  const passing = fakeTest({
    titlePath: ['suite', 'green'],
    outcome: 'expected',
    results: [fakeResult({ status: 'passed' })],
  });
  const suiteTests = [diagnosable, missedHook, flaky, passing];

  const dir = drive({
    suiteTests,
    ended: [
      { test: diagnosable, result: diagnosable.results[0]! },
      { test: flaky, result: flaky.results[0]! },
    ],
  });
  const out = sidecars(dir);
  const unexpected = suiteTests.filter((t) => t.outcome() === 'unexpected').length;
  expect(out).toHaveLength(unexpected); // 80/80 in the real run → here 2/2
  expect(out).toHaveLength(2);
  // The diagnosable one carries a real cause; the missed hook one is an honest unsure coverage record.
  const byTest = new Map(out.map((s) => [s.test, s]));
  expect(byTest.get('suite > disabled-button')!.cause).toBe('disabled');
  expect(byTest.get('suite > hook-failed')!.cause).toBe('unsure');
});

test('attachDiagnosis emits the machine delta AND a readable triage attachment naming the cause', async () => {
  const calls: Array<{ name: string; contentType?: string; body: string }> = [];
  const testInfo = {
    title: 'a test',
    titlePath: ['suite', 'a test'],
    attach: (name: string, opts: { body?: Buffer | string; contentType?: string }) => {
      calls.push({ name, contentType: opts.contentType, body: String(opts.body) });
      return Promise.resolve();
    },
  } as unknown as TestInfo;

  await attachDiagnosis(testInfo, coveredDelta());

  // (1) the machine delta — so the reporter's rich mode still fires.
  const machine = calls.find((c) => c.name === DELTA_ATTACHMENT_NAME);
  expect(machine).toBeTruthy();
  expect(machine!.contentType).toBe('application/json');
  expect((JSON.parse(machine!.body) as Delta).action).toBe('x');

  // (2) a SECOND human-readable triage attachment whose body names the diagnosed cause.
  const triage = calls.find((c) => c.name === 'deltawright-triage');
  expect(triage).toBeTruthy();
  expect(triage!.contentType).toMatch(/^text\//);
  expect(triage!.body).toContain('covered-by-overlay'); // the delta's cause, rendered readably
});
