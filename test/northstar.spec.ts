import { test, expect } from '@playwright/test';
import { actAndObserve, render } from '../src/index';
import type { DeltaNode } from '../src/host/types';
import { FIXTURE_URL } from './helpers';

// The v0.1 proof. Three controlled cases. For each we assert the delta reports
// geometry + actionability correctly, then attempt the REAL Playwright action and
// confirm the verdict matched reality (ACTIONABLE <=> the action actually works).

const byName = (nodes: DeltaNode[], name: string) => nodes.find((n) => n.name === name);
const refLocator = (page: import('@playwright/test').Page, ref: string) =>
  page.locator(`[data-dw-ref="${ref}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE_URL);
});

test('case 1 (north-star): popup delta is tiny, correct, and fully ACTIONABLE', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-popup'), {
    label: 'click "Open popup"',
  });

  // Dialog identified with role + accessible name + real geometry.
  const dialog = byName(delta.nodes, 'Session expired');
  expect(dialog, 'dialog should be identified').toBeTruthy();
  expect(dialog!.role).toBe('dialog');
  expect(dialog!.geometry!.rect.width).toBeGreaterThan(300);
  expect(dialog!.geometry!.rect.height).toBeGreaterThan(50);

  // Interactive children present and each ACTIONABLE.
  const renew = byName(delta.nodes, 'Renew');
  const cancel = byName(delta.nodes, 'Cancel');
  const pw = byName(delta.nodes, 'Password');
  for (const n of [renew, cancel, pw]) {
    expect(n, 'interactive child should be reported').toBeTruthy();
    expect(n!.actionability.verdict).toBe('ACTIONABLE');
  }

  // Geometry read and Playwright agree on every node.
  expect(delta.nodes.every((n) => n.actionability.agreed)).toBe(true);

  // Delta-first, not snapshot: few nodes, few raw records, token-tiny.
  expect(delta.nodes.length).toBeLessThanOrEqual(6);
  expect(delta.stats.rawRecords).toBeLessThanOrEqual(4);
  expect(delta.stats.hitMaxWait).toBe(false);
  expect(delta.stats.animationsAwaited).toBeGreaterThanOrEqual(1); // animation was handled
  expect(render(delta).tokens).toBeLessThan(200);

  // Reality check: real actions on ACTIONABLE nodes actually work — including the
  // non-button node this case ships (the textbox), so the verdict is proven against
  // the real action for more than just buttons.
  await refLocator(page, pw!.ref).fill('secret');
  expect(await refLocator(page, pw!.ref).inputValue()).toBe('secret');
  await refLocator(page, renew!.ref).click({ timeout: 1500 });
});

test('case 2: covered — Renew NOT-actionable (covered), Cancel ACTIONABLE, matches reality', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-covered'), {
    label: 'click "Open covered popup"',
  });

  const renew = byName(delta.nodes, 'Renew')!;
  const cancel = byName(delta.nodes, 'Cancel')!;

  expect(renew.actionability.verdict).toBe('NOT-actionable');
  expect(renew.actionability.reason).toMatch(/cover/i);
  expect(renew.actionability.agreed).toBe(true);

  expect(cancel.actionability.verdict).toBe('ACTIONABLE');

  // Reality check: a real click on the covered target is refused by Playwright,
  // and the exposed target is clickable.
  await expect(refLocator(page, renew.ref).click({ timeout: 800 })).rejects.toThrow();
  await refLocator(page, cancel.ref).click({ timeout: 1500 });
});

test('case 3: off-screen — NOT-actionable (off-screen), matches reality', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-offscreen'), {
    label: 'click "Insert off-screen"',
  });

  const panel = byName(delta.nodes, 'Hidden panel');
  const ghost = byName(delta.nodes, 'Ghost action')!;

  expect(panel, 'off-screen container should still be reported').toBeTruthy();
  expect(ghost.actionability.verdict).toBe('NOT-actionable');
  expect(ghost.actionability.reason).toMatch(/off-screen/i);
  expect(ghost.actionability.agreed).toBe(true);

  // Reality check: Playwright cannot act on the off-screen element either.
  await expect(refLocator(page, ghost.ref).click({ timeout: 800 })).rejects.toThrow();
});

test('case 4: disabled control — geometry disagrees, Playwright wins, disagreement surfaced', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open-disabled'), {
    label: 'click "Insert disabled control"',
  });

  const submit = byName(delta.nodes, 'Submit')!;

  // Playwright's verdict wins the disagreement.
  expect(submit.actionability.verdict).toBe('NOT-actionable');
  expect(submit.actionability.reason).toMatch(/disabled/i);

  // Geometry alone thought it was reachable — the disagreement is real, exposed on
  // the node, and rendered in the serialized delta.
  expect(submit.actionability.geometryVerdict).toBe('ACTIONABLE');
  expect(submit.actionability.agreed).toBe(false);
  expect(render(delta).text).toMatch(/\[geom:ACTIONABLE\]/);

  // Reality check: a real click on the disabled button is refused.
  await expect(refLocator(page, submit.ref).click({ timeout: 800 })).rejects.toThrow();
});
