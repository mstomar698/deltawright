import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { LIVE_FIXTURE_URL, fixtureUrl } from './helpers';

// Regression suite for causal attribution (#15). The live fixture's 60 ms ticker
// churns ~20 <span class="live"> cells + #log continuously. Time-window attribution
// reports all of them; causal attribution must EXCLUDE that background churn while
// KEEPING the action's real change (the inserted dialog).

test.beforeEach(async ({ page }) => {
  await page.goto(LIVE_FIXTURE_URL);
});

test('background ticker churn is excluded from the delta; the inserted dialog is kept', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-instant'), { label: 'open' });

  // Never drop the real change: the dialog (a new subtree) must be present.
  expect(delta.nodes.some((n) => n.role === 'dialog' || n.name === 'Live dialog')).toBe(true);

  // The background churn — recurring text updates on pre-existing .live / #log nodes —
  // must NOT leak into the delta.
  expect(
    delta.nodes.filter((n) => n.kind === 'textChanged'),
    'recurring background text churn should be attributed as background, not the action',
  ).toHaveLength(0);

  // The delta collapses to ~the modal subtree, not ~20 churning cells.
  expect(delta.nodes.length).toBeLessThanOrEqual(6);
});

test('a NO-OP on a live page yields ~no delta (the noise floor is filtered)', async ({ page }) => {
  const delta = await actAndObserve(page, async () => {}, { label: 'noop' });
  // With causal attribution, a no-op on a churning page should report essentially
  // nothing — the background churn is not the action's effect.
  expect(delta.nodes.length).toBeLessThanOrEqual(2);
});

test('recurring element-adding background churn (toasts) is excluded; the modal is kept', async ({
  page,
}) => {
  await page.goto(fixtureUrl('toast.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), { label: 'open modal' });

  // The one-off modal (a unique insertion signature) is captured.
  expect(delta.nodes.some((n) => n.role === 'dialog' || n.name === 'Modal')).toBe(true);
  // The recurring background toasts were dropped, so the delta stays tiny (~the modal),
  // not modal + N toast subtrees.
  expect(delta.nodes.length).toBeLessThanOrEqual(3);
  expect(delta.stats.droppedBackground, 'toasts counted as dropped background').toBeGreaterThan(0);
});
