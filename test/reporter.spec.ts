import { test, expect } from '@playwright/test';
import {
  triageFailure,
  renderTriageText,
  DELTA_ATTACHMENT_NAME,
  type TriageInput,
} from '../src/reporter/triage';
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
