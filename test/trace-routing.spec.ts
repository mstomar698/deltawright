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
