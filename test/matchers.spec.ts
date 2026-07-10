import { test, expect } from '@playwright/test';
import { preflight, dwMatchers } from '../src/matchers';

// Preflight actionability matcher (#53). A ground-truth wrapper on Playwright's own role-aware
// verdict, standalone (no actAndObserve). Geometry only annotates the disagreement; it never flips
// the boolean (DW-02). These cover the four acceptance criteria.

expect.extend(dwMatchers);

// A single page with a plain button, a disabled button, a read-only input, and an input fully
// covered by a higher overlay (fillable by Playwright, blocked to the geometry hit-test).
const PAGE = `
  <button id="ok">OK</button>
  <button id="disabled" disabled>Disabled</button>
  <input id="readonly" value="x" readonly />
  <div style="position: relative; height: 80px;">
    <input id="covered" style="position:absolute; left:20px; top:20px; width:160px; height:28px;" />
    <div style="position:absolute; left:10px; top:10px; width:200px; height:52px; background:rgba(0,0,0,.4);"></div>
  </div>
`;

test('should_pass_iff_the_role_aware_playwright_probe_succeeds', async ({ page }) => {
  await page.setContent(PAGE);

  // Actionable button → passes; the role-aware probe (click trial) succeeds.
  await expect(page.locator('#ok')).toBeActionable();

  // Disabled button → NOT-actionable (the click probe fails). `.not` passes.
  await expect(page.locator('#disabled')).not.toBeActionable();
  const dis = await preflight(page.locator('#disabled'));
  expect(dis.verdict).toBe('NOT-actionable');

  // Read-only input → the role-aware probe uses `fill` (visible + editable); read-only fails it.
  await expect(page.locator('#readonly')).not.toBeActionable();
  const ro = await preflight(page.locator('#readonly'));
  expect(ro.verdict).toBe('NOT-actionable');
  expect(ro.reason).toBe('read-only');
});

test('should_surface_geom_disagreement_without_overriding_the_verdict', async ({ page }) => {
  await page.setContent(PAGE);

  // A covered input: `fill` has no hit-test, so Playwright can fill it (ACTIONABLE), but geometry's
  // elementFromPoint hits the overlay (NOT-actionable). The verdict stays Playwright's (never
  // overridden by geometry), and the disagreement is surfaced.
  const r = await preflight(page.locator('#covered'));
  expect(r.verdict).toBe('ACTIONABLE'); // Playwright wins — geometry did NOT flip it (DW-02)
  expect(r.geometryVerdict).toBe('NOT-actionable'); // geometry saw the cover
  expect(r.agreed).toBe(false); // …and the disagreement is reported

  // The matcher passes (verdict is ACTIONABLE); the [geom:] hint would ride the `.not` message.
  await expect(page.locator('#covered')).toBeActionable();
  const m = await dwMatchers.toBeActionable(page.locator('#covered'));
  expect(m.pass).toBe(true);
  expect(m.message()).toContain('[geom:NOT-actionable]');
});

test('should_work_standalone_without_a_prior_actAndObserve', async ({ page }) => {
  // No actAndObserve / arm / collect anywhere — preflight injects its own probe on demand.
  await page.setContent(PAGE);
  const ok = await preflight(page.locator('#ok'));
  expect(ok.verdict).toBe('ACTIONABLE');
  expect(ok.geometryVerdict).toBe('ACTIONABLE'); // geometry read succeeded standalone
  expect(ok.agreed).toBe(true);
});

test('should_degrade_to_playwright_only_under_csp_or_non_chromium', async ({ page }) => {
  // A strict CSP blocks addScriptTag, so the observer can't be injected → no geometry annotation.
  // The verdict is still Playwright's own (its probe needs no injection), so the matcher still works.
  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'" />
    <button id="ok">OK</button>
  `);
  const r = await preflight(page.locator('#ok'));
  expect(r.verdict).toBe('ACTIONABLE'); // Playwright-only verdict survives CSP
  expect(r.geometryVerdict).toBe('n/a'); // geometry unavailable (injection blocked)
  expect(r.agreed).toBe(true); // n/a can't disagree
  await expect(page.locator('#ok')).toBeActionable();
});
