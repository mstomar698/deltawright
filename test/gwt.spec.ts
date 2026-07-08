import { test, expect } from '@playwright/test';
import { actAndObserve, render, checksum } from '../src/index';
import { GWT_FIXTURE_URL } from './helpers';

// Legacy-GWT actionability (#41). A FAITHFUL SYNTHETIC reproduction of GWT's DOM + timing
// (deferred commands, glass overlay, self-reposition, delegated role-less DOM) — not
// compiled GWT. The honest, scoped claim (see docs/summaries/v0.5-gwt-legacy-findings.md):
//   - GENUINE win: a locator-free settle catches a deferred render when OBSERVING
//     consequences (no target to name). Cases A.
//   - DIAGNOSTIC (not a fix): surface glass coverage + [geom] disagreement; Playwright's
//     verdict still wins and is already correct. Cases B/C.
//   - HONEST LIMITS/GAPS, asserted not buried: role-less identification (D), the two-wave
//     silent under-report (E), the JS-recenter stale rect (F).
// Every baseline is paired with the idiomatic web-first steel-man; only cases that defeat
// idiomatic Playwright stand as wins.

// Regenerate after any intended delta change: run once, read the received hash, paste here.
const GWT_APPROVE_CHECKSUM = '8c6368552cc7d8c175966e97939857f620bdb7eaee80c883c71c5cb32a328524';

test('A: a deferred GWT render is caught by settle; a zero-wait read races and misses it', async ({
  page,
}) => {
  await page.goto(GWT_FIXTURE_URL);

  // GWT deferral fact: the node is NOT synchronously present after the click — a zero-wait
  // read (accessibility.snapshot / evaluate / coordinate math) races the setTimeout/rAF chain.
  const syncPresent = await page.evaluate(() => {
    (document.querySelector('[data-cmd=approve]') as HTMLElement).click();
    return document.querySelector('.panel') !== null;
  });
  expect(syncPresent, 'the deferred node is not synchronously present (GWT deferral)').toBe(false);

  // Deltawright's structural-quiescence settle is locator-free AND network-free: it waits
  // the deferred cascade out and captures the appeared node. This is the ONE win we
  // attribute to settle. (For a KNOWN target, idiomatic `expect(locator).toBeVisible()`
  // polls through the same deferral and also passes — so the win is scoped strictly to
  // observe-what-changed, where no locator can be named.)
  await page.goto(GWT_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=approve]'), {
    label: 'approve',
  });
  const appeared = delta.nodes.find((n) => n.kind === 'added' && n.tag === 'div' && n.geometry);
  expect(appeared, 'settle captured the deferred node').toBeTruthy();
  expect(delta.stats.hitMaxWait).toBe(false);
  // The hidden GWT history iframe never leaks into the delta.
  expect(delta.nodes.every((n) => n.tag !== 'iframe')).toBe(true);
});

test('B/C: glass coverage is surfaced (agreeing with Playwright); a disabled Confirm surfaces a [geom] disagreement', async ({
  page,
}) => {
  await page.goto(GWT_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=open]'), {
    label: 'open dialog',
  });

  // Refresh went inert => a changed node; geometry reports it covered by the glass, and
  // Playwright AGREES (covered) — a compact structured coverage fact, no [geom] tension.
  // DIAGNOSTIC + latency, explicitly NOT a correctness win: Playwright's own click already
  // refuses; Deltawright turns a post-hoc 30s hang into a sub-second labeled fact.
  const refresh = delta.nodes.find((n) => n.name === 'Refresh balance');
  expect(refresh, 'the covered refresh trigger is reported as a changed node').toBeTruthy();
  expect(refresh!.geometry?.coveredBy).toContain('gwt-PopupPanelGlass');
  expect(refresh!.actionability.verdict).toBe('NOT-actionable');
  expect(refresh!.actionability.agreed, 'geometry and Playwright agree it is covered').toBe(true);

  // Confirm (disabled) — geometry says reachable, Playwright says disabled => disagreement,
  // surfaced as [geom:ACTIONABLE] while Playwright's verdict still ships.
  const confirm = delta.nodes.find((n) => n.name === 'Confirm');
  expect(confirm!.actionability.verdict).toBe('NOT-actionable');
  expect(confirm!.actionability.geometryVerdict).toBe('ACTIONABLE');
  expect(confirm!.actionability.agreed).toBe(false);
  expect(render(delta).text).toContain('[geom:ACTIONABLE]');

  // Cancel is genuinely actionable (above the glass, enabled).
  const cancel = delta.nodes.find((n) => n.name === 'Cancel');
  expect(cancel!.actionability.verdict).toBe('ACTIONABLE');

  // Reality check: the covered refresh genuinely cannot be clicked (glass intercepts) —
  // Deltawright's NOT-actionable(covered) matched reality.
  let clickFailed = false;
  await page
    .locator('[data-cmd=refresh]')
    .click({ timeout: 1200 })
    .catch(() => {
      clickFailed = true;
    });
  expect(clickFailed, 'the covered refresh cannot actually be clicked').toBe(true);
});

test('D: a role-less delegated FlexTable expansion is reported structurally; idiomatic Playwright locates it by text', async ({
  page,
}) => {
  // Steel-man: idiomatic Playwright needs no roles — text locators + auto-wait pass.
  await page.goto(GWT_FIXTURE_URL);
  await page.getByText('Order 1001').click();
  await expect(page.getByText('$412.00')).toBeVisible();

  await page.goto(GWT_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('td[data-cmd=expand]'), {
    label: 'expand',
  });
  const row = delta.nodes.find((n) => n.kind === 'added' && n.tag === 'tr');
  expect(row, 'the detail row is reported as an added structural node').toBeTruthy();
  // Honest limit: Deltawright invents no semantics GWT omitted — role and name stay null.
  expect(row!.role).toBeNull();
  // A getByRole-only agent finds nothing (the naive failure) — but that is not a Playwright
  // failure, and Deltawright's textContent name is the same handle getByText already uses.
  expect(await page.getByRole('button').count()).toBe(0);
});

test('E (honest gap): a two-wave render whose gap exceeds quietMs silently under-reports wave 2', async ({
  page,
}) => {
  await page.goto(GWT_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=twowave]'), {
    label: 'two-wave',
  });

  expect(
    delta.nodes.some((n) => n.kind === 'added'),
    'wave 1 is captured',
  ).toBe(true);
  // Wave 2 arrives after the 120ms structural-quiet window, so settle resolves on wave 1
  // and MISSES it — and the failure is SILENT: hitMaxWait is false, no suspected-miss line.
  const sawWave2 = delta.nodes.some((n) => n.geometry !== null && n.geometry.rect.y >= 300);
  expect(sawWave2, 'wave 2 is silently dropped (known settle gap)').toBe(false);
  expect(delta.stats.hitMaxWait, 'no maxWait signal — the under-report is silent').toBe(false);
  expect(render(delta).text).not.toContain('SUSPECTED MISS');
});

test('F (honest gap): a JS-timer recenter beyond quietMs yields a stale annotated rect; a CSS transition does not', async ({
  page,
}) => {
  await page.goto(GWT_FIXTURE_URL);
  const js = await actAndObserve(page, (p) => p.click('[data-cmd=recenter-js]'), {
    label: 'js recenter',
  });
  const jsDlg = js.nodes.find((n) => n.kind === 'added' && n.tag === 'div' && n.geometry);
  expect(
    jsDlg!.geometry!.rect.x,
    'JS recenter (no animation) leaves a stale pre-center rect',
  ).toBeLessThan(200);
  expect(js.stats.animationsAwaited, 'getAnimations() is empty for JS style writes').toBe(0);

  await page.goto(GWT_FIXTURE_URL);
  const css = await actAndObserve(page, (p) => p.click('[data-cmd=recenter-css]'), {
    label: 'css recenter',
  });
  const cssDlg = css.nodes.find((n) => n.kind === 'added' && n.tag === 'div' && n.geometry);
  expect(
    cssDlg!.geometry!.rect.x,
    'CSS transition is awaited => correct centered rect',
  ).toBeGreaterThan(300);
  expect(css.stats.animationsAwaited, 'the transition is awaited').toBeGreaterThanOrEqual(1);
});

test('checksum: the deferred-observe delta matches a stable fingerprint (regression guard, NOT proof of GWT correctness)', async ({
  page,
}) => {
  await page.goto(GWT_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=approve]'), {
    label: 'approve',
  });
  // Asserts output == captured output — catches regressions (a dropped node, flipped
  // verdict, lost geometry). It says NOTHING about whether the fixture models a real app;
  // that needs calibration against a real portal trace.
  expect(checksum(delta)).toBe(GWT_APPROVE_CHECKSUM);
});
