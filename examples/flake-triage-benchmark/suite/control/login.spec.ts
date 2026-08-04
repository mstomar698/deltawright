import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// LOGIN — `sign in` = clean happy paths; `enable` = the disabled-stuck target (submit must enable).

for (const n of seq(14)) {
  const title = `login > sign in [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/login');
    await page.fill('#username', `user${n}`);
    await page.fill('#password', `pw${n}`);
    await expect(page.locator('#submit')).toBeEnabled();
    await page.click('#submit');
    await expect(page.locator('#signed-in')).toBeVisible();
  });
}

for (const n of seq(12)) {
  const title = `login > enable [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/login');
    await page.fill('#username', `u${n}`);
    await page.fill('#password', `p${n}`);
    // The healthy contract: filling both enables Sign in. `disabled-stuck` breaks exactly this.
    await expect(page.locator('#submit')).toBeEnabled();
    await page.click('#submit');
    await expect(page.locator('#signed-in')).toBeVisible();
  });
}
