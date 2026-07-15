// Deltawright flake-triage side-car reporter (#55) — `deltawright/reporter`.
//
// A ZERO-EDIT on-ramp: add one line to playwright.config.ts and every FAILED / TIMED-OUT test gets a
// taxonomy-labeled triage side-car, with no per-test changes:
//
//   // playwright.config.ts
//   reporter: [['list'], ['deltawright/reporter', { outputDir: 'deltawright-triage' }]],
//
// It writes `<test>.deltawright-sidecar.json` + `<test>.triage.txt` per failure, NEVER on a passing
// test, and NEVER alters pass/fail. The cause comes from the ONE diagnose() engine (so it hard-gates
// on the #52 accuracy harness): a `deltawright-delta` attachment is diagnosed richly (carrying
// late-wave / stale-rect); otherwise the Playwright actionability error is diagnosed passively. A
// locator that never resolved degrades to `unsure` + detached — it never fabricates a cause.
//
// RICH mode is opt-in and requires a test edit: attach a real delta with `attachDelta(testInfo,
// delta)` (or `testInfo.attach('deltawright-delta', ...)`). The zero-edit claim is for the passive
// path only.
//
// TWO ON-RAMPS: the zero-edit reporter writes side-cars BESIDE the Playwright report (a separate dir
// the aggregator reads). `attachDiagnosis(testInfo, delta)` is the opt-in one-liner that puts DW
// INSIDE the report — it attaches the machine delta AND a human-readable triage attachment, so the
// standard Playwright HTML report shows DW's diagnosis inline per test.
//
// COVERAGE GUARANTEE: onEnd sweeps the whole test tree and writes a minimal `unsure` side-car for
// every finally-failed test (`outcome() === 'unexpected'`) whose FINAL result genuinely failed but
// the passive path could not diagnose — e.g. a failure raised in a beforeAll/afterAll hook or a
// fixture (which never surfaces as a per-test `failed`/`timedOut` result). An interrupted-ONLY test
// has `outcome() === 'skipped'` (NOT finally-failed) and is correctly NOT covered. So there is one
// side-car per finally-failed test — never a silent gap, and never a false failure record.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { TestInfo } from '@playwright/test';
import type { Delta } from '../host/types';
import {
  DELTA_ATTACHMENT_NAME,
  renderTriageText,
  triageFailure,
  type Sidecar,
  type TriageOptions,
} from './triage';

export {
  triageFailure,
  renderTriageText,
  DELTA_ATTACHMENT_NAME,
  type Sidecar,
  type TriageInput,
  type TriageOptions,
} from './triage';

export interface DeltawrightReporterOptions extends TriageOptions {
  /** Dir (relative to the Playwright rootDir) for the side-cars. Default `deltawright-triage`. */
  outputDir?: string;
}

/** Filesystem-safe id from a test's title path. */
function sanitize(title: string): string {
  return title.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
}

/**
 * Attach a real Delta so the reporter diagnoses it RICHLY (rich mode, opt-in — this is a test edit).
 * With `lateWatchMs` / `rectRecheckMs` set on the `actAndObserve` that produced the delta, the
 * side-car then carries the late-wave / stale-rect flags.
 */
export async function attachDelta(testInfo: TestInfo, delta: Delta): Promise<void> {
  await testInfo.attach(DELTA_ATTACHMENT_NAME, {
    body: JSON.stringify(delta),
    contentType: 'application/json',
  });
}

/** The readable-diagnosis attachment name — rendered inline per test in the Playwright HTML report. */
export const TRIAGE_ATTACHMENT_NAME = 'deltawright-triage';

/**
 * RICH mode, opt-in one-liner that puts DW INSIDE the Playwright report. It emits TWO attachments:
 *   1. the machine `deltawright-delta` (identical to `attachDelta`, so the reporter's rich side-car
 *      path still fires and carries the late-wave / stale-rect flags), AND
 *   2. a human-readable `deltawright-triage` (`text/plain`) — the delta diagnosed RIGHT NOW through
 *      the SAME `triageFailure` engine the side-car uses, so the inline text can never drift from the
 *      side-car — which the standard Playwright HTML report renders inline per test.
 * `attachDelta` stays unchanged for back-compat; this is the readable superset.
 */
export async function attachDiagnosis(testInfo: TestInfo, delta: Delta): Promise<void> {
  const body = JSON.stringify(delta);
  // 1) the machine delta — keeps the reporter's rich mode working exactly as `attachDelta`.
  await testInfo.attach(DELTA_ATTACHMENT_NAME, { body, contentType: 'application/json' });
  // 2) diagnose it now (reusing the one engine) and attach the readable triage inline.
  const title = (testInfo.titlePath ?? [testInfo.title]).filter(Boolean).join(' > ');
  const sidecar = triageFailure({
    status: 'failed',
    title,
    errorMessages: [],
    attachments: [{ name: DELTA_ATTACHMENT_NAME, contentType: 'application/json', body }],
  });
  if (sidecar) {
    await testInfo.attach(TRIAGE_ATTACHMENT_NAME, {
      body: renderTriageText(sidecar),
      contentType: 'text/plain',
    });
  }
}

/**
 * A minimal COVERAGE side-car for a finally-failed test the passive path could not diagnose — an
 * `interrupted` result, or a failure raised in a beforeAll/afterAll hook or a fixture (which never
 * surfaces as a `failed`/`timedOut` test result). It honestly records the failure as `unsure` (DW
 * couldn't infer a cause, but the failure is not dropped). Same shape a below-threshold passive
 * triage produces, so the aggregator treats it identically.
 */
function coverageSidecar(title: string, status: string): Sidecar {
  return {
    test: title,
    status,
    source: 'error-text',
    cause: 'unsure',
    confidence: 'unknown',
    detail:
      'test failed but produced no diagnosable Playwright actionability signal (e.g. interrupted, ' +
      'or a hook/fixture failure) — no cause inferred',
    detached: false,
    lateWave: false,
    staleRect: false,
    diagnoses: [],
  };
}

/** The Playwright Reporter. Passive (zero-edit): writes a triage side-car for each failed test. */
export default class DeltawrightReporter implements Reporter {
  private readonly opts: DeltawrightReporterOptions;
  private outDir = 'deltawright-triage';
  // The latest failed attempt per test; flushed in onEnd so a flaky-then-PASSED test writes no
  // (stale) failure side-car — only a test whose FINAL outcome is a real failure does.
  private readonly pending = new Map<TestCase, { result: TestResult; sidecar: Sidecar }>();
  // The run's root suite, captured in onBegin — its `allTests()` is the coverage sweep's source.
  private rootSuite: Suite | undefined;

  constructor(options: DeltawrightReporterOptions = {}) {
    this.opts = options;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    const dir = this.opts.outputDir ?? 'deltawright-triage';
    this.outDir = resolve(config.rootDir, dir);
    this.rootSuite = suite;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Passive path: only a real failure STATUS is diagnosable here. `interrupted` carries no
    // actionability signal and, on a `[failed, interrupted]` retry, arrives AFTER the real failure —
    // so it is deliberately NOT handled here (it must not clobber the earlier real diagnosis). The
    // onEnd coverage sweep is the backstop for any finally-failed test this path never sees.
    if (result.status !== 'failed' && result.status !== 'timedOut') return; // never on pass/skip/interrupted
    // The whole triage computation is guarded — a triage side-car is best-effort observability and
    // must NEVER break the run (fulfilling the never-break guarantee for the core, not just writes).
    try {
      const title = test.titlePath().filter(Boolean).join(' > ');
      const sidecar = triageFailure(
        {
          status: result.status,
          title,
          errorMessages: result.errors.map((e) => e.message ?? '').filter(Boolean),
          attachments: result.attachments.map((a) => ({
            name: a.name,
            contentType: a.contentType,
            body: a.body,
          })),
        },
        { minConfidence: this.opts.minConfidence },
      );
      // Set `pending` ONLY when triage returns a real side-car. A failed/timedOut always yields one
      // (never null after the status check), so this preserves the pre-PR guarantee: a real diagnosis
      // from an earlier attempt is retained and can never be clobbered by a later interrupted attempt.
      if (sidecar) this.pending.set(test, { result, sidecar });
    } catch {
      // never let triage break the run
    }
  }

  onEnd(): void {
    const written = new Set<TestCase>();
    for (const [test, { result, sidecar }] of this.pending) {
      // Only a test whose FINAL outcome is a real failure gets a side-car; a flaky test that passed
      // on retry (`flaky`) is ultimately green, so it leaves no failure record.
      if (test.outcome() !== 'unexpected') continue;
      this.write(test, result, sidecar);
      written.add(test);
    }

    // COVERAGE SWEEP (the backstop): a GENUINELY finally-failed test the passive failed/timedOut path
    // never diagnosed — e.g. a beforeAll/afterAll hook or fixture failure that never surfaces as a
    // per-test `failed`/`timedOut` result. Two gates keep it honest: (1) `outcome() === 'unexpected'`
    // (excludes flaky-then-passed and interrupted-ONLY, whose outcome is 'skipped'), and (2) the FINAL
    // result must ITSELF be a real failure status — which EXCLUDES a passing `test.fail()` (last
    // status 'passed', outcome 'unexpected') so no false failure record is written. A `[failed,
    // interrupted]` retry is already in `written` from attempt-0's real diagnosis → skipped → its real
    // cause is preserved. Guarded so it can never break the run.
    try {
      for (const test of this.rootSuite?.allTests() ?? []) {
        if (test.outcome() !== 'unexpected') continue; // flaky-then-passed / expected / interrupted-only → nothing
        const last = test.results.at(-1);
        if (
          !last ||
          (last.status !== 'failed' && last.status !== 'timedOut' && last.status !== 'interrupted')
        )
          continue; // final result not a real failure (e.g. a passing test.fail()) → no false record
        if (written.has(test)) continue; // already diagnosed above — never double-write, preserve real cause
        const title = test.titlePath().filter(Boolean).join(' > ');
        this.write(test, last, coverageSidecar(title, last.status));
        written.add(test);
      }
    } catch {
      // best-effort coverage — never let it break the run
    }
  }

  private write(test: TestCase, result: TestResult, sidecar: Sidecar): void {
    try {
      mkdirSync(this.outDir, { recursive: true });
      const path = test.titlePath().filter(Boolean).join('-');
      // A short hash of the full title path disambiguates two tests whose names differ only in
      // characters `sanitize` strips (so they can't overwrite each other).
      const hash = createHash('sha1').update(test.titlePath().join(' ')).digest('hex').slice(0, 8);
      const base = `${sanitize(path)}-${hash}-r${result.retry}`;
      writeFileSync(
        resolve(this.outDir, `${base}.deltawright-sidecar.json`),
        JSON.stringify(sidecar, null, 2) + '\n',
      );
      writeFileSync(resolve(this.outDir, `${base}.triage.txt`), renderTriageText(sidecar) + '\n');
    } catch {
      // A triage side-car is best-effort observability — never let it break the run.
    }
  }
}
