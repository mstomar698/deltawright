import { test, expect } from '@playwright/test';
import { observeEffectSettled, observeConsequences } from '../src/wait/index';
import { diffChangedRegion } from '../src/index';
import { EFFECT_SETTLE_FIXTURE_URL } from './helpers';

// R1: observeEffectSettled — know the ACTION'S OWN effect has landed and its region has gone still,
// WITHOUT a static sleep and WITHOUT global networkidle. Four adversarial scenarios, each targeting a
// case that sleep / networkidle / global-quiescence gets wrong.

test.beforeEach(async ({ page }) => {
  await page.goto(EFFECT_SETTLE_FIXTURE_URL);
});

test('(a) no-network client re-render: the effect-settle waits for the DOM effect, not the (already-idle) network', async ({
  page,
}) => {
  const obs = await observeEffectSettled(page, (p) => p.click('#client-rerender'), {
    awaitQuiescence: true, // the network gate is satisfied immediately (no network) …
  });
  // … yet the settle still waited for the 300ms-delayed, NO-NETWORK client re-render — proof this is a
  // structural effect signal, not networkidle rebranded (networkidle would return on the idle network).
  expect(obs.observed).toBe(true);
  expect(obs.effectAppeared).toBe(true);
  expect(obs.signals.networkIdle, 'the network was idle the whole time').toBe(true);
  expect(obs.appearedMs, 'the effect appears ~300ms in, not at t0').toBeGreaterThanOrEqual(250);
  expect(obs.hitMaxWait).toBe(false);
  expect(obs.signals.structuralQuiet).toBe(true);
  expect(obs.region, 'a suspected-effect region is reported').toBeTruthy();
  // The re-render actually landed by the time we resolved.
  await expect(page.locator('#rendered')).toBeVisible();
});

test('(b) background churn: settles on the delayed effect, NOT reset by the ticker — where a global settle over-waits', async ({
  page,
}) => {
  // Start a 30ms background ticker in a region far from the effect area, then let it establish so the
  // pre-action baseline will see it recur and classify it background.
  await page.evaluate(() => (window as unknown as { startTicker: () => void }).startTicker());
  await page.waitForTimeout(120);

  const obs = await observeEffectSettled(page, (p) => p.click('#delayed-effect'));
  expect(obs.effectAppeared).toBe(true);
  expect(obs.hitMaxWait, 'region-scoped settle is NOT reset by the ticker → it quiesces').toBe(
    false,
  );
  expect(obs.appearedMs).toBeGreaterThanOrEqual(250); // the real effect at ~300ms
  expect(obs.settledMs).toBeLessThan(1500); // settled well before the 2000ms cap
  // The suspected-effect region is the effect area (right side), not the feed (left side, x≈20).
  expect(obs.region!.x, 'region is the effect area, not the background feed').toBeGreaterThan(500);

  // Contrast: a GLOBAL settle (observeConsequences) is reset by the never-ending ticker and hits the cap.
  await page.evaluate(() => document.getElementById('result')?.remove()); // reset the effect
  const global = await observeConsequences(page, (p) => p.click('#delayed-effect'), {
    lateWatchMs: 0,
  });
  expect(global.hitMaxWait, 'the global settle over-waits to the cap under background churn').toBe(
    true,
  );
});

test('(b2) background REMOVAL churn (virtualized recycler) does not mis-seed or reset the region', async ({
  page,
}) => {
  // A recycler that removes+appends feed rows every 30ms — REMOVAL-dominant background churn. Without
  // the baseline recurring-removal channel, a removal would seed the region on the feed (left) and the
  // real effect (right) would be region-excluded → wrong region / never settles.
  await page.evaluate(() => (window as unknown as { startRecycler: () => void }).startRecycler());
  await page.waitForTimeout(120);

  const obs = await observeEffectSettled(page, (p) => p.click('#delayed-effect'));
  expect(obs.effectAppeared).toBe(true);
  expect(obs.hitMaxWait, 'recycler removals are background → the effect region quiesces').toBe(
    false,
  );
  expect(obs.region!.x, 'region is the effect area, not the recycling feed').toBeGreaterThan(500);
});

test('the baseline footprint does not leak across calls (a later baseline:false sees a clean slate)', async ({
  page,
}) => {
  await page.evaluate(() => (window as unknown as { startTicker: () => void }).startTicker());
  await page.waitForTimeout(120);
  // First call (baseline ON) learns the 30ms ticker as background and must CONSUME that footprint.
  await observeEffectSettled(page, (p) => p.click('#delayed-effect'));
  await page.evaluate(() => document.getElementById('result')?.remove());
  // Second call with baseline:false. If the footprint LEAKED, the ticker would still be excluded and
  // the effect would be the 300ms #result (appearedMs ~300). With the footprint CLEARED (fix), a clean
  // slate treats the very next ticker insert (~30ms) as the first effect.
  const obs = await observeEffectSettled(page, (p) => p.click('#delayed-effect'), {
    baseline: false,
    maxWaitMs: 500,
  });
  expect(obs.effectAppeared).toBe(true);
  expect(
    obs.appearedMs,
    'a clean slate treats the first mutation (ticker ~30ms) as the effect, not the 300ms delayed one',
  ).toBeLessThan(200);
});

test('(c) canvas / no-DOM: honest effectAppeared:false; compose diffChangedRegion to localize by pixels', async ({
  page,
}) => {
  // A canvas repaint mutates NO DOM, so the effect-settle honestly reports no effect — never a fake
  // settle. The wait subpath stays lean (no pngjs); localize by pixels via the public diffChangedRegion.
  const before = await page.screenshot();
  const obs = await observeEffectSettled(page, (p) => p.click('#canvas-draw'), {
    appearTimeoutMs: 500,
  });
  expect(obs.effectAppeared).toBe(false);
  expect(obs.region).toBeNull();

  // Compose the public pixel-diff (from the main entry) to localize the no-DOM effect.
  const region = diffChangedRegion(before, await page.screenshot());
  expect(region, 'diffChangedRegion localizes the canvas repaint').toBeTruthy();
  expect(region!.rect.width).toBeGreaterThan(50);
});

test('(d) no-effect action: effectAppeared:false, never a fake clean settle (honesty gate)', async ({
  page,
}) => {
  const obs = await observeEffectSettled(page, (p) => p.click('#no-op'), { appearTimeoutMs: 400 });
  expect(obs.effectAppeared).toBe(false);
  expect(obs.appearedMs).toBeNull();
  expect(obs.region).toBeNull();
  // Honesty gate: a no-effect action must NEVER read as a clean settle (hitMaxWait:false).
  expect(obs.hitMaxWait).toBe(true);
  expect(obs.signals.structuralQuiet).toBe(false);
});

test('honesty: no `ready`/`safe`/`settled` boolean on the observation (a signal, not a guarantee)', async ({
  page,
}) => {
  const obs = await observeEffectSettled(page, (p) => p.click('#client-rerender'));
  for (const k of ['ready', 'safe', 'settled', 'ok']) expect(k in obs).toBe(false);
});

test('(e) a top-level modal removed off <body> settles cleanly (region null) despite continuous body-level churn', async ({
  page,
}) => {
  await page.click('#open-modal');
  await expect(page.locator('#modal')).toHaveCount(1);

  const obs = await observeEffectSettled(page, (p) => p.click('#close-modal'), { maxWaitMs: 2500 });

  expect(obs.observed).toBe(true);
  // An effect DID happen (the modal was removed) — never a fake "no effect".
  expect(obs.effectAppeared).toBe(true);
  // A top-level removal has no informative rect, so the region is honestly null — NOT the whole viewport.
  expect(obs.region).toBeNull();
  // The continuous <body>-attribute churn is unlocalizable, so it never resets the settle → a clean
  // settle, not hitMaxWait. (With the old viewport-sized region this over-waited to the cap.)
  expect(obs.hitMaxWait).toBe(false);
  await expect(page.locator('#modal')).toHaveCount(0);
});

test('(f) a localizable follow-on after a top-level removal scopes the region to the follow-on, not the viewport', async ({
  page,
}) => {
  await page.click('#open-modal');

  // Widen the quiet window so the 250ms follow-on reliably lands inside it (and resets/seeds the region)
  // rather than the removal settling first.
  const obs = await observeEffectSettled(page, (p) => p.click('#close-modal-then-effect'), {
    quietMs: 400,
    maxWaitMs: 3000,
  });

  expect(obs.observed).toBe(true);
  expect(obs.effectAppeared).toBe(true);
  expect(obs.hitMaxWait).toBe(false);
  // The region attaches to the localizable follow-on in #effect-area — present and sub-viewport, proving
  // the unlocalizable removal did not force a null/viewport region when a real effect followed.
  expect(obs.region).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(obs.region!.width).toBeLessThan(vp.width);
  expect(obs.region!.height).toBeLessThan(vp.height);
});

test('degrades honestly under a strict CSP (observed:false, still performs the action)', async ({
  page,
}) => {
  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'" />
    <button id="b">x</button>
  `);
  let clicked = false;
  const obs = await observeEffectSettled(page, async (p) => {
    await p.click('#b');
    clicked = true;
  });
  expect(obs.observed).toBe(false);
  expect(obs.skippedReason).toMatch(/injection blocked/i);
  expect(obs.effectAppeared).toBe(false);
  expect(clicked, 'the action still ran (effect-settle must ACT)').toBe(true);
});
