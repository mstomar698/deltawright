import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { LIVE_FIXTURE_URL } from './helpers';

// Regression suite for robust settle (#13, retires DW-01). The fixture has a
// background ticker mutating the DOM every 60 ms, so the page NEVER goes quiet.
// v0.1's pure-quiescence settle therefore always hits the maxWait cap. Robust
// settle must resolve via quiescence-relative-to-baseline WITHOUT missing the
// (possibly delayed) real change.

test.beforeEach(async ({ page }) => {
  await page.goto(LIVE_FIXTURE_URL);
});

test('delayed insert on a live page: captured AND settles without hitting the maxWait cap', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-delayed'), {
    label: 'open delayed',
  });

  // Recall: the dialog is captured despite the 150 ms delay + continuous ticker.
  const dialog = delta.nodes.find((n) => n.role === 'dialog' || n.name === 'Live dialog');
  expect(dialog, 'delayed dialog should be captured').toBeTruthy();

  // The settle improvement: it resolves via quiescence-vs-baseline, not the cap.
  expect(delta.stats.hitMaxWait, 'should NOT wait out the full maxWait cap').toBe(false);
  expect(delta.stats.settleMs, 'should settle promptly on a live page').toBeLessThan(1200);
});

test('instant insert on a live page: captured AND settles without hitting the maxWait cap', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-instant'), {
    label: 'open instant',
  });

  const dialog = delta.nodes.find((n) => n.role === 'dialog' || n.name === 'Live dialog');
  expect(dialog, 'instant dialog should be captured').toBeTruthy();
  expect(delta.stats.hitMaxWait).toBe(false);
  expect(delta.stats.settleMs).toBeLessThan(1200);
});
