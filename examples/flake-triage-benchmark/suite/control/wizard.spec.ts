import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// WIZARD — `step1` clean (first gate only); `complete` = the app-js-error target (handler throws).

for (const n of seq(12)) {
  const title = `wizard > step1 [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/wizard');
    await page.click('#next1');
    await expect(page.locator('#next2')).toBeVisible();
  });
}

for (const n of seq(16)) {
  const title = `wizard > complete [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/wizard');
    // `app-js-error` throws inside the #next1 handler → step 2 never renders → #next2 never appears.
    await page.click('#next1');
    await expect(page.locator('#next2')).toBeVisible();
    await page.click('#next2');
    await expect(page.locator('#wiz-done')).toBeVisible();
  });
}
