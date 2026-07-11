import { test, expect } from '@playwright/test';
import { actAndObserve, serialize } from '../src/index';
import { fixtureUrl } from './helpers';

// Accessibility state surface (#8). Additive VALUE/direction for allowlisted state attributes + a
// live-region annotation — the "the menu is now open" the mutation delta's attr NAMES alone can't
// express. DW-02-safe (annotates the same nodes, no verdict change) + DW-03-safe (never relabels).

test('captures the aria-expanded VALUE transition on a no-structural-mutation toggle', async ({
  page,
}) => {
  await page.goto(fixtureUrl('aria-state.html'));
  const delta = await actAndObserve(page, (p) => p.click('#toggle'), { label: 'toggle' });

  const btn = delta.nodes.find((n) => n.kind === 'attrChanged' && n.tag === 'button');
  expect(btn, 'the button attrChanged node').toBeTruthy();
  // Today's surface (already shipped): the attr NAME changed.
  expect(btn!.changedAttrs).toContain('aria-expanded');
  // #8 adds the DIRECTION: false → true (the menu is now expanded).
  expect(btn!.stateChanges).toEqual([{ attr: 'aria-expanded', old: 'false', new: 'true' }]);
  // The label is untouched (DW-03: no relabel).
  expect(btn!.role).toBe('button');
  expect(btn!.ariaLive).toBeUndefined();

  // Serialized surface shows the direction, additively.
  expect(serialize(delta)).toContain('state:aria-expanded=false→true');
});

test('annotates a change inside a live region with its politeness', async ({ page }) => {
  await page.goto(fixtureUrl('aria-state.html'));
  const delta = await actAndObserve(page, (p) => p.click('#announce'), { label: 'announce' });

  // The appended message lives inside role=status / aria-live=polite → announced.
  const announced = delta.nodes.find((n) => n.ariaLive);
  expect(announced, 'a node inside the live region').toBeTruthy();
  expect(announced!.ariaLive).toBe('polite');
  expect(serialize(delta)).toContain('live:polite');
});

test('a plain change carries no a11y-state annotations (default surface byte-unchanged)', async ({
  page,
}) => {
  // The toggle button is NOT a live region and, on a non-state attribute, would carry no stateChanges.
  await page.goto(fixtureUrl('aria-state.html'));
  const delta = await actAndObserve(page, (p) => p.click('#announce'), { label: 'announce' });
  // The appended message is an ADDED node with no state attributes → no stateChanges.
  const msg = delta.nodes.find((n) => n.kind === 'added' && n.tag === 'div');
  expect(msg).toBeTruthy();
  expect(msg!.stateChanges).toBeUndefined();
});

test('a change in an aria-live="off" region is NOT annotated as announced', async ({ page }) => {
  await page.goto(fixtureUrl('aria-state.html'));
  const delta = await actAndObserve(page, (p) => p.click('#announce-off'), {
    label: 'announce off',
  });
  // The appended node is inside aria-live="off" — explicitly silenced, so no ariaLive (honesty).
  expect(delta.nodes.some((n) => n.ariaLive !== undefined)).toBe(false);
  expect(serialize(delta)).not.toContain('live:');
});

test('a present native boolean (disabled="") renders unambiguously, not as a blank', async ({
  page,
}) => {
  await page.goto(fixtureUrl('aria-state.html'));
  const delta = await actAndObserve(page, (p) => p.click('#toggle-disabled'), { label: 'disable' });
  const field = delta.nodes.find((n) => n.kind === 'attrChanged' && n.tag === 'input');
  expect(field, 'the input attrChanged node').toBeTruthy();
  // disabled went absent → present("") — the present side is the empty string, captured structurally.
  expect(field!.stateChanges).toEqual([{ attr: 'disabled', old: null, new: '' }]);
  // …and rendered as `∅→""`, never a truncated `∅→`.
  expect(serialize(delta)).toContain('state:disabled=∅→""');
});
