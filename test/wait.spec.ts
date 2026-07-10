import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { observeConsequences } from '../src/wait';

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
