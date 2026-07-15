import { test, expect } from '@playwright/test';
import { actAndObserve, ensureInjected } from '../src/index';
import { fixtureUrl } from './helpers';

// v0.9 Move 3 follow-up (Piece B) — SYNTHETIC validation of the framework-busy hooks in the observer's
// frameworkBusy(). These fixtures mount MOCK framework globals (window.Ext / window.PrimeFaces) that
// report BUSY for a controlled window WITHOUT issuing any network request, so the in-flight counter
// stays 0 and the framework hook is the SOLE gate on quiescence — proving isQuiescent() factors in the
// framework signal, not only the counter.
//
// HONEST SCOPE: this is SYNTHETIC validation — a mock that matches the public shape (Ext.Ajax.isLoading,
// PrimeFaces.ajax.Queue). It does NOT equal real-app validation (a real ExtJS/JSF portal is still
// needed) and does NOT address GWT's zero-network Scheduler waves (that is #49). The network counter
// remains the general/framework-agnostic path; these hooks are best-effort accelerators.

const EXT_URL = fixtureUrl('extjs-quiescence.html');
const PF_URL = fixtureUrl('primefaces-quiescence.html');
const BUSY_MS = 250; // the busy window each fixture holds (matches its inline BUSY_MS)

type IsQWindow = { __deltawright: { enableQuiescence(): void; isQuiescent(): boolean } };

// --- ExtJS ----------------------------------------------------------------

test('awaitQuiescence waits for Ext.Ajax.isLoading to clear (framework hook, counter idle)', async ({
  page,
}) => {
  // WITHOUT: settle resolves on DOM-quiet, well before the framework clears busy.
  await page.goto(EXT_URL);
  const plain = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  expect(plain.stats.settleMs, 'default settle ignores the framework busy signal').toBeLessThan(
    BUSY_MS - 30,
  );
  expect(plain.stats.quiescent, 'quiescent absent on the default path').toBeUndefined();
  // The default path must NEVER probe the framework hook (same gate as the counter patch).
  const defaultProbes = await page.evaluate(
    () => (window as unknown as { __extProbes: number }).__extProbes,
  );
  expect(defaultProbes, 'default path never consults Ext.Ajax.isLoading').toBe(0);

  // WITH: settle does NOT resolve while Ext.Ajax.isLoading() is true even though the network counter is
  // 0 — it waits until the framework clears busy (~250ms).
  await page.goto(EXT_URL);
  const q = await actAndObserve(page, (p) => p.click('#go'), {
    label: 'go',
    awaitQuiescence: true,
  });
  expect(q.stats.settleMs, 'awaitQuiescence waits out Ext.Ajax.isLoading').toBeGreaterThanOrEqual(
    BUSY_MS - 30,
  );
  expect(q.stats.settleMs, 'still bounded — it did not run away to the cap').toBeLessThan(2000);
  expect(q.stats.quiescent, 'the framework reported idle at the settle point').toBe(true);
  expect(q.stats.hitMaxWait).toBe(false);
  // The opt-in path DID consult the hook (proving the gate is not vacuous).
  const optInProbes = await page.evaluate(
    () => (window as unknown as { __extProbes: number }).__extProbes,
  );
  expect(optInProbes, 'the awaitQuiescence path consults Ext.Ajax.isLoading').toBeGreaterThan(0);
});

// --- JSF / PrimeFaces -----------------------------------------------------

test('awaitQuiescence waits for the PrimeFaces ajax Queue to drain (isEmpty path)', async ({
  page,
}) => {
  await page.goto(PF_URL);
  const plain = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  expect(plain.stats.settleMs, 'default settle ignores the PrimeFaces queue').toBeLessThan(
    BUSY_MS - 30,
  );
  expect(plain.stats.quiescent).toBeUndefined();

  await page.goto(PF_URL);
  const q = await actAndObserve(page, (p) => p.click('#go'), {
    label: 'go',
    awaitQuiescence: true,
  });
  expect(
    q.stats.settleMs,
    'awaitQuiescence waits for PrimeFaces.ajax.Queue.isEmpty()',
  ).toBeGreaterThanOrEqual(BUSY_MS - 30);
  expect(q.stats.settleMs).toBeLessThan(2000);
  expect(q.stats.quiescent).toBe(true);
  expect(q.stats.hitMaxWait).toBe(false);
});

test('awaitQuiescence also drains a PrimeFaces build exposing only Queue.requests (fallback path)', async ({
  page,
}) => {
  // addInitScript runs BEFORE the fixture's inline script, selecting the no-isEmpty Queue shape.
  await page.addInitScript(() => {
    (window as unknown as { __pfMode: string }).__pfMode = 'requests';
  });
  await page.goto(PF_URL);
  const q = await actAndObserve(page, (p) => p.click('#go'), {
    label: 'go',
    awaitQuiescence: true,
  });
  expect(
    q.stats.settleMs,
    'the .requests-length fallback also holds settle',
  ).toBeGreaterThanOrEqual(BUSY_MS - 30);
  expect(q.stats.quiescent).toBe(true);
  expect(q.stats.hitMaxWait).toBe(false);
});

// --- Guard: no / malformed framework object never throws, reads not-busy --------------------------

test('frameworkBusy is safe when the framework is absent or a different shape (no throw, not-busy)', async ({
  page,
}) => {
  // A page with NO framework globals, plus deliberately MALFORMED partial shapes, must not make the
  // guarded typeof/optional-chaining hops throw — isQuiescent() reads true (in-flight 0, not busy).
  await page.setContent(`
    <button id="go">go</button>
    <script>
      // Malformed on purpose: Ext with no Ajax, PrimeFaces with no Queue — every hop must be guarded.
      window.Ext = {};
      window.PrimeFaces = { ajax: {} };
    </script>
  `);
  await ensureInjected(page);
  const quiescent = await page.evaluate(() => {
    const dw = (window as unknown as IsQWindow).__deltawright;
    dw.enableQuiescence();
    return dw.isQuiescent(); // must not throw
  });
  expect(quiescent, 'absent/malformed framework globals read not-busy and do not throw').toBe(true);

  // And with NO framework globals at all.
  await page.setContent(`<button id="go">go</button>`);
  await ensureInjected(page);
  const quiescent2 = await page.evaluate(() => {
    const dw = (window as unknown as IsQWindow).__deltawright;
    dw.enableQuiescence();
    return dw.isQuiescent();
  });
  expect(quiescent2, 'no framework present → frameworkBusy() returns false, never throws').toBe(
    true,
  );
});
