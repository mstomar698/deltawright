import { test, expect } from '@playwright/test';
import { parseTraceEvents } from '../src/trace/read-trace';
import { deriveRouting, MAX_SIGNALS } from '../src/trace/routing';
import { diagnoseTraceInfo, renderTraceReport } from '../src/trace/diagnose-trace';

// Move 2 — honest ownership-routing (offline arm). The trace's OWN in-page console/pageError events
// are correlated to the failing action's window and surfaced as ROUTING signals: co-occurrence, never
// causation (DW-03). Only an uncaught pageError flips the `suspectedNotDomCause` hint; a console.error
// is context, never a verdict. The section is additive — a clean trace's report is byte-unchanged.

const CTX = '{"type":"context-options","version":8}';
const before = (id: string, t: number, method = 'click', sel = '#x') =>
  `{"type":"before","callId":"${id}","startTime":${t},"method":"${method}","params":{"selector":"${sel}"}}`;
const after = (id: string, t: number, msg: string) =>
  `{"type":"after","callId":"${id}","endTime":${t},"error":{"message":${JSON.stringify(msg)}}}`;
const pageError = (t: number, msg: string) =>
  `{"type":"event","time":${t},"class":"BrowserContext","method":"pageError","params":{"error":{"error":{"message":${JSON.stringify(msg)}}}}}`;
const consoleErr = (t: number, text: string) =>
  `{"type":"console","messageType":"error","text":${JSON.stringify(text)},"time":${t}}`;
const consoleWarn = (t: number, text: string) =>
  `{"type":"console","messageType":"warning","text":${JSON.stringify(text)},"time":${t}}`;

const stdout = (text: string) =>
  `{"type":"stdout","text":${JSON.stringify(text)},"timestamp":"2026-01-01T00:00:00.000Z"}`;
const stderr = (text: string) =>
  `{"type":"stderr","text":${JSON.stringify(text)},"timestamp":"2026-01-01T00:00:00.000Z"}`;

// A non-actionability failure (an assertion) → Deltawright stays `unsure` → domCauseNamed=false.
const ASSERT_FAIL = 'expect(locator).toBeVisible() failed: Timeout 500ms exceeded';

test('a co-occurring pageError with no DOM cause flips suspectedNotDomCause', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      pageError(150, 'TypeError: cannot read total of undefined'),
      consoleErr(160, 'batch 7 failed to load'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.cause).toBe('unsure'); // an assertion is not an actionability cause
  expect(d.routing.suspectedNotDomCause).toBe(true);
  expect(d.routing.pageErrorCount).toBe(1);
  expect(d.routing.signals.map((s) => s.kind)).toContain('pageerror');
  expect(d.routing.recommendation).toContain('not-a-DOM-cause');

  const report = renderTraceReport(d);
  expect(report).toContain('Co-occurring in-page signals');
  expect(report).toContain('TypeError: cannot read total of undefined');
  expect(report).toMatch(/routing: SUSPECTED not-a-DOM-cause/);
});

test('a named DOM cause suppresses the hint — co-events become context, not a route', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 10),
      '{"type":"log","callId":"c1","time":12,"message":"<div class=\\"veil\\"></div> intercepts pointer events"}',
      pageError(15, 'TypeError: unrelated widget error'),
      after('c1', 90, 'Timeout 1ms exceeded.'),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.cause).toBe('covered-by-overlay'); // Deltawright named its own class
  expect(d.routing.suspectedNotDomCause).toBe(false); // so the JS error is NOT a route-elsewhere hint
  expect(d.routing.signals.map((s) => s.kind)).toContain('pageerror'); // but still listed as context
  expect(d.routing.recommendation).toBe('');
});

test('console errors alone never flip the hint (never upgrade a console.error to a verdict)', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      consoleErr(120, 'deprecated api'),
      consoleWarn(130, 'slow response'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.pageErrorCount).toBe(0);
  expect(r.suspectedNotDomCause).toBe(false);
  expect(r.recommendation).toBe('');
  expect(r.signals).toHaveLength(2); // still surfaced as context
});

test('only co-events within the failing action window are correlated', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      pageError(50, 'BEFORE the window — must be excluded'),
      pageError(300, 'INSIDE the window'),
      pageError(9000, 'AFTER the window — must be excluded'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.windowCount).toBe(1);
  expect(r.signals).toHaveLength(1);
  expect(r.signals[0]!.text).toContain('INSIDE');
});

test('signals are capped and the true in-window count is reported (list-and-clamp)', () => {
  const noise = Array.from({ length: MAX_SIGNALS + 5 }, (_, i) => consoleErr(200 + i, `err ${i}`));
  const info = parseTraceEvents(
    [CTX, before('c1', 100, 'expect'), ...noise, after('c1', 600, ASSERT_FAIL)].join('\n'),
  );
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.windowCount).toBe(MAX_SIGNALS + 5);
  expect(r.signals).toHaveLength(MAX_SIGNALS);
  expect(renderTraceReport(diagnoseTraceInfo(info))).toContain('more (capped)');
});

test('an unbounded window (terminal action, no endTime) never flips the hint', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      // a FAILED 'after' with no endTime, and c1 is the last action → the right edge is unbounded.
      `{"type":"after","callId":"c1","error":{"message":${JSON.stringify(ASSERT_FAIL)}}}`,
      pageError(5000, 'a much later, unrelated exception'),
    ].join('\n'),
  );
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.pageErrorCount).toBe(1); // still listed as context
  expect(r.suspectedNotDomCause).toBe(false); // but never flips on an open-ended window
  expect(r.recommendation).toBe('');
});

test('when endTime is absent, the right edge falls back to the next action start', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      `{"type":"after","callId":"c1","error":{"message":${JSON.stringify(ASSERT_FAIL)}}}`, // failed, no endTime
      before('c2', 200, 'click', '#next'),
      pageError(150, 'INSIDE the c1 window'),
      pageError(300, 'AFTER c2 started — out of the c1 window'),
      '{"type":"after","callId":"c2","endTime":400}', // c2 succeeds → chosen failure stays c1
    ].join('\n'),
  );
  expect(info.chosenFailure?.callId).toBe('c1');
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.windowCount).toBe(1); // only the t=150 event; t=300 is past c2's start (200)
  expect(r.signals[0]!.text).toContain('INSIDE');
  expect(r.suspectedNotDomCause).toBe(true); // bounded by the next action start → may flip
});

test('the pageError that drives the recommendation is always shown (prioritized past the cap)', () => {
  const noise = Array.from({ length: MAX_SIGNALS }, (_, i) => consoleErr(200 + i, `warn ${i}`));
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      ...noise, // MAX_SIGNALS console errors, all EARLIER in time than the pageError
      pageError(300, 'THE pageError that flipped the hint'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const r = deriveRouting(info, { domCauseNamed: false });
  expect(r.suspectedNotDomCause).toBe(true);
  expect(r.signals).toHaveLength(MAX_SIGNALS);
  expect(r.signals.some((s) => s.kind === 'pageerror')).toBe(true); // never sliced out
  expect(r.signals.map((s) => s.text).join(' ')).toContain('THE pageError');
});

// --- Move 2 harness arm: backend/infra errors from the test-runner's own stdout/stderr ------------

test('a backend error in harness stderr flips suspectedBackendCause and routes to backend', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      stderr('POST /api/submit responded with a status of 504 (Gateway Timeout)'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.cause).toBe('unsure');
  expect(d.routing.suspectedBackendCause).toBe(true);
  expect(d.routing.harnessSignals[0]!.bucket).toBe('5xx/gateway');
  expect(d.routing.recommendation).toContain('BACKEND');
  const report = renderTraceReport(d);
  expect(report).toContain('Backend/infra errors logged by the test-runner');
  expect(report).toContain('504');
});

test('a named DOM cause suppresses the backend hint (harness error becomes context)', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 10),
      '{"type":"log","callId":"c1","time":12,"message":"<div class=\\"veil\\"></div> intercepts pointer events"}',
      stderr('GET /api/data responded with a status of 503'),
      after('c1', 90, 'Timeout 1ms exceeded.'),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.cause).toBe('covered-by-overlay');
  expect(d.routing.suspectedBackendCause).toBe(false); // DW named its own class → not a route
  expect(d.routing.harnessSignals.length).toBeGreaterThan(0); // still listed as context
});

test('a backend-only trace (no in-page co-events) still routes to backend', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      stdout('ESB doc-gen call failed: ECONNREFUSED'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.routing.signals).toHaveLength(0); // no in-page co-events at all
  expect(d.routing.suspectedBackendCause).toBe(true);
  expect(d.routing.harnessSignals[0]!.bucket).toBe('conn/network');
});

test("the failure's own timeout in stderr is NOT a backend signal (no circular self-match)", () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      stderr('TimeoutError: Timeout 120000ms exceeded while waiting for the element'),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.routing.harnessSignals).toHaveLength(0); // a bare timeout is the failure, not a backend fault
  expect(d.routing.suspectedBackendCause).toBe(false);
});

test('repeated backend error lines are deduped', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 100, 'expect'),
      ...Array.from({ length: 5 }, () => stderr('responded with a status of 502')),
      after('c1', 600, ASSERT_FAIL),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.routing.harnessSignals).toHaveLength(1); // 5 identical lines → 1 distinct signal
});

test('benign numeric log lines are NOT matched (precision — no manufactured backend routes)', () => {
  const benign = [
    'at handler (/srv/app.js:504:12)', // stack frame line:column
    'API latency: 503 ms', // latency
    'GET /health took 429 ms', // latency
    'processed 500 records', // count
    'order #502 completed', // id
    'clicking at (500, 240)', // coordinate
    'Expected: 504', // a FAILED assertion's literal — the test failed because backend did NOT return 504
    'app version 5.0.4', // version
  ];
  for (const line of benign) {
    const info = parseTraceEvents(
      [CTX, before('c1', 100, 'expect'), stderr(line), after('c1', 600, ASSERT_FAIL)].join('\n'),
    );
    const r = diagnoseTraceInfo(info).routing;
    expect(r.harnessSignals, `"${line}" must NOT match`).toHaveLength(0);
    expect(r.suspectedBackendCause).toBe(false);
  }
});

test('real backend forms still match with the right bucket (recall + classification)', () => {
  const real: Array<[string, string]> = [
    ['status 504', '5xx/gateway'],
    ['HTTP 500', '5xx/gateway'],
    ['504 Gateway Timeout', '5xx/gateway'],
    ['HTTP/1.1 503 Service Unavailable', '5xx/gateway'],
    ['Internal Server Error', '5xx/gateway'],
    ['HTTP/1.1 511 Network Authentication Required', '5xx/gateway'], // 5xx outside {500,502,503,504}
    ['responded with a status of 429', '4xx'],
    ['status code: 404', '4xx'],
    ['ECONNREFUSED connecting to db', 'conn/network'],
  ];
  for (const [line, bucket] of real) {
    const info = parseTraceEvents(
      [CTX, before('c1', 100, 'expect'), stderr(line), after('c1', 600, ASSERT_FAIL)].join('\n'),
    );
    const r = diagnoseTraceInfo(info).routing;
    expect(r.harnessSignals.length, `"${line}" must match`).toBeGreaterThan(0);
    expect(r.harnessSignals[0]!.bucket, `"${line}" bucket`).toBe(bucket);
  }
});

test('a clean trace (no co-events) renders no routing section — byte-unchanged', () => {
  const info = parseTraceEvents(
    [
      CTX,
      before('c1', 10),
      '{"type":"log","callId":"c1","time":12,"message":"<div class=\\"veil\\"></div> intercepts pointer events"}',
      after('c1', 90, 'Timeout 1ms exceeded.'),
    ].join('\n'),
  );
  const d = diagnoseTraceInfo(info);
  expect(d.routing.signals).toHaveLength(0);
  const report = renderTraceReport(d);
  expect(report).not.toContain('Co-occurring');
  expect(report).not.toContain('routing:');
});
