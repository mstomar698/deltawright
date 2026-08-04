import { test, expect } from '@playwright/test';

// Fair test for diagnose-trace's NETWORK route: a click triggers a detail fetch that returns 500 after
// ~500ms — so the 5xx arrives INSIDE the failing assertion's own window (unlike the click-then-assert
// pattern where it lands one action early). diagnose-trace should now window-correlate it → route BACKEND.
for (const n of [1, 2, 3]) {
  test(`network > fetch detail [${n}]`, async ({ page }) => {
    await page.goto('/?fault=backend-slow-500#/detail');
    await page.click('#load-detail');
    await expect(page.locator('#detail')).toBeVisible(); // never appears; the 5xx is in this window
  });
}
