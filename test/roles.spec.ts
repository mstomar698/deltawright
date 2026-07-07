import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import type { DeltaNode } from '../src/host/types';
import { fixtureUrl } from './helpers';

// Regression suite for role-aware actionability probes (#17). The verdict must match
// the action an agent would actually use: a text input is fill'ed (no pointer
// hit-test), so a COVERED input is fillable while a READONLY one is not — the exact
// cases a click-only probe gets wrong.

const byName = (nodes: DeltaNode[], name: string) => nodes.find((n) => n.name === name)!;
const ref = (page: import('@playwright/test').Page, r: string) =>
  page.locator(`[data-dw-ref="${r}"]`);

test('verdicts match the real fill/select action, not a click probe', async ({ page }) => {
  await page.goto(fixtureUrl('roles.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open-form'), { label: 'open form' });

  const normal = byName(delta.nodes, 'Normal');
  const readonly = byName(delta.nodes, 'Readonly');
  const disabled = byName(delta.nodes, 'Disabled');
  const covered = byName(delta.nodes, 'Covered');
  const selNormal = byName(delta.nodes, 'Pick');
  const selDisabled = byName(delta.nodes, 'Disabled select');

  // A normal text input is fillable.
  expect(normal.actionability.verdict).toBe('ACTIONABLE');
  // A read-only input is NOT (click-only would wrongly say ACTIONABLE — you can click it).
  expect(readonly.actionability.verdict).toBe('NOT-actionable');
  expect(readonly.actionability.reason).toMatch(/read-only/i);
  // Disabled input: not editable.
  expect(disabled.actionability.verdict).toBe('NOT-actionable');
  expect(disabled.actionability.reason).toMatch(/disabled/i);
  // A COVERED input is still fillable (fill does not hit-test) — click-only would wrongly
  // say NOT-actionable. Geometry (pointer-model) disagrees, and that's surfaced.
  expect(covered.actionability.verdict).toBe('ACTIONABLE');
  expect(covered.actionability.agreed).toBe(false);
  expect(covered.actionability.geometryVerdict).toBe('NOT-actionable');

  // Selects.
  expect(selNormal.actionability.verdict).toBe('ACTIONABLE');
  expect(selDisabled.actionability.verdict).toBe('NOT-actionable');

  // Reality check: the real actions behave as the verdicts predicted.
  await ref(page, normal.ref).fill('hello');
  await ref(page, covered.ref).fill('through the overlay'); // succeeds despite cover
  await expect(ref(page, readonly.ref).fill('x', { timeout: 800 })).rejects.toThrow();
  await expect(ref(page, disabled.ref).fill('x', { timeout: 800 })).rejects.toThrow();
});
