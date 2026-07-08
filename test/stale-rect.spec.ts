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
  await page.goto(fixtureUrl('stale-rect.html'));
  const off = await actAndObserve(page, (p) => p.click('#open'), { label: 'open' });

  await page.goto(fixtureUrl('stale-rect.html'));
  const on = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'open',
    rectRecheckMs: 800,
  });

  // The rect annotation differs (stale vs adopted-later), but Playwright's verdict for the
  // moved node is identical — the re-read is annotation only.
  const vOff = mover(off.nodes)?.actionability.verdict;
  const vOn = mover(on.nodes)?.actionability.verdict;
  expect(vOff).toBe('ACTIONABLE');
  expect(vOn).toBe(vOff);
  // And the moved-rect flag really did change the annotation between the two runs.
  expect(mover(on.nodes)?.geometry?.stable).toBe(false);
  expect(mover(off.nodes)?.geometry && 'stable' in mover(off.nodes)!.geometry!).toBe(false);
});
