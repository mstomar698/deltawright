import { test, expect } from '@playwright/test';
import { parseTraceEvents } from '../src/trace/read-trace';
import { deriveInputIntegrity } from '../src/trace/input-integrity';
import { diagnoseTraceInfo, renderTraceReport } from '../src/trace/diagnose-trace';

// v0.9 Move 1 — the OFFLINE input-integrity arm (#81). These tests pin the trace-only contract with
// SYNTHETIC, hand-authored v8 traces (the exact event shapes — context-options / before / after /
// frame-snapshot — captured from real traces): a value action's `params.value` vs the target field's
// `__playwright_value_` in the `after@<callId>` snapshot, classified by the SHARED `classifyInput`, is
// emitted as a `suspected input-not-committed` finding ONLY on a genuine loss — never on a clean value,
// a mask, or an unresolvable field (honest silence, not a guess). No PII, no external identifiers.

/** Serialize an array of event objects to trace JSONL. */
const jsonl = (events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n');

/** A serialized `<input>` snapshot node with the given attributes. */
const inputNode = (attrs: Record<string, string>): unknown => ['INPUT', attrs];

/** A `frame-snapshot` event whose serialized DOM is `<html><body>…inputs…</body></html>`. */
const snapshotEvent = (snapshotName: string, callId: string, inputs: unknown[]): object => ({
  type: 'frame-snapshot',
  snapshot: { snapshotName, callId, html: ['HTML', {}, ['BODY', {}, ...inputs]] },
});

/**
 * A minimal fill-then-snapshot trace: a value action (`c1`) plus one `after@c1` snapshot showing the
 * target input's committed value (stamped `__playwright_target__` + `id`). Everything is overridable so
 * each test crafts exactly one condition.
 */
function fillTrace(opts: {
  method?: string;
  selector?: string;
  intended?: string;
  valueParam?: 'value' | 'text';
  committed?: string; // omit → no value node at all
  snapshotName?: string; // omit → after@c1
  stampTarget?: boolean; // stamp __playwright_target__ (default true)
  id?: string;
  name?: string;
  extraInputs?: unknown[]; // additional sibling inputs
  bodyOverride?: unknown[]; // replace the whole <body> children (e.g. a reference node)
  failError?: string; // make the action fail with this terse error
}): string {
  const {
    method = 'fill',
    selector = '#user',
    intended = 'acetaminophen',
    valueParam = 'value',
    committed,
    snapshotName = 'after@c1',
    stampTarget = true,
    id = 'user',
    name,
    extraInputs = [],
    bodyOverride,
    failError,
  } = opts;

  const events: object[] = [
    { type: 'context-options', version: 8, playwrightVersion: '1.61.1', browserName: 'chromium' },
    {
      type: 'before',
      callId: 'c1',
      startTime: 1,
      method,
      params: { selector, [valueParam]: intended },
    },
    failError
      ? { type: 'after', callId: 'c1', endTime: 2, error: { message: failError } }
      : { type: 'after', callId: 'c1', endTime: 2 },
  ];

  if (committed !== undefined || bodyOverride) {
    const attrs: Record<string, string> = { id, __playwright_value_: committed ?? '' };
    if (name) attrs.name = name;
    if (stampTarget) attrs.__playwright_target__ = '';
    const inputs = bodyOverride ?? [inputNode(attrs), ...extraInputs];
    events.push({
      type: 'frame-snapshot',
      snapshot: { snapshotName, callId: 'c1', html: ['HTML', {}, ['BODY', {}, ...inputs]] },
    });
  }
  return jsonl(events);
}

const findingsOf = (trace: string) => deriveInputIntegrity(parseTraceEvents(trace));

// --- The loss shapes flag (the core capability) -------------------------------------------------

test('flags a dropped-keystrokes fill as suspected input-not-committed (dropped)', () => {
  // typed "acetaminophen", the field committed "aeaiohn" — a non-prefix subsequence, letters dropped.
  const f = findingsOf(fillTrace({ intended: 'acetaminophen', committed: 'aeaiohn' }));
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ callId: 'c1', method: 'fill', selector: '#user', shape: 'dropped' });
  expect(f[0]!.intendedLen).toBe(13);
  expect(f[0]!.committedLen).toBe(7);
});

test('flags a deferred truncate as suspected input-not-committed (truncated)', () => {
  const f = findingsOf(fillTrace({ intended: 'acetaminophen', committed: 'acetamin' }));
  expect(f).toHaveLength(1);
  expect(f[0]!.shape).toBe('truncated');
  expect(f[0]!.committedLen).toBe(8);
});

test('flags a cleared field as suspected input-not-committed (never-committed)', () => {
  const f = findingsOf(fillTrace({ intended: 'acetaminophen', committed: '' }));
  expect(f).toHaveLength(1);
  expect(f[0]!.shape).toBe('never-committed');
  expect(f[0]!.committedLen).toBe(0);
});

// --- No false positives (the make-or-break guards) ----------------------------------------------

test('does NOT flag a clean fill (committed == intended)', () => {
  expect(findingsOf(fillTrace({ intended: 'acetaminophen', committed: 'acetaminophen' }))).toEqual(
    [],
  );
});

test('does NOT flag a case/reorder mask — a transform, not a loss', () => {
  // committed is uppercase — not a subsequence at all → `transformed`, deliberately unflagged (DW-03).
  expect(findingsOf(fillTrace({ intended: 'acetaminophen', committed: 'ACETAMINOPHEN' }))).toEqual(
    [],
  );
});

test('does NOT flag a subtractive separator mask (a card field stripping spaces)', () => {
  // "4111 1111 1111 1111" → "4111111111111111" IS a shorter subsequence but only whitespace was
  // removed — a mask, not character loss. Mirrors the live arm's false-positive guard.
  expect(
    findingsOf(fillTrace({ intended: '4111 1111 1111 1111', committed: '4111111111111111' })),
  ).toEqual([]);
});

// --- Honest silence (never fabricate) -----------------------------------------------------------

test('emits NOTHING when there is no postdating after-snapshot (honest silence, not a guess)', () => {
  // The action ran, but no after@c1 snapshot carries a value → we cannot read the committed value.
  const noSnap = jsonl([
    { type: 'context-options', version: 8 },
    {
      type: 'before',
      callId: 'c1',
      startTime: 1,
      method: 'fill',
      params: { selector: '#user', value: 'acetaminophen' },
    },
    { type: 'after', callId: 'c1', endTime: 2 },
  ]);
  expect(findingsOf(noSnap)).toEqual([]);
});

test('emits NOTHING when the only snapshot belongs to a DIFFERENT action', () => {
  // A snapshot named after@c2 does not postdate action c1 — no correlation, so no finding.
  expect(findingsOf(fillTrace({ committed: 'aei', snapshotName: 'after@c2' }))).toEqual([]);
});

test('emits NOTHING when the pre-action before@ snapshot is the only one (never the committed value)', () => {
  expect(findingsOf(fillTrace({ committed: 'aei', snapshotName: 'before@c1' }))).toEqual([]);
});

test('emits NOTHING when the target field lives inside an unresolved reference subtree', () => {
  // The <body> is a back-reference `[[1,2]]` to an earlier snapshot we do not resolve → no field is
  // materialized → honest silence (the accepted offline limitation, never a fabricated drop).
  expect(findingsOf(fillTrace({ committed: 'aei', bodyOverride: [[1, 2]] }))).toEqual([]);
});

// --- Additive: non-value actions and non-value methods stay silent ------------------------------

test('emits NOTHING for a non-value action (a click) even with a snapshot present', () => {
  const clickTrace = jsonl([
    { type: 'context-options', version: 8 },
    { type: 'before', callId: 'c1', startTime: 1, method: 'click', params: { selector: '#user' } },
    { type: 'after', callId: 'c1', endTime: 2 },
    snapshotEvent('after@c1', 'c1', [
      inputNode({ id: 'user', __playwright_target__: '', __playwright_value_: '' }),
    ]),
  ]);
  expect(findingsOf(clickTrace)).toEqual([]);
});

// --- Target matching: stamp first, selector-key fallback ----------------------------------------

test('resolves the target by __playwright_target__ even when another input carries a value', () => {
  // Two value fields; only the action's target is stamped, so a decoy sibling cannot steal the match.
  const f = findingsOf(
    fillTrace({
      intended: 'acetaminophen',
      committed: 'acetamin',
      id: 'user',
      extraInputs: [inputNode({ id: 'other', __playwright_value_: 'unrelated-value' })],
    }),
  );
  expect(f).toHaveLength(1);
  expect(f[0]!.shape).toBe('truncated');
});

test('falls back to the selector id key when no field is stamped', () => {
  const f = findingsOf(
    fillTrace({
      selector: '#user',
      intended: 'acetaminophen',
      committed: 'acetamin',
      stampTarget: false,
      id: 'user',
      extraInputs: [inputNode({ id: 'other', __playwright_value_: 'acetaminophen' })],
    }),
  );
  expect(f).toHaveLength(1);
  expect(f[0]!.shape).toBe('truncated');
});

test('falls back to the [name=…] selector key when no field is stamped', () => {
  const f = findingsOf(
    fillTrace({
      selector: 'input[name="user"]',
      intended: 'acetaminophen',
      committed: 'acetamin',
      stampTarget: false,
      id: 'ignored',
      name: 'user',
    }),
  );
  expect(f).toHaveLength(1);
  expect(f[0]!.shape).toBe('truncated');
});

test('stays silent when neither the stamp nor the selector key can uniquely identify the field', () => {
  // No stamp, and an opaque role/label selector yields no id/name key → cannot identify the field.
  expect(
    findingsOf(
      fillTrace({
        selector: 'internal:role=textbox',
        committed: 'aei',
        stampTarget: false,
        id: 'user',
      }),
    ),
  ).toEqual([]);
});

// --- Value read from params.text (type) as well as params.value (fill) --------------------------

test('reads the intended value from params.text for a type action', () => {
  const f = findingsOf(
    fillTrace({
      method: 'type',
      valueParam: 'text',
      intended: 'acetaminophen',
      committed: 'acetamin',
    }),
  );
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ method: 'type', shape: 'truncated' });
});

// --- Wired into the diagnose-trace report (suspected + privacy + honest-limit wording) ----------

test('renders the finding as a suspected line — value-free, never blames Playwright fill', () => {
  const info = parseTraceEvents(fillTrace({ intended: 'acetaminophen500', committed: 'acetamin' }));
  const d = diagnoseTraceInfo(info);
  // A fill that "succeeded" has no failed action, but the offline arm still surfaces the drift.
  expect(d.action).toBeNull();
  expect(d.inputIntegrity).toHaveLength(1);

  const report = renderTraceReport(d);
  expect(report).toContain('Suspected input-integrity');
  expect(report).toContain('input-not-committed');
  expect(report).toContain('(suspected)');
  expect(report).toContain('typed 16 chars');
  expect(report).toContain('the after-snapshot shows 8');
  // Honest-limit wording present; never blames Playwright; never echoes the typed value (privacy).
  expect(report).toContain('DEFERRED async drop');
  expect(report.toLowerCase()).not.toContain('fill failed');
  expect(report).not.toContain('acetaminophen');
});

test('surfaces the input finding ALONGSIDE a named actionability cause on a later failed action', () => {
  // A fill drifts (c1, success), then a click fails as covered (c2) — both signals coexist: the gated
  // `cause` is the actionability one, and the input-integrity finding is an additive suspected line.
  const trace = jsonl([
    { type: 'context-options', version: 8 },
    {
      type: 'before',
      callId: 'c1',
      startTime: 1,
      method: 'fill',
      params: { selector: '#user', value: 'acetaminophen' },
    },
    { type: 'after', callId: 'c1', endTime: 2 },
    snapshotEvent('after@c1', 'c1', [
      inputNode({ id: 'user', __playwright_target__: '', __playwright_value_: 'acetamin' }),
    ]),
    { type: 'before', callId: 'c2', startTime: 3, method: 'click', params: { selector: '#go' } },
    {
      type: 'log',
      callId: 'c2',
      time: 4,
      message: '<div class="veil"></div> intercepts pointer events',
    },
    { type: 'after', callId: 'c2', endTime: 5, error: { message: 'Timeout 1ms exceeded.' } },
  ]);
  const d = diagnoseTraceInfo(parseTraceEvents(trace));
  expect(d.cause).toBe('covered-by-overlay');
  expect(d.confidence).toBe('suspected');
  expect(d.inputIntegrity).toHaveLength(1);
  expect(d.inputIntegrity[0]!.shape).toBe('truncated');
  const report = renderTraceReport(d);
  expect(report).toContain('covered-by-overlay (suspected)');
  expect(report).toContain('Suspected input-integrity');
});

// --- A clean value trace's report is byte-unchanged vs. the same trace with no snapshot ----------

test('a clean value trace adds NO section — byte-identical to the no-snapshot report', () => {
  const clean = renderTraceReport(
    diagnoseTraceInfo(parseTraceEvents(fillTrace({ intended: 'abc', committed: 'abc' }))),
  );
  const noSnap = renderTraceReport(
    diagnoseTraceInfo(
      parseTraceEvents(
        jsonl([
          {
            type: 'context-options',
            version: 8,
            playwrightVersion: '1.61.1',
            browserName: 'chromium',
          },
          {
            type: 'before',
            callId: 'c1',
            startTime: 1,
            method: 'fill',
            params: { selector: '#user', value: 'abc' },
          },
          { type: 'after', callId: 'c1', endTime: 2 },
        ]),
      ),
    ),
  );
  expect(clean).toBe(noSnap);
  expect(clean).not.toContain('Suspected input-integrity');
});
