import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { pageMap, renderPageMap } from '../src/host/page-map';
import type { PageMap, PageMapNode } from '../src/host/page-map';
import { PAGEMAP_FIXTURE_URL } from './helpers';

// R2 flagship proof. On a poor-a11y div-soup page with an overlay occluding one of two
// LOOK-ALIKE controls, pageMap must name the COVERED one as NOT-actionable (covered-by the
// overlay) and the identical UNCOVERED one as ACTIONABLE — a distinction an ARIA snapshot
// (two identical `button "Save"`) and boundingBox (two rects, no occlusion) cannot make.
// Every geometry verdict is then checked against the REAL Playwright action.

const saves = (m: PageMap): PageMapNode[] => m.nodes.filter((n) => n.name === 'Save');
const byName = (m: PageMap, name: string): PageMapNode | undefined =>
  m.nodes.find((n) => n.name === name);
const mapLoc = (page: Page, ref: string) => page.locator(`[data-dw-map-ref="${ref}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto(PAGEMAP_FIXTURE_URL);
});

test('flagship: names the covered look-alike NOT-actionable where ARIA + boundingBox cannot', async ({
  page,
}) => {
  const map = await pageMap(page);

  // Both look-alike "Save" controls are in the map.
  const [a, b] = saves(map).sort((x, y) => x.geometry.rect.y - y.geometry.rect.y);
  expect(a, 'top Save present').toBeTruthy();
  expect(b, 'bottom Save present').toBeTruthy();

  // The UNCOVERED one is reachable; the COVERED one is named NOT-actionable with the overlay.
  expect(a!.geomActionable).toBe('ACTIONABLE');
  expect(a!.geometry.coveredBy).toBeNull();

  expect(b!.geomActionable).toBe('NOT-actionable');
  expect(b!.geometry.coveredBy).toMatch(/glass/);
  expect(b!.actionabilityReason).toMatch(/covered-by/);
  expect(b!.geometry.hitSelf).toBe(false);

  // The contrast: an ARIA snapshot renders the two as IDENTICAL, indistinguishable entries …
  const aria = await page.locator('body').ariaSnapshot();
  const saveLines = aria.split('\n').filter((l) => /button "Save"/.test(l));
  expect(saveLines.length, 'ARIA snapshot shows two identical Save buttons').toBe(2);
  expect(new Set(saveLines.map((l) => l.trim())).size, 'and they are byte-identical').toBe(1);
  // … and boundingBox gives two rects but NO occlusion field to tell which is reachable.
  const boxA = await mapLoc(page, a!.ref).boundingBox();
  const boxB = await mapLoc(page, b!.ref).boundingBox();
  expect(boxA && boxB, 'boundingBox returns rects for both — but no coveredBy').toBeTruthy();

  // Reality check: the real Playwright actions match pageMap's geometry verdicts exactly.
  await mapLoc(page, a!.ref).click({ timeout: 1500 }); // uncovered → clickable
  await expect(mapLoc(page, b!.ref).click({ timeout: 800 })).rejects.toThrow(); // covered → refused
});

test('occlusion honesty: coveredBy is claimed only for hit-tested-covered nodes; stats match', async ({
  page,
}) => {
  const map = await pageMap(page);
  const covered = map.nodes.filter((n) => n.geometry.coveredBy !== null && !n.geometry.offscreen);
  // Only the two genuinely-occluded controls (Save-behind-glass, Background-behind-dialog).
  expect(covered.map((n) => n.name).sort()).toEqual(['Background action', 'Save']);
  // Every covered node's geometry verdict is NOT-actionable with a covered-by reason.
  for (const n of covered) {
    expect(n.geomActionable).toBe('NOT-actionable');
    expect(n.actionabilityReason).toMatch(/covered-by/);
  }
  // The stat never over-claims occlusion beyond what was hit-tested.
  expect(map.stats.occludedCount).toBe(covered.length);
});

test('apparent z-layers: dialog + its buttons are layer 1, the covered control stays layer 0', async ({
  page,
}) => {
  const map = await pageMap(page);

  const dialogNodes = ['OK', 'Dismiss'].map((n) => byName(map, n)!);
  for (const n of dialogNodes) {
    expect(n, 'dialog button present').toBeTruthy();
    expect(n.layer, `${n.name} is on the overlay layer`).toBe(1);
  }
  // The control the dialog paints over is BEHIND it — base layer, but covered-by the dialog.
  const bg = byName(map, 'Background action')!;
  expect(bg.layer).toBe(0);
  expect(bg.geometry.coveredBy).toBeTruthy();

  // The base look-alikes stay on layer 0.
  for (const s of saves(map)) expect(s.layer).toBe(0);

  // The layers summary carries the overlay and labels it from the dialog's accessible name.
  const overlay = map.layers.find((l) => l.layer === 1);
  expect(overlay, 'an overlay layer exists').toBeTruthy();
  expect(overlay!.label).toMatch(/Confirm changes/);
});

test('offscreen honesty: an off-screen control is marked, never dropped', async ({ page }) => {
  const map = await pageMap(page);
  const ghost = byName(map, 'Ghost action');
  expect(ghost, 'off-screen control is present, not silently dropped').toBeTruthy();
  expect(ghost!.geometry.offscreen).toBe(true);
  expect(ghost!.zone).toBe('offscreen');
  expect(ghost!.geomActionable).toBe('NOT-actionable');
  expect(map.stats.offscreenCount).toBeGreaterThanOrEqual(1);
  // Reality check: Playwright cannot act on it either.
  await expect(mapLoc(page, ghost!.ref).click({ timeout: 800 })).rejects.toThrow();
});

test('default verdicts are labeled geometry-derived (never presented as Playwright-authoritative)', async ({
  page,
}) => {
  const map = await pageMap(page);
  expect(map.reconciled).toBe(false);
  for (const n of map.nodes) {
    expect(n.reconciled).toBe(false);
    expect(n.geomDisagreesWithPlaywright).toBe(false); // no disagreement claim without a probe
  }
  const text = renderPageMap(map);
  expect(text).toMatch(/verdicts: geometry-derived/);
  expect(text).not.toMatch(/Playwright-authoritative/);
  // Self-honest per line: geometry-only mode never borrows Playwright's authoritative verdict words,
  // so a single excerpted line can't be mistaken for Playwright's judgment (DW-02).
  expect(text).toMatch(/reachable/);
  expect(text).toMatch(/covered-by div\.dw-glass/);
  expect(text).not.toMatch(/\bACTIONABLE\b/);
  expect(text).not.toMatch(/NOT-actionable/);
});

test('reconcile: Playwright wins, and a geometry disagreement is surfaced (not hidden)', async ({
  page,
}) => {
  const map = await pageMap(page, { reconcile: true });
  expect(map.reconciled).toBe(true);

  // The disabled "Locked" button: geometry sees a reachable topmost element; Playwright says
  // "not enabled" — the authoritative verdict wins and the disagreement is exposed.
  const locked = byName(map, 'Locked')!;
  expect(locked.geomActionable).toBe('ACTIONABLE');
  expect(locked.actionable).toBe('NOT-actionable');
  expect(locked.geomDisagreesWithPlaywright).toBe(true);
  expect(locked.actionabilityReason).toMatch(/disabled|enabled/i);

  // The covered "Save" agrees both ways (geometry + Playwright both NOT-actionable).
  const b = saves(map).sort((x, y) => x.geometry.rect.y - y.geometry.rect.y)[1]!;
  expect(b.actionable).toBe('NOT-actionable');
  expect(b.geomDisagreesWithPlaywright).toBe(false);

  // An uncovered, enabled control reconciles to ACTIONABLE with no disagreement.
  const cont = byName(map, 'Continue')!;
  expect(cont.actionable).toBe('ACTIONABLE');
  expect(cont.geomDisagreesWithPlaywright).toBe(false);

  // An OFF-SCREEN interactive node is NOT probed under reconcile — a trial-click would auto-scroll it
  // into view (fabricating a disagreement + polluting the captured scroll). It stays geometry-derived.
  const ghost = byName(map, 'Ghost action')!;
  expect(ghost.geometry.offscreen).toBe(true);
  expect(ghost.reconciled).toBe(false);
  expect(ghost.geomDisagreesWithPlaywright).toBe(false);

  // The rendered map declares authoritative verdicts and shows the disagreement token (in the
  // geometry vocabulary, so it can't read as a competing authoritative verdict).
  const text = renderPageMap(map);
  expect(text).toMatch(/verdicts: Playwright-authoritative/);
  expect(text).toMatch(/\[geom:reachable\]/);

  // Reality check: the real click on the disabled button is refused.
  await expect(mapLoc(page, locked.ref).click({ timeout: 800 })).rejects.toThrow();
});

test('recency fusion: composing pageMap after an action marks what just changed', async ({
  page,
}) => {
  // Toggle Continue's aria-pressed via the primitive, then map with the delta.
  const delta = await actAndObserve(
    page,
    (p) => p.getByRole('button', { name: 'Continue' }).click(),
    {
      label: 'click Continue',
    },
  );
  const map = await pageMap(page, { delta });
  const cont = byName(map, 'Continue')!;
  expect(cont, 'the acted node is in the map').toBeTruthy();
  expect(cont.recency, 'it is marked as changed by the fused delta').toBe('changed');
  // A node the action did not touch carries no recency (no fabricated change).
  const save = saves(map)[0]!;
  expect(save.recency).toBeNull();
  expect(renderPageMap(map)).toMatch(/\*changed\*/);
});

test('the map is token-cheap and deterministic across repeat scans', async ({ page }) => {
  const first = renderPageMap(await pageMap(page));
  const second = renderPageMap(await pageMap(page));
  // Stateless + idempotent: the same page yields the same map (refs are re-stamped in DOM order).
  expect(second).toBe(first);
  // A whole poor-a11y page in a compact, screenshot-equivalent map.
  expect(first.length).toBeLessThan(2000);
  expect(first).toMatch(/page-map @ 1280x720/);
});
