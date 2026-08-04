import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// MODAL — `cancel` clean; `confirm` = the covered-overlay target (glass intercepts the real Confirm click).

for (const n of seq(12)) {
  const title = `modal > cancel [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/modal');
    await page.click('#open');
    await expect(page.locator('[role=dialog]')).toBeVisible();
    await page.click('#cancel');
    await expect(page.locator('#confirmed')).toHaveCount(0);
  });
}

for (const n of seq(18)) {
  const title = `modal > confirm [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/modal');
    await page.click('#open');
    await expect(page.locator('[role=dialog]')).toBeVisible();
    // `covered-overlay` drops a transparent glass over the real Confirm → the click is intercepted.
    await page.click('#confirm');
    await expect(page.locator('#confirmed')).toBeVisible();
  });
}
