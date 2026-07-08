import { test, expect } from '@playwright/test';
import { actAndObserve, diagnose } from '../src/index';
import type { DeltaNode } from '../src/index';
import { fixtureUrl } from './helpers';

// Gap-F (#50): a JS-timer reposition after settle leaves a STALE annotated rect (getAnimations
// is empty for a plain style write). The opt-in rectRecheckMs re-reads and adopts the later
// rect + flags stale-rect-suspected, while the default annotation stays byte-unchanged. The
// re-check is geometry-only annotation, so it NEVER changes Playwright's verdict.

const mover = (nodes: DeltaNode[]) => nodes.find((n) => n.name === 'Mover');

test('should_flag_stale_rect_suspected_and_adopt_the_later_rect_when_a_js_recenter_moves_it', async ({
  page,
}) => {
  await page.goto(fixtureUrl('stale-rect.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'open',
    rectRecheckMs: 800,
  });

  const m = mover(delta.nodes);
  expect(m?.geometry?.stable).toBe(false);
  // Adopted the LATER rect (moved far right), not the stale settle-time rect (~100px).
  expect(m!.geometry!.rect.x).toBeGreaterThan(300);

  const diag = diagnose(delta).diagnoses.find((d) => d.code === 'stale-rect-suspected');
  expect(diag).toBeDefined();
  expect(diag?.confidence).toBe('suspected');
  expect(diag?.ref).toBe(m!.ref);
});

test('should_leave_annotated_rect_and_stats_unchanged_when_rectRecheckMs_is_zero', async ({
  page,
}) => {
  await page.goto(fixtureUrl('stale-rect.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), { label: 'open' });

  const m = mover(delta.nodes);
  // No `stable` key (absent, not false) and the rect is the settle-time (pre-move) position.
  expect(m?.geometry && 'stable' in m.geometry).toBe(false);
  expect(m!.geometry!.rect.x).toBeLessThan(300);
  expect(diagnose(delta).diagnoses.some((d) => d.code === 'stale-rect-suspected')).toBe(false);
});

test('should_never_let_the_re_read_change_the_verdict', async ({ page }) => {
  // The hard case: the node moves OFF-SCREEN after settle, which flips the GEOMETRY annotation.
  // Playwright's verdict must still be identical with and without the re-check, because the
  // authoritative probe runs at the settle point BEFORE the rectRecheck delay. Regression guard
  // for the review's probe-timing finding (delaying collect would have flipped the verdict).
  await page.goto(fixtureUrl('stale-rect.html'));
  const off = await actAndObserve(page, (p) => p.click('#offscreen'), { label: 'off' });

  await page.goto(fixtureUrl('stale-rect.html'));
  const on = await actAndObserve(page, (p) => p.click('#offscreen'), {
    label: 'off',
    rectRecheckMs: 900,
  });

  const nOff = mover(off.nodes);
  const nOn = mover(on.nodes);
  // Playwright's verdict is identical (probed at settle, before the move) — timing-invariant.
  expect(nOff?.actionability.verdict).toBe('ACTIONABLE');
  expect(nOn?.actionability.verdict).toBe('ACTIONABLE');
  // The re-read updated the geometry ANNOTATION to the off-screen position and re-derived the
  // (now legitimately disagreeing) geometry verdict — but Playwright's verdict is untouched.
  expect(nOn?.geometry?.stable).toBe(false);
  expect(nOn?.geometry?.offscreen).toBe(true);
  expect(nOn?.actionability.geometryVerdict).toBe('NOT-actionable');
  expect(nOn?.actionability.agreed).toBe(false);
  // OFF path is unaffected: on-screen annotation, no stale flag.
  expect(nOff?.geometry && 'stable' in nOff.geometry).toBe(false);
  expect(nOff?.geometry?.offscreen).toBe(false);
});
