import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// DASHBOARD — filter / sort / paginate / row actions are clean; `flaky load` is the flaky-appear target.

const TERMS = ['00', '01', '02', '03', '04', '05', '10', '11', '15', '20', '22', '25', '30', '33',
  'Item', 'tem 0', 'Item 0', 'Item 1', 'Item 2', 'Item 3', 'em 1', 'm 2', ' 0', ' 1', ' 2', ' 3',
  '0', '1', '2', '3'];

for (const term of TERMS) {
  const title = `dashboard > filter [${term}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/dashboard');
    await expect(page.locator('#tbl')).toBeVisible();
    await page.fill('#filter', term);
    // Every visible name must contain the term (the filter contract).
    const names = await page.locator('#tbl .name').allInnerTexts();
    for (const nm of names) expect(nm.toLowerCase()).toContain(term.toLowerCase());
  });
}

for (const col of ['id', 'name', 'status', 'amount']) {
  for (const dir of ['asc', 'desc']) {
    const title = `dashboard > sort [${col} ${dir}]`;
    test(title, async ({ page }) => {
      await openFlow(page, title, '/dashboard');
      await expect(page.locator('#tbl')).toBeVisible();
      await page.click(`th[data-sort="${col}"]`);
      if (dir === 'desc') await page.click(`th[data-sort="${col}"]`);
      await expect(page.locator('#tbl tbody tr').first()).toBeVisible();
    });
  }
}

for (const p of seq(4)) {
  const title = `dashboard > paginate [${p}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/dashboard');
    await expect(page.locator('#tbl')).toBeVisible();
    for (let i = 1; i < p; i++) await page.click('#next');
    await expect(page.locator('#page')).toHaveText(String(p));
  });
}

for (const id of seq(24)) {
  const title = `dashboard > row action [${id}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/dashboard');
    await expect(page.locator('#tbl')).toBeVisible();
    const row = page.locator(`#tbl tr[data-id="1"]`);
    await expect(row).toBeVisible();
    await row.locator('.del').click();
    await expect(page.locator(`#tbl tr[data-id="1"]`)).toHaveCount(0);
  });
}

for (const n of seq(20)) {
  const title = `dashboard > flaky load [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/dashboard');
    // A tight visibility budget: healthy load is instant, the flaky-appear fault sometimes overruns it.
    await expect(page.locator('#tbl')).toBeVisible({ timeout: 800 });
  });
}
