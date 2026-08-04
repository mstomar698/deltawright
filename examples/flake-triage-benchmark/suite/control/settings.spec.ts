import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// SETTINGS — `toggle` clean (just flips checkboxes); `apply` = the off-screen target (#apply parked off-screen).

for (const n of seq(20)) {
  const title = `settings > toggle [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/settings');
    if (n % 2) await page.check('#toggle-a');
    await page.check('#toggle-b');
    await expect(page.locator('#toggle-b')).toBeChecked();
  });
}

for (const n of seq(30)) {
  const title = `settings > apply [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/settings');
    if (n % 2) await page.check('#toggle-a');
    // `off-screen` parks #apply at a fixed off-viewport position → the click can't reach it.
    await page.click('#apply');
    await expect(page.locator('#status')).toHaveText('Saved');
  });
}
