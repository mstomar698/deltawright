import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { fixtureUrl } from './helpers';

// Regression suite for the screenshot-diff fallback (#20). A canvas draw changes
// pixels but mutates no DOM, so the DOM delta is empty; the opt-in fallback diffs
// before/after screenshots and reports the changed region.

test('a canvas draw is empty in the DOM but captured by the screenshot fallback', async ({
  page,
}) => {
  await page.goto(fixtureUrl('canvas.html'));

  // Without the fallback: nothing mutates the DOM, so the delta is empty.
  const domOnly = await actAndObserve(page, (p) => p.click('#draw'), {
    label: 'draw',
    maxWaitMs: 500,
  });
  expect(domOnly.nodes).toHaveLength(0);

  // With the fallback: the changed canvas region is reported as a synthetic node.
  await page.goto(fixtureUrl('canvas.html'));
  const withFallback = await actAndObserve(page, (p) => p.click('#draw'), {
    label: 'draw',
    maxWaitMs: 500,
    screenshotFallback: true,
  });
  const region = withFallback.nodes.find((n) => n.tag === 'canvas-region');
  expect(region, 'screenshot-diff should report the changed region').toBeTruthy();
  expect(region!.actionability.verdict).toBe('n/a');
  expect(region!.geometry!.rect.width).toBeGreaterThan(50);
  expect(region!.geometry!.rect.height).toBeGreaterThan(50);
});
