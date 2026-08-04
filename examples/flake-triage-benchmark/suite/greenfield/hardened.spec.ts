import { test, expect } from '@playwright/test';
import { dwMatchers, preflight } from 'deltawright/matchers';
import { openFlow, seq } from '../support/app';

// The PER-TEST band, applied to exactly the fault classes the zero-edit reporter structurally can't name:
// input-commit loss (silent in the control) and pre-action actionability (named at the assertion site).
expect.extend(dwMatchers);

// --- input-commit gate: catches the debounce-clear the control ships GREEN, and names mask-truncate ---
for (const n of seq(20)) {
  const note = `note-${n}-persisted`;
  const title = `record > notes [${n}]`; // same title ⇒ same injected fault (input-debounce-clear)
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#notes', note);
    // The gate the control lacks: did the async widget keep the value? (debounce-clear → never-committed)
    await expect(page.locator('#notes')).toHaveCommittedValue(note);
    await page.click('#save');
    await expect(page.locator('#save-ok')).toBeVisible();
  });
}

for (const n of seq(16)) {
  const card = `411111${n}${n}`;
  const title = `record > card [${n}]`; // input-mask-truncate
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#card', card);
    await expect(page.locator('#card')).toHaveCommittedValue(card); // truncated → loss shape, named
    await page.click('#save');
    await expect(page.locator('#save-ok')).toBeVisible();
  });
}

// --- preflight: name WHY not-actionable at the assertion site (disabled / covered), pre-action ---
for (const n of seq(12)) {
  const title = `login > enable [${n}]`; // disabled-stuck
  test(title, async ({ page }) => {
    await openFlow(page, title, '/login');
    await page.fill('#username', `u${n}`);
    await page.fill('#password', `p${n}`);
    const r = await preflight(page.locator('#submit'));
    // Instead of a bare "toBeEnabled failed", DW names the reason (verdict stays Playwright's).
    expect(r.verdict, `preflight reason: ${r.reason ?? ''}`).toBe('ACTIONABLE');
    await page.click('#submit');
    await expect(page.locator('#signed-in')).toBeVisible();
  });
}

for (const n of seq(18)) {
  const title = `modal > confirm [${n}]`; // covered-overlay
  test(title, async ({ page }) => {
    await openFlow(page, title, '/modal');
    await page.click('#open');
    await expect(page.locator('[role=dialog]')).toBeVisible();
    const r = await preflight(page.locator('#confirm'));
    expect(r.verdict, `preflight reason: ${r.reason ?? ''}`).toBe('ACTIONABLE');
    await page.click('#confirm');
    await expect(page.locator('#confirmed')).toBeVisible();
  });
}
