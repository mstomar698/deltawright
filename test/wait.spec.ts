import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { observeConsequences } from '../src/wait';
import { fixtureUrl } from './helpers';

// Settle-as-a-wait (#58). Live tests (it drives the page, like actAndObserve). Covers the three
// acceptance criteria + the CSP degrade and the anti-guarantee shape.

const CLICK_ADDS = `
  <button id="go">go</button>
  <div id="stage"></div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const d = document.createElement('div');
      d.textContent = 'added';
      document.getElementById('stage').appendChild(d);
    });
  </script>
`;

test('should_resolve_on_structural_quiescence_without_a_locator', async ({ page }) => {
  await page.setContent(CLICK_ADDS);
  // No locator — just (page, action). Resolves when the DOM goes quiet after the single-wave insert.
  const obs = await observeConsequences(page, (p) => p.click('#go'));
  expect(obs.observed).toBe(true);
  expect(obs.hitMaxWait).toBe(false); // it went quiet, not capped
  expect(obs.settleMs).toBeGreaterThan(0);
  expect(obs.suspectedEarly).toBe(false); // one wave → no late wave
});

test('should_expose_suspectedEarly_when_the_two_wave_gap_heuristic_trips', async ({ page }) => {
  await page.goto(pathToFileURL(resolve('test/fixtures/late-wave.html')).href);
  // The fixture inserts wave-1 immediately and wave-2 ~400 ms later (after settle) — the gap-E watch
  // should flag it.
  const obs = await observeConsequences(page, (p) => p.click('#open'), { lateWatchMs: 1200 });
  expect(obs.observed).toBe(true);
  expect(obs.suspectedEarly).toBe(true);
});

test('should_never_be_presented_as_a_completion_guarantee_or_flake_suppressant', async ({
  page,
}) => {
  // Enforced in the DOCS/framing…
  const src = readFileSync(resolve(process.cwd(), 'src/wait/index.ts'), 'utf8').toLowerCase();
  expect(src).toContain('not a completion guarantee');
  expect(src).toContain('flake suppressant');

  // …AND in the TYPE: the observation exposes only settle SIGNALS — no ready/safe/settled boolean and
  // no retry knob — so it cannot be read as a guarantee.
  await page.setContent(CLICK_ADDS);
  const obs = await observeConsequences(page, (p) => p.click('#go'));
  const keys = Object.keys(obs).sort();
  expect(keys).toEqual(['hitMaxWait', 'observed', 'settleMs', 'suspectedEarly']);
  for (const forbidden of ['ready', 'safe', 'settled', 'guaranteed', 'retry']) {
    expect(forbidden in obs).toBe(false);
  }
});

test('propagates an action error (and does not swallow it) — the observer is torn down in finally', async ({
  page,
}) => {
  await page.setContent(CLICK_ADDS);
  // An action that throws must reject out of observeConsequences (not be masked); the finally still
  // resets the observer. A subsequent normal call on the same page then works cleanly.
  await expect(observeConsequences(page, () => Promise.reject(new Error('boom')))).rejects.toThrow(
    'boom',
  );
  const after = await observeConsequences(page, (p) => p.click('#go'));
  expect(after.observed).toBe(true);
  expect(after.hitMaxWait).toBe(false);
});

test('degrades to observed:false with a reason under a strict CSP', async ({ page }) => {
  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'" />
    <button id="go">go</button>
  `);
  const obs = await observeConsequences(page, (p) => p.click('#go'));
  expect(obs.observed).toBe(false);
  expect(obs.skippedReason).toContain('injection blocked');
});

// --- v0.9 Move 3 follow-up (Piece A): awaitQuiescence threaded into the locator-free wait path ---
// The SAME opt-in awaitQuiescence actAndObserve honors is now wired into observeConsequences: only when
// set does it enableQuiescence() + factor isQuiescent() into settle, and it surfaces `quiescent` the same
// conditional way. Default unset → byte-unchanged (no patching, no `quiescent`).

const Q_URL = fixtureUrl('quiescence.html');
const Q_DELAY = 600; // the in-flight window the test controls via page.route

async function delaySlowEndpoint(page: import('@playwright/test').Page, ms = Q_DELAY) {
  await page.route('**/dw-slow-endpoint', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.fulfill({ status: 200, body: 'ok' });
  });
}

test('awaitQuiescence extends observeConsequences until the in-flight fetch finishes', async ({
  page,
}) => {
  await delaySlowEndpoint(page);

  // WITHOUT: settle resolves on DOM-quiet (~quietMs after the marker), before the 250ms fetch, and
  // exposes no `quiescent` field.
  await page.goto(Q_URL);
  const plain = await observeConsequences(page, (p) => p.click('#go'), { lateWatchMs: 0 });
  expect(plain.settleMs, 'default settle ignores the in-flight fetch').toBeLessThan(Q_DELAY - 30);
  expect(plain.quiescent, 'quiescent absent on the default wait path').toBeUndefined();

  // WITH: settle waits for network idle → resolves only after the fetch completes (~250ms).
  await page.goto(Q_URL);
  const q = await observeConsequences(page, (p) => p.click('#go'), {
    lateWatchMs: 0,
    awaitQuiescence: true,
  });
  expect(q.settleMs, 'awaitQuiescence waits for the in-flight fetch').toBeGreaterThanOrEqual(
    Q_DELAY - 20,
  );
  expect(q.quiescent, 'the app was network-idle at the settle point').toBe(true);
  expect(q.hitMaxWait).toBe(false);
});

test('the wait observation exposes `quiescent` only when awaitQuiescence ran', async ({ page }) => {
  await delaySlowEndpoint(page);

  await page.goto(Q_URL);
  const q = await observeConsequences(page, (p) => p.click('#go'), {
    lateWatchMs: 0,
    awaitQuiescence: true,
  });
  expect(Object.keys(q).sort()).toEqual([
    'hitMaxWait',
    'observed',
    'quiescent',
    'settleMs',
    'suspectedEarly',
  ]);

  await page.goto(Q_URL);
  const plain = await observeConsequences(page, (p) => p.click('#go'), { lateWatchMs: 0 });
  expect('quiescent' in plain, 'default wait path stays byte-unchanged — no quiescent key').toBe(
    false,
  );
});

test('the default wait path never patches native fetch/XHR (non-interference)', async ({
  page,
}) => {
  await delaySlowEndpoint(page);
  await page.goto(Q_URL);
  await observeConsequences(page, (p) => p.click('#go'), { lateWatchMs: 0 }); // NO awaitQuiescence
  const nativeFetch = await page.evaluate(() =>
    Function.prototype.toString.call(window.fetch).includes('[native code]'),
  );
  const nativeSend = await page.evaluate(() =>
    Function.prototype.toString.call(XMLHttpRequest.prototype.send).includes('[native code]'),
  );
  expect(nativeFetch, 'window.fetch stays native without awaitQuiescence').toBe(true);
  expect(nativeSend, 'XHR.prototype.send stays native without awaitQuiescence').toBe(true);
});
