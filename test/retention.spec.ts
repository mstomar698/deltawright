import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { scoreSelectors, measureRetention } from '../src/matchers/score-selectors';
import { RETENTION_FIXTURE_URL } from './helpers';

// R3 step 4: measureRetention — the two-snapshot MEASURED cross-render signal that upgrades
// scoreSelectors' single-page durability ESTIMATE. Build a delta + score it (snapshot A), then re-render
// and re-check each verified selector (snapshot B). Each control demonstrates a distinct verdict.

const forName = <T extends { code: string; tier: string }>(sels: T[], code: string) =>
  sels.filter((s) => s.code.includes(code) && s.tier === 'role');

test.beforeEach(async ({ page }) => {
  await page.goto(RETENTION_FIXTURE_URL);
});

test('measures retained / moved / ambiguous / lost across a re-render', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);

  // Every one of the four buttons verified uniquely on snapshot A (a precondition of the test).
  for (const name of ['Save', 'Submit', 'Publish', 'Cancel']) {
    const cand = forName(scored.selectors, `'${name}'`)[0];
    expect(cand, `${name} has a role candidate on snapshot A`).toBeTruthy();
    expect(cand!.verified, `${name} verified on snapshot A`).toBe(true);
  }

  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });

  const save = forName(result.selectors, "'Save'")[0]!;
  expect(save.retention).toBe('retained');
  expect(save.matchesAfter).toBe(1);
  expect(save.centerShift).not.toBeNull();
  expect(save.centerShift!).toBeLessThanOrEqual(250);
  expect(save.flags).toContain('retained');

  const submit = forName(result.selectors, "'Submit'")[0]!;
  expect(submit.retention).toBe('moved');
  expect(submit.matchesAfter).toBe(1);
  expect(submit.centerShift!).toBeGreaterThan(250);
  expect(submit.flags).toContain('moved-after-rerender');

  const publish = forName(result.selectors, "'Publish'")[0]!;
  expect(publish.retention).toBe('ambiguous');
  expect(publish.matchesAfter).toBe(2);
  expect(publish.flags).toContain('ambiguous-after-rerender');

  const cancel = forName(result.selectors, "'Cancel'")[0]!;
  expect(cancel.retention).toBe('lost');
  expect(cancel.matchesAfter).toBe(0);
  expect(cancel.grade).toBe('broken');
  expect(cancel.measuredDurability).toBe(0);
  expect(cancel.flags).toContain('lost-after-rerender');
});

test('re-resolves a SYNTHESIZED geometry-relative fallback (rawSelector path) and retains it', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);

  // The near input has no verified semantic selector (two textboxes → getByRole ambiguous), so it got a
  // synthesized `input:near(:text("Save"))` fallback (Save is its nearest verified anchor) that verified.
  // It carries a rawSelector — the handle measureRetention re-resolves.
  const synth = scored.selectors.find(
    (s) => s.synthesized && s.verified && s.rawSelector?.includes('Save'),
  );
  expect(synth, 'a Save-anchored synthesized fallback verified on snapshot A').toBeTruthy();
  expect(synth!.rawSelector, 'synthesized candidates carry the raw selector').toContain(':near(');

  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });
  // Save + both inputs stay put across the re-render → the layout locator re-resolves uniquely.
  const measuredSynth = result.selectors.find((s) => s.synthesized && s.code.includes('Save'));
  expect(measuredSynth, 'the Save-anchored synthesized selector was re-checked').toBeTruthy();
  expect(measuredSynth!.matchesAfter).toBe(1);
  expect(measuredSynth!.retention).toBe('retained');
});

test('reports a retentionRate and picks a non-brittle bestRetained', async ({ page }) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });

  // Of the re-checked selectors, only some retain → rate is a real fraction in (0, 1).
  expect(result.retentionRate).toBeGreaterThan(0);
  expect(result.retentionRate).toBeLessThan(1);

  // bestRetained is a retained, non-brittle selector — Save is the natural winner.
  expect(result.bestRetained).toBeTruthy();
  expect(result.bestRetained!.retention).toBe('retained');
  expect(result.bestRetained!.grade).not.toBe('brittle');
  expect(result.bestRetained!.code).toContain('Save');
});

test('folds the measurement into durability without inflating past the estimate cap', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });

  for (const s of result.selectors) {
    // measuredDurability stays in range and never exceeds a modest +10 confirmation nudge.
    expect(s.measuredDurability).toBeGreaterThanOrEqual(0);
    expect(s.measuredDurability).toBeLessThanOrEqual(100);
    if (s.retention === 'retained') {
      expect(s.measuredDurability).toBe(Math.min(100, s.estimatedDurability + 10));
    } else if (s.retention === 'lost') {
      expect(s.measuredDurability).toBe(0);
    } else {
      // moved / ambiguous only ever KNOCK DOWN the estimate.
      expect(s.measuredDurability).toBeLessThanOrEqual(s.estimatedDurability);
    }
  }
});

test('works without a reRender option (current DOM = snapshot B) and warns about it', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  // Re-render manually, THEN measure with no reRender option — the live DOM is snapshot B.
  await page.click('#rerender');
  const result = await measureRetention(page, delta, scored);

  expect(result.selectors.find((s) => s.code.includes("'Cancel'"))?.retention).toBe('lost');
  expect(result.warnings.join('\n')).toMatch(/no `reRender` supplied/);
});

test('HONESTY: measured across ONE observed re-render, never a cross-release guarantee', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });

  const w = result.warnings.join('\n');
  expect(w).toMatch(/MEASURED across the ONE re-render/);
  expect(w).toMatch(/NOT a guarantee of stability across future releases/i);
  // Identity is inferred, not proven — the caveat must be present.
  expect(w).toMatch(/object identity is INFERRED/i);
  // No result object claims cross-render/-release stability as a property.
  for (const s of result.selectors) {
    expect(s).not.toHaveProperty('stable');
    expect(s).not.toHaveProperty('stableAcrossReleases');
  }
});
