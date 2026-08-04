import { test, expect } from '@playwright/test';
import { openFlow, seq } from '../support/app';

// RECORD — `save` clean; `notes`/`card` = input-not-committed targets (value must persist); `post amount`
// = backend-500 target (save must succeed); `slow save` = the rpc-settle honesty trap (tight budget).

for (const n of seq(20)) {
  const title = `record > save [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#card', `40${n}`);
    await page.fill('#phone', `555000${n}`);
    await page.click('#save');
    await expect(page.locator('#save-ok')).toBeVisible();
  });
}

for (const n of seq(20)) {
  const note = `note-${n}-persisted`;
  const title = `record > notes [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#notes', note);
    await page.click('#save');
    await expect(page.locator('#save-ok')).toBeVisible();
    // The value must survive to submit — `input-debounce-clear` wipes it after the fill.
    await expect(page.locator('#notes')).toHaveValue(note);
  });
}

for (const n of seq(16)) {
  const card = `411111${n}${n}`; // > 4 chars
  const title = `record > card [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#card', card);
    await page.click('#save');
    await expect(page.locator('#save-ok')).toBeVisible();
    // `input-mask-truncate` silently clips the card past 4 chars.
    await expect(page.locator('#card')).toHaveValue(card);
  });
}

for (const n of seq(12)) {
  const title = `record > post amount [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#card', `40${n}`);
    await page.click('#save');
    // `backend-500` makes Save fail on the server — #save-ok never appears (a DOM timeout with a
    // backend root cause, the field-dominant class).
    await expect(page.locator('#save-ok')).toBeVisible();
  });
}

for (const n of seq(8)) {
  const title = `record > slow save [${n}]`;
  test(title, async ({ page }) => {
    await openFlow(page, title, '/record');
    await page.fill('#card', `40${n}`);
    await page.click('#save');
    // The rpc-settle honesty trap: the save DOES succeed, just late. A too-tight budget makes it fail
    // with NO DOM cause — DW must abstain / call it settle, never invent covered/disabled/etc.
    await expect(page.locator('#save-ok')).toBeVisible({ timeout: 300 });
  });
}
