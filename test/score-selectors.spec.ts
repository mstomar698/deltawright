import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { scoreSelectors } from '../src/matchers/score-selectors';
import type { ScoredSelectorSuggestion } from '../src/matchers/score-selectors';
import { SCORE_SELECTORS_FIXTURE_URL } from './helpers';

// R3: scoreSelectors — a durability ESTIMATE + brittleness flags over verifySuggestions, plus a
// delta-anchored geometry-relative fallback. Each case targets a distinct durability pathology.

const forRef = (sels: ScoredSelectorSuggestion[], ref: string, tier?: string) =>
  sels.filter((s) => s.ref === ref && (tier ? s.tier === tier : true));

test.beforeEach(async ({ page }) => {
  await page.goto(SCORE_SELECTORS_FIXTURE_URL);
});

test('grades a verified role+name selector DURABLE and picks it as bestDurable', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);

  const save = delta.nodes.find((n) => n.name === 'Save')!;
  const roleCand = forRef(result.selectors, save.ref, 'role')[0]!;
  expect(roleCand.verified).toBe(true);
  expect(roleCand.grade).toBe('durable');
  expect(roleCand.durability).toBeGreaterThanOrEqual(90);
  expect(roleCand.flags).not.toContain('unstable-id');

  // bestDurable is verified + non-brittle.
  expect(result.bestDurable).toBeTruthy();
  expect(result.bestDurable!.verified).toBe(true);
  expect(result.bestDurable!.grade).not.toBe('brittle');
});

test('flags a generated-id accessible name as unstable-id and grades it brittle (even though verified)', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);

  const item = delta.nodes.find((n) => n.name === 'item-10847')!;
  const roleCand = forRef(result.selectors, item.ref, 'role')[0]!;
  // It verifies uniquely (Playwright authoritative) …
  expect(roleCand.verified).toBe(true);
  // … but the NAME is a generated id, so durability is low and it's flagged + graded brittle.
  expect(roleCand.flags).toContain('unstable-id');
  expect(roleCand.grade).toBe('brittle');
  expect(roleCand.durability).toBeLessThan(40);
});

test('demotes ambiguous selectors (two identical Delete buttons)', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);

  const del = delta.nodes.find((n) => n.name === 'Delete')!;
  const roleCand = forRef(result.selectors, del.ref, 'role')[0]!;
  expect(roleCand.status).toBe('ambiguous');
  expect(roleCand.flags).toContain('ambiguous');
  expect(roleCand.grade).toBe('brittle');
});

test('flags a text-volatile name (contains an order number)', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);

  const order = delta.nodes.find((n) => n.name === 'Order #10847')!;
  const textCand = forRef(result.selectors, order.ref, 'text')[0]!;
  expect(textCand.flags).toContain('text-volatile');
  expect(textCand.durability).toBeLessThan(textCand.tier === 'text' ? 70 : 100);
});

test('synthesizes a geometry-relative fallback (verified, flagged, graded brittle) when nothing semantic verifies', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);

  // The unnamed input next to "Save" — getByRole('textbox') is ambiguous (two inputs), so it has no
  // verified semantic selector; a geometry-relative fallback is synthesized and anchored on "Save".
  const nearInput = delta.nodes.find(
    (n) => n.tag === 'input' && n.geometry && n.geometry.rect.y < 200,
  )!;
  expect(nearInput, 'the near input is in the delta').toBeTruthy();
  // It has NO verified semantic candidate …
  const semantic = result.selectors.filter((s) => s.ref === nearInput.ref && !s.synthesized);
  expect(semantic.every((s) => !s.verified)).toBe(true);
  // … so a synthesized geometry-relative candidate exists, is verified, flagged, and graded brittle
  // (a last-resort handle — never presented as durable).
  const geom = result.selectors.find((s) => s.ref === nearInput.ref && s.synthesized);
  expect(geom, 'a geometry-relative fallback was synthesized').toBeTruthy();
  expect(geom!.flags).toContain('geometry-relative');
  expect(geom!.code).toContain(':near(:text(');
  expect(geom!.code).toContain('Save');
  expect(geom!.verified).toBe(true);
  expect(geom!.grade).toBe('brittle');
  // Reality check: the synthesized layout locator actually resolves to exactly the near input.
  await expect(page.locator('input:near(:text("Save"))')).toHaveCount(1);
});

test('HONESTY: durability is labeled a single-page ESTIMATE, never cross-release stability', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta);
  const w = result.warnings.join('\n');
  expect(w).toMatch(/ESTIMATE/);
  expect(w).toMatch(/NOT a guarantee of stability across releases/i);
  // No suggestion object claims cross-render stability.
  for (const s of result.selectors) {
    expect(s).not.toHaveProperty('stable');
    expect(s).not.toHaveProperty('stableAcrossReleases');
  }
});

test('geometryFallback:false suppresses synthesis (opt-out)', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const result = await scoreSelectors(page, delta, { geometryFallback: false });
  expect(result.selectors.some((s) => s.synthesized)).toBe(false);
});
