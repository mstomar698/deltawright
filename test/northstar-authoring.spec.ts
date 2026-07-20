import { test, expect } from '@playwright/test';
import { actAndObserve, pageMap, renderPageMap } from '../src/index';
import { observeEffectSettled } from '../src/wait/index';
import { scoreSelectors } from '../src/matchers/score-selectors';
import { NORTHSTAR_AUTHORING_FIXTURE_URL } from './helpers';

// The chapter's north-star proof (plan §4): the three authoring primitives COMPOSE on one poor-a11y,
// RPC-style flow — readiness (observeEffectSettled) → the picture (pageMap) → the durable handle
// (scoreSelectors) — each doing what vanilla Playwright can't do as smoothly.

test('north-star: readiness + picture + durable handle compose on a poor-a11y RPC flow', async ({
  page,
}) => {
  await page.goto(NORTHSTAR_AUTHORING_FIXTURE_URL);

  // (1) READINESS — observeEffectSettled waits for the click's OWN 250ms-delayed, no-network effect to
  //     land and settle. No static sleep; no networkidle guess (there is no network to wait on).
  const settled = await observeEffectSettled(page, (p) => p.click('#load'));
  expect(settled.effectAppeared, 'the delayed effect was observed').toBe(true);
  expect(settled.hitMaxWait, 'it settled (not an inconclusive cap)').toBe(false);
  expect(settled.appearedMs, 'the effect appeared ~250ms in, not at t0').toBeGreaterThanOrEqual(
    200,
  );
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible(); // the panel actually landed

  // Reload to a clean state and capture the SAME effect as a delta (for the picture + the handle).
  await page.reload();
  const delta = await actAndObserve(page, (p) => p.click('#load'), { label: 'load' });

  // (2) THE PICTURE — pageMap sees the settled poor-a11y panel: the div-soup buttons are actionable,
  //     the occluded one is NAMED covered (where an ARIA snapshot + boundingBox can't), and the just-
  //     changed nodes are marked *added*.
  const map = await pageMap(page, { delta });
  const discard = map.nodes.find((n) => n.name === 'Discard')!;
  expect(discard.geometry.coveredBy, 'pageMap names the covered control').toBeTruthy();
  const retry = map.nodes.find((n) => n.name === 'Retry')!;
  expect(retry.geomActionable, 'the div-soup role=button reads reachable').toBe('ACTIONABLE');
  expect(
    map.nodes.filter((n) => n.recency === 'added').length,
    'the just-added controls are marked',
  ).toBeGreaterThan(0);
  // The rendered map is a compact, screenshot-equivalent artifact that CARRIES the occlusion signal —
  // the covered control is named covered-by in the text, not just in the object.
  const rendered = renderPageMap(map);
  expect(rendered).toMatch(/page-map @/);
  expect(rendered).toMatch(/Discard.*covered-by/);

  // (3) THE DURABLE HANDLE — scoreSelectors hands back a durable selector for the changed node, and
  //     surfaces which handles are brittle. The native "Save" role+name grades durable and is chosen.
  const scored = await scoreSelectors(page, delta);
  const save = scored.selectors.find((s) => s.tier === 'role' && /'Save'/.test(s.code))!;
  expect(save, 'a role selector for Save exists').toBeTruthy();
  expect(save.verified).toBe(true);
  expect(save.grade).toBe('durable');
  expect(scored.bestDurable, 'a durable handle is offered').toBeTruthy();
  expect(scored.bestDurable!.verified).toBe(true);
  expect(scored.bestDurable!.grade).not.toBe('brittle');
  // Honest throughout: durability is labeled an estimate.
  expect(scored.warnings.join('\n')).toMatch(/ESTIMATE/);

  // Reality check: the durable handle scoreSelectors chose actually resolves to a real, usable control.
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});
