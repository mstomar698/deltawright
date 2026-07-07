import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { fixtureUrl } from './helpers';

// Regression suite for open shadow-DOM traversal (#19). The button and the dialog it
// inserts both live inside a web component's OPEN shadow root — a MutationObserver on
// the document does not see them unless it is attached into the shadow root too.

test('changes inside an open shadow root are captured, positioned, and probed', async ({
  page,
}) => {
  await page.goto(fixtureUrl('shadow.html'));

  // Playwright CSS pierces open shadow DOM, so #open resolves to the shadow button.
  const delta = await actAndObserve(page, (p) => p.locator('#open').click(), {
    label: 'open shadow',
  });

  // The dialog was appended INSIDE the shadow root — captured only because the observer
  // is attached there.
  const dialog = delta.nodes.find((n) => n.role === 'dialog' || n.name === 'Shadow dialog');
  expect(dialog, 'shadow-DOM dialog should be captured').toBeTruthy();
  expect(dialog!.geometry!.rect.width).toBeGreaterThan(200); // real geometry inside shadow

  // Its interactive child was reported and probed (Playwright pierces the shadow ref).
  const ok = delta.nodes.find((n) => n.name === 'OK');
  expect(ok, 'shadow OK button should be reported').toBeTruthy();
  expect(ok!.actionability.verdict).toBe('ACTIONABLE');
});
