import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { suggestAssertions } from '../src/matchers/suggest-assertions';
import type { SynthesizedAssertion } from '../src/matchers/suggest-assertions';
import { SUGGEST_ASSERTIONS_FIXTURE_URL } from './helpers';

// Testgen A: suggestAssertions — turn a delta's OBSERVED transitions into candidate, live-verified
// assertions bound to durable selectors. The a11y tree shows static state; DW knows the old→new edge.

const find = (as: SynthesizedAssertion[], substr: string) =>
  as.find((a) => a.code.includes(substr));

test.beforeEach(async ({ page }) => {
  await page.goto(SUGGEST_ASSERTIONS_FIXTURE_URL);
});

test('maps state / presence / announcement transitions to the right candidate assertions', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  const { assertions } = await suggestAssertions(page, delta);

  // aria-expanded false→true → toBeExpanded(), and it still holds on the live re-read.
  const expanded = find(assertions, 'toBeExpanded');
  expect(expanded, 'a toBeExpanded assertion was synthesized').toBeTruthy();
  expect(expanded!.code).toContain("getByRole('button', { name: 'Menu' })");
  expect(expanded!.kind).toBe('state');
  expect(expanded!.holds).toBe(true);
  expect(expanded!.transient).toBe(false);

  // aria-checked false→true on a role=checkbox → toBeChecked() (NOT toHaveAttribute — the role gate).
  const checked = find(assertions, 'toBeChecked');
  expect(checked, 'a toBeChecked assertion was synthesized').toBeTruthy();
  expect(checked!.holds).toBe(true);

  // disabled removed → toBeEnabled().
  const enabled = find(assertions, 'toBeEnabled');
  expect(enabled, 'a toBeEnabled assertion was synthesized').toBeTruthy();
  expect(enabled!.holds).toBe(true);

  // a role=dialog appeared → toBeVisible() on the new container.
  const visible = assertions.find(
    (a) => a.code.includes('toBeVisible') && a.code.includes('Confirm'),
  );
  expect(visible, 'a toBeVisible assertion for the dialog was synthesized').toBeTruthy();
  expect(visible!.kind).toBe('presence');
  expect(visible!.holds).toBe(true);

  // an aria-live region announced text → toContainText(observed).
  const text = find(assertions, 'toContainText');
  expect(text, 'a toContainText assertion was synthesized').toBeTruthy();
  expect(text!.kind).toBe('text');
  expect(text!.holds).toBe(true);
});

test('a removed node becomes a toHaveCount(0) post-condition', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  const { assertions } = await suggestAssertions(page, delta);

  const gone = find(assertions, 'toHaveCount(0)');
  expect(gone, 'a toHaveCount(0) assertion for the removed node was synthesized').toBeTruthy();
  expect(gone!.code).toContain("getByRole('button', { name: 'Delete' })");
  expect(gone!.holds).toBe(true); // the node really is gone
});

test('flags a reverted transition as `transient` (surfaced, not dropped) rather than a stable post-condition', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  // Revert #flash's aria-expanded AFTER the delta captured the false→true edge, before synthesizing.
  await page.evaluate(() =>
    document.getElementById('flash')!.setAttribute('aria-expanded', 'false'),
  );

  const { assertions, warnings } = await suggestAssertions(page, delta);
  const flash = assertions.find(
    (a) => a.code.includes('toBeExpanded') && a.code.includes("name: 'Flash'"),
  );
  expect(flash, 'the Flash toBeExpanded assertion is present').toBeTruthy();
  // The state reverted on the live re-read → holds:false, transient:true — surfaced, never silently dropped.
  expect(flash!.holds).toBe(false);
  expect(flash!.transient).toBe(true);
  expect(warnings.join('\n')).toMatch(/transient/);
});

test('HONESTY: every assertion is a labeled CANDIDATE, holding-first ranked; DW grounds, never authors', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  const { assertions, warnings } = await suggestAssertions(page, delta);

  // Every assertion carries its provenance (the observed transition) and a live-verify result.
  for (const a of assertions) {
    expect(a.from.length).toBeGreaterThan(0);
    expect(a).toHaveProperty('holds');
    expect(a).toHaveProperty('transient');
    // paste-ready code, never a claim of correctness — plain Playwright expect() the caller runs.
    expect(a.code).toMatch(/^await expect\(/);
  }
  // Holding assertions rank before transient ones.
  const firstTransientIdx = assertions.findIndex((a) => a.transient);
  const lastHoldingIdx = assertions.map((a) => a.holds === true).lastIndexOf(true);
  if (firstTransientIdx >= 0) expect(firstTransientIdx).toBeGreaterThan(lastHoldingIdx - 1);
  // The honesty caveat is explicit: candidate, not authored, Playwright authoritative.
  expect(warnings.join('\n')).toMatch(/CANDIDATE/);
  expect(warnings.join('\n')).toMatch(/does not author/i);
});
