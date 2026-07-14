import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { fixtureUrl } from './helpers';

// v0.9 Move 3 — framework-agnostic network-idle quiescence. The observer monkey-patches XHR + fetch
// to keep a real in-flight count; opt-in `awaitQuiescence` makes settle resolve only once the DOM is
// quiet AND the app is network-idle (still bounded by maxWaitMs). Read-only — it never fires events
// or forces loads. This improves the observe-consequences niche on RPC-driven legacy apps; it does
// NOT catch GWT's zero-network Scheduler waves (that is #49's late-watch), and it does not fix
// actionability timeouts (those are covered/backend). Additive — the default settle is unchanged.

const URL = fixtureUrl('quiescence.html');
const DELAY = 250; // the in-flight window the test controls via page.route

async function delaySlowEndpoint(page: import('@playwright/test').Page) {
  await page.route('**/dw-slow-endpoint', async (route) => {
    await new Promise((r) => setTimeout(r, DELAY));
    await route.fulfill({ status: 200, body: 'ok' });
  });
}

test('awaitQuiescence extends settle until the in-flight fetch finishes', async ({ page }) => {
  await delaySlowEndpoint(page);

  // WITHOUT: settle resolves on DOM-quiet (~quietMs after the marker), before the 250ms fetch.
  await page.goto(URL);
  const plain = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  expect(plain.stats.settleMs, 'default settle ignores the in-flight fetch').toBeLessThan(
    DELAY - 30,
  );
  expect(plain.stats.quiescent, 'quiescent absent on the default path').toBeUndefined();

  // WITH: settle waits for network idle → resolves only after the fetch completes (~250ms).
  await page.goto(URL);
  const q = await actAndObserve(page, (p) => p.click('#go'), {
    label: 'go',
    awaitQuiescence: true,
  });
  expect(q.stats.settleMs, 'awaitQuiescence waits for the in-flight fetch').toBeGreaterThanOrEqual(
    DELAY - 20,
  );
  expect(q.stats.quiescent, 'the app was network-idle at the settle point').toBe(true);
  expect(q.stats.hitMaxWait).toBe(false);
});

test('awaitQuiescence also waits out an in-flight XHR (GWT-RPC-style)', async ({ page }) => {
  await delaySlowEndpoint(page);
  await page.goto(URL);
  const q = await actAndObserve(page, (p) => p.dblclick('#go'), {
    label: 'dblclick',
    awaitQuiescence: true,
  });
  expect(q.stats.settleMs).toBeGreaterThanOrEqual(DELAY - 20);
  expect(q.stats.quiescent).toBe(true);
});

test('a still-busy app at the cap reports quiescent=false + hitMaxWait', async ({ page }) => {
  // Response delayed well past a low maxWaitMs → the cap fires while the request is still in flight.
  await page.route('**/dw-slow-endpoint', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, body: 'ok' });
  });
  await page.goto(URL);
  const q = await actAndObserve(page, (p) => p.click('#go'), {
    label: 'go',
    awaitQuiescence: true,
    maxWaitMs: 300,
  });
  expect(q.stats.hitMaxWait).toBe(true);
  expect(q.stats.quiescent, 'the app was STILL requesting when the cap hit').toBe(false);
});

test('the default settle path is byte-unchanged (no awaitQuiescence)', async ({ page }) => {
  await delaySlowEndpoint(page);
  await page.goto(URL);
  const d = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  // No quiescent stat, and settle did not wait for the network.
  expect(d.stats.quiescent).toBeUndefined();
  expect(d.stats.settleMs).toBeLessThan(DELAY - 30);
});

test('the default path never patches native fetch/XHR (non-interference)', async ({ page }) => {
  await delaySlowEndpoint(page);
  await page.goto(URL);
  await actAndObserve(page, (p) => p.click('#go'), { label: 'go' }); // NO awaitQuiescence
  const nativeFetch = await page.evaluate(() =>
    Function.prototype.toString.call(window.fetch).includes('[native code]'),
  );
  const nativeSend = await page.evaluate(() =>
    Function.prototype.toString.call(XMLHttpRequest.prototype.send).includes('[native code]'),
  );
  expect(nativeFetch, 'window.fetch stays native without awaitQuiescence').toBe(true);
  expect(nativeSend, 'XHR.prototype.send stays native without awaitQuiescence').toBe(true);
});

test('a synchronous XHR.send() throw does not leak the counter', async ({ page }) => {
  await delaySlowEndpoint(page);
  await page.goto(URL);
  // An awaitQuiescence action injects the observer AND enables the counter; it waits out the fetch,
  // so inFlight returns to 0 (isQuiescent true) at the end.
  await actAndObserve(page, (p) => p.click('#go'), { label: 'go', awaitQuiescence: true });
  // Provoke a synchronous send() throw (send before open → InvalidStateError).
  const threw = await page.evaluate(() => {
    try {
      new XMLHttpRequest().send();
      return false;
    } catch {
      return true;
    }
  });
  expect(threw, 'send()-before-open() still throws natively (read-only, non-interference)').toBe(
    true,
  );
  const quiescent = await page.evaluate(() =>
    (
      window as unknown as { __deltawright: { isQuiescent(): boolean } }
    ).__deltawright.isQuiescent(),
  );
  expect(quiescent, 'the sync throw did NOT leak inFlight — the counter is not wedged').toBe(true);
});
