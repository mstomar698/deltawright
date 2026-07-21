import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNetworkEvents, readTraceZip } from '../src/trace/read-trace';
import { deriveRouting, MAX_SIGNALS } from '../src/trace/routing';
import { diagnoseTraceBuffer, renderTraceReport } from '../src/trace/diagnose-trace';

// Debug A: trace-native network correlation — read the trace's own *.network member (which the offline
// arm was blind to) and fuse a status≥400 in the failing action's window with the DOM-cause verdict.

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/traces');
const fx = (name: string): Buffer => readFileSync(resolve(FX, `${name}.trace.zip`));

// --- parseNetworkEvents (defensive, status≥400 only, redacted) ------------------------------------

test('parseNetworkEvents keeps only status≥400, strips the query string, and skips unparseable lines', () => {
  const jsonl = [
    '{"type":"resource-snapshot","snapshot":{"_monotonicTime":500,"_resourceType":"fetch","request":{"method":"GET","url":"http://x/api/save?token=secret"},"response":{"status":500}}}',
    '{"type":"resource-snapshot","snapshot":{"_monotonicTime":100,"request":{"method":"GET","url":"http://x/ok"},"response":{"status":200}}}',
    '{"type":"resource-snapshot","snapshot":{"_monotonicTime":600,"request":{"method":"POST","url":"http://x/api/x"},"response":{"status":-1}}}',
    '{"type":"resource-snapshot","snapshot":{"_monotonicTime":700,"request":{"method":"GET","url":"http://x/api/y"},"response":{"status":404}}}',
    'not json at all',
    '{"type":"context-options"}',
  ].join('\n');

  const events = parseNetworkEvents(jsonl);
  // Only the 500 and the 404 survive (200 dropped, -1 dropped, garbage + non-snapshot skipped).
  expect(events.map((e) => e.status)).toEqual([500, 404]); // sorted by time (t=500 then t=700)
  expect(events[0]!.urlPath).toBe('http://x/api/save'); // query string stripped (privacy)
  expect(events[0]!.urlPath).not.toContain('secret');
  expect(events[0]!.resourceType).toBe('fetch');
  expect(events[1]!.status).toBe(404);
});

// --- end-to-end against the real fixture (a localhost 500 loop during a failing Timeout action) ---

test('readTraceZip populates networkEvents from the *.network member (redacted, status≥400)', () => {
  const info = readTraceZip(fx('backend-5xx'));
  expect(info.networkEvents.length).toBeGreaterThan(0);
  for (const e of info.networkEvents) {
    expect(e.status).toBeGreaterThanOrEqual(400);
    expect(e.urlPath).toContain('/api/save');
    expect(e.urlPath).not.toContain('?'); // query stripped
  }
});

test('a backend 5xx in the failing action window flips suspectedBackendCause and routes to BACKEND', () => {
  const info = readTraceZip(fx('backend-5xx'));
  const r = deriveRouting(info, { domCauseNamed: false });

  expect(r.networkErrorCount).toBeGreaterThan(0);
  expect(r.networkSignals.length).toBeGreaterThan(0);
  expect(r.networkSignals.length).toBeLessThanOrEqual(MAX_SIGNALS); // list-and-clamp
  expect(r.suspectedBackendCause).toBe(true);
  expect(r.recommendation).toMatch(/route to BACKEND/);
  expect(r.recommendation).toMatch(/status 500/);
  expect(r.recommendation).toMatch(/Co-occurrence, not proof/);
});

test('HONESTY: a NAMED DOM cause suppresses the backend route (network becomes context, not a route)', () => {
  const info = readTraceZip(fx('backend-5xx'));
  const named = deriveRouting(info, { domCauseNamed: true });
  // DW named a DOM actionability cause → this IS DW's class; the 5xx is context, never a route.
  expect(named.suspectedBackendCause).toBe(false);
  expect(named.recommendation).toBe('');
  // The signals are still counted (visible), just not upgraded to a route.
  expect(named.networkErrorCount).toBeGreaterThan(0);
});

test('the rendered report surfaces the HTTP errors as co-occurrence, never proof of cause', () => {
  const report = renderTraceReport(diagnoseTraceBuffer(fx('backend-5xx'), 'backend-5xx.trace.zip'));
  expect(report).toMatch(/HTTP error responses \(status ≥ 400\)/);
  expect(report).toMatch(/\[500\] GET .*\/api\/save/);
  expect(report).toMatch(/co-occurrence, NOT proof of cause/i);
});

test('an empty *.network member leaves networkEvents empty and the report byte-unchanged', () => {
  // Every pre-existing fixture has a 0-byte *.network member → no network signals, no new section.
  const info = readTraceZip(fx('covered'));
  expect(info.networkEvents).toEqual([]);
  const report = renderTraceReport(diagnoseTraceBuffer(fx('covered'), 'covered.trace.zip'));
  expect(report).not.toContain('HTTP error responses');
});
