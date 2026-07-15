import { test, expect, type Page } from '@playwright/test';
import { actAndObserve } from '../src/index';
import {
  attachLiveRouting,
  buildLiveRouting,
  MAX_SIGNALS,
  SNIPPET_MAX,
} from '../src/host/live-routing';
import type { RawLiveSignal } from '../src/host/live-routing';
import { fixtureUrl } from './helpers';

// v0.9 Move 2 — honest ownership-routing (LIVE arm). When opted in via `routeSignals`, actAndObserve
// attaches four page listeners (response ≥400 / requestfailed / pageerror / console error|warn)
// bracketing the action + settle and surfaces `stats.routing`: co-occurrence, never causation (DW-03).
// Only an uncaught pageerror flips the not-DOM hint; a 4xx/5xx or failed request flips the backend
// hint; a console.error is context. It emits NO taxonomy code and never touches Playwright's verdict
// (DW-02). Additive — off by default → ZERO listeners and no `routing` field (default path unchanged).

const URL = fixtureUrl('live-routing.html');

// `listenerCount` is present at runtime on Playwright's Page (a custom EventEmitter) but not in the
// public type — cast to read it.
const listenerCount = (page: Page, event: string): number =>
  (page as unknown as { listenerCount(e: string): number }).listenerCount(event);

const ROUTING_EVENTS = ['response', 'requestfailed', 'pageerror', 'console'] as const;
const baseline = (page: Page) => ROUTING_EVENTS.map((e) => listenerCount(page, e));

async function fail500(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 500, body: 'nope' }));
}

// --- Live capture -----------------------------------------------------------------------------------

test('captures a co-occurring 500 response AND an uncaught pageerror, and routes on both', async ({
  page,
}) => {
  await fail500(page);
  await page.goto(URL);

  const d = await actAndObserve(page, (p) => p.click('#go'), { label: 'go', routeSignals: true });
  const r = d.stats.routing;
  expect(r, 'routing present when opted in').toBeDefined();
  if (!r) return;

  // Both signals captured.
  expect(r.pageErrorCount).toBe(1);
  expect(r.backendCount).toBe(1);
  expect(r.signals.some((s) => s.kind === 'pageerror')).toBe(true);
  const resp = r.signals.find((s) => s.kind === 'response');
  expect(resp?.status).toBe(500);

  // Co-occurrence hints flip (actAndObserve's action succeeded → domCauseNamed is false).
  expect(r.suspectedBackendCause).toBe(true);
  expect(r.suspectedNotDomCause).toBe(true);
  expect(r.recommendation).toContain('not-a-DOM-cause');
  // The backend route is CO-OCCURRENCE-framed, not a bare "route to BACKEND/INFRA" directive.
  expect(r.recommendation).toContain('WEIGH as a possible backend/infra signal');
  expect(r.recommendation).not.toContain('route to BACKEND/INFRA');
  expect(r.recommendation).toContain('Co-occurrence, not proof.');
  expect(r.recommendation).toContain('APP OWNER');

  // PRIVACY: the query string is stripped, the pageerror snippet is surfaced but not the raw object.
  expect(resp?.path).toBe('http://dw.test/api/orders/submit');
  expect(JSON.stringify(r)).not.toContain('SECRET123');
  expect(r.signals.find((s) => s.kind === 'pageerror')?.snippet).toContain('boom');

  // DW-02: routing is metadata — the delta/verdict path is untouched (the click succeeded).
  expect(d.action).toBe('go');
});

// --- Default path is byte-unchanged (opt-in) --------------------------------------------------------

test('default path: no routing field AND zero listeners attached (byte-unchanged)', async ({
  page,
}) => {
  await fail500(page);
  await page.goto(URL);

  const before = baseline(page);
  const d = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' }); // NO routeSignals
  const after = baseline(page);

  expect(d.stats.routing, 'no routing field on the default path').toBeUndefined();
  expect(after, 'zero listeners attached without routeSignals').toEqual(before);
});

// --- Listener cleanup (no leaks) --------------------------------------------------------------------

test('opted in: listener counts return to baseline after the call', async ({ page }) => {
  await fail500(page);
  await page.goto(URL);

  const before = baseline(page);
  await actAndObserve(page, (p) => p.click('#go'), { label: 'go', routeSignals: true });
  expect(baseline(page), 'all four listeners detached').toEqual(before);
});

test('opted in: listeners are detached even when the action throws', async ({ page }) => {
  await page.goto(URL);

  const before = baseline(page);
  await expect(
    actAndObserve(page, (p) => p.click('#does-not-exist', { timeout: 150 }), {
      label: 'missing',
      routeSignals: true,
    }),
  ).rejects.toThrow();
  expect(baseline(page), 'a throwing action still detaches the listeners').toEqual(before);
});

// --- List-and-clamp ---------------------------------------------------------------------------------

test('many console errors in the window are capped at MAX_SIGNALS; windowCount is the true total', async ({
  page,
}) => {
  await page.goto(URL);
  const d = await actAndObserve(page, (p) => p.click('#console-spam'), {
    label: 'spam',
    routeSignals: true,
    // Give the 20 console messages room to be delivered before settle closes.
    quietMs: 300,
  });
  const r = d.stats.routing;
  expect(r).toBeDefined();
  if (!r) return;
  expect(r.signals).toHaveLength(MAX_SIGNALS);
  expect(r.windowCount).toBe(20);
});

// --- console.error alone never flips the hint (live) ------------------------------------------------

test('a console.error alone never flips the not-DOM hint (only a real pageerror does)', async ({
  page,
}) => {
  await page.goto(URL);
  const d = await actAndObserve(page, (p) => p.click('#console-only'), {
    label: 'console-only',
    routeSignals: true,
  });
  const r = d.stats.routing;
  expect(r).toBeDefined();
  if (!r) return;
  expect(r.pageErrorCount).toBe(0);
  expect(r.suspectedNotDomCause).toBe(false);
  expect(r.suspectedBackendCause).toBe(false);
  expect(r.recommendation).toBe('');
  expect(r.signals.length).toBeGreaterThan(0); // still surfaced as context
});

// --- Pure builder (no browser) ----------------------------------------------------------------------

const pageError = (text: string): RawLiveSignal => ({ kind: 'pageerror', text });
const consoleErr = (text: string): RawLiveSignal => ({ kind: 'console-error', text });
const consoleWarn = (text: string): RawLiveSignal => ({ kind: 'console-warning', text });
const response = (status: number, url: string): RawLiveSignal => ({
  kind: 'response',
  status,
  url,
});
const requestFailed = (url: string, text?: string): RawLiveSignal => ({
  kind: 'requestfailed',
  url,
  text,
});

test('buildLiveRouting: a pageerror flips suspectedNotDomCause only when no DOM cause was named', () => {
  const collected = { raw: [pageError('TypeError: x is undefined')] };

  const flipped = buildLiveRouting(collected, { domCauseNamed: false });
  expect(flipped.pageErrorCount).toBe(1);
  expect(flipped.suspectedNotDomCause).toBe(true);
  expect(flipped.recommendation).toContain('APP OWNER');

  const suppressed = buildLiveRouting(collected, { domCauseNamed: true });
  expect(suppressed.suspectedNotDomCause).toBe(false); // DW named a DOM cause → context, not a route
  expect(suppressed.signals.map((s) => s.kind)).toContain('pageerror'); // still listed
  expect(suppressed.recommendation).toBe('');
});

test('buildLiveRouting: a 4xx/5xx response OR a requestfailed flips suspectedBackendCause', () => {
  for (const backend of [
    response(503, 'http://api/x'),
    response(404, 'http://api/y'),
    requestFailed('http://api/z', 'net::ERR_CONNECTION_REFUSED'),
  ]) {
    const r = buildLiveRouting({ raw: [backend] }, { domCauseNamed: false });
    expect(r.backendCount).toBe(1);
    expect(r.suspectedBackendCause).toBe(true);
    // Co-occurrence framing, not a bare directive.
    expect(r.recommendation).toContain('WEIGH as a possible backend/infra signal');
    expect(r.recommendation).not.toContain('route to BACKEND/INFRA');
    expect(r.recommendation).toContain('Co-occurrence, not proof.');
  }
  // A 2xx/3xx response is NOT a backend signal (the collector only keeps ≥400, but the builder must
  // also not count one if it slips through — count is over the response/requestfailed KINDS only).
  const ok = buildLiveRouting({ raw: [response(200, 'http://api/ok')] }, { domCauseNamed: false });
  expect(ok.backendCount).toBe(1); // a surfaced response kind is always a backend co-event
  expect(ok.suspectedBackendCause).toBe(true);
});

// --- Backend channel: client aborts are noise, not a backend fault (the FIX-1 narrowing) -----------

// The abort exclusion lives in the IMPURE collector (`attachLiveRouting.onRequestFailed`), so drive it
// by emitting synthetic `requestfailed` events on the page's EventEmitter — a fake Request carrying the
// two methods the handler reads (`url()`, `failure()`). No navigation, so nothing else fires.
const emitOn = (page: Page, event: string, arg: unknown): void =>
  (page as unknown as { emit(e: string, a: unknown): void }).emit(event, arg);
const fakeRequest = (url: string, errorText?: string): unknown => ({
  url: () => url,
  failure: () => (errorText ? { errorText } : null),
});

test('a co-occurring client-abort (net::ERR_ABORTED) requestfailed is NOT counted or routed; a genuine failure still is', async ({
  page,
}) => {
  const collector = attachLiveRouting(page);
  // The page cancelled its own request — must be dropped (defensively, any "aborted" text too).
  emitOn(page, 'requestfailed', fakeRequest('http://dw.test/api/cancelled', 'net::ERR_ABORTED'));
  emitOn(page, 'requestfailed', fakeRequest('http://dw.test/analytics', 'net::ERR_Aborted'));
  // A genuine connection failure — must be kept.
  emitOn(
    page,
    'requestfailed',
    fakeRequest('http://dw.test/api/down', 'net::ERR_CONNECTION_REFUSED'),
  );
  const collected = collector.detach();

  // No aborted request reached the raw stream.
  expect(collected.raw.some((e) => /aborted/i.test(e.text ?? ''))).toBe(false);

  const r = buildLiveRouting(collected, { domCauseNamed: false });
  expect(r.backendCount).toBe(1); // only the genuine ERR_CONNECTION_REFUSED
  expect(r.suspectedBackendCause).toBe(true); // a real failure STILL flips it
});

test('a requestfailed with no failure text is kept (a genuine failure is the safe default)', async ({
  page,
}) => {
  const collector = attachLiveRouting(page);
  emitOn(page, 'requestfailed', fakeRequest('http://dw.test/api/down')); // no errorText
  const r = buildLiveRouting(collector.detach(), { domCauseNamed: false });
  expect(r.backendCount).toBe(1);
});

test('buildLiveRouting: a console.error alone never flips the hint', () => {
  const r = buildLiveRouting(
    { raw: [consoleErr('deprecated'), consoleWarn('slow')] },
    { domCauseNamed: false },
  );
  expect(r.pageErrorCount).toBe(0);
  expect(r.backendCount).toBe(0);
  expect(r.suspectedNotDomCause).toBe(false);
  expect(r.suspectedBackendCause).toBe(false);
  expect(r.recommendation).toBe('');
  expect(r.signals).toHaveLength(2); // surfaced as context
});

test('buildLiveRouting: list-and-clamp caps at MAX_SIGNALS and reports the true windowCount', () => {
  const raw = Array.from({ length: MAX_SIGNALS + 5 }, (_, i) => consoleErr(`err ${i}`));
  const r = buildLiveRouting({ raw }, { domCauseNamed: false });
  expect(r.windowCount).toBe(MAX_SIGNALS + 5);
  expect(r.signals).toHaveLength(MAX_SIGNALS);
});

test('buildLiveRouting: the flip-evidence pageerror is kept first past the cap', () => {
  const raw: RawLiveSignal[] = [
    ...Array.from({ length: MAX_SIGNALS }, (_, i) => consoleErr(`warn ${i}`)),
    pageError('THE pageerror that flipped the hint'),
  ];
  const r = buildLiveRouting({ raw }, { domCauseNamed: false });
  expect(r.suspectedNotDomCause).toBe(true);
  expect(r.signals).toHaveLength(MAX_SIGNALS);
  expect(r.signals[0]!.kind).toBe('pageerror'); // never sliced out — always first
  expect(r.signals[0]!.snippet).toContain('THE pageerror');
});

test('buildLiveRouting: PRIVACY — the URL query string is stripped and long text is snippet-capped', () => {
  const long = 'x'.repeat(SNIPPET_MAX + 50);
  const r = buildLiveRouting(
    {
      raw: [
        response(500, 'https://api.example.com/orders/submit?token=SECRET&pii=alice%40x.com'),
        pageError(long),
      ],
    },
    { domCauseNamed: false },
  );
  const resp = r.signals.find((s) => s.kind === 'response');
  expect(resp?.path).toBe('https://api.example.com/orders/submit'); // no query string
  expect(JSON.stringify(r)).not.toContain('SECRET');
  expect(JSON.stringify(r)).not.toContain('alice');
  const err = r.signals.find((s) => s.kind === 'pageerror');
  expect(err?.snippet?.length).toBeLessThan(long.length); // capped
  expect(err?.snippet).toContain(`(${long.length} chars)`); // true length reported
});

test('buildLiveRouting: an empty window renders an empty report with no recommendation', () => {
  const r = buildLiveRouting({ raw: [] }, { domCauseNamed: false });
  expect(r.signals).toHaveLength(0);
  expect(r.windowCount).toBe(0);
  expect(r.pageErrorCount).toBe(0);
  expect(r.backendCount).toBe(0);
  expect(r.suspectedNotDomCause).toBe(false);
  expect(r.suspectedBackendCause).toBe(false);
  expect(r.recommendation).toBe('');
});
