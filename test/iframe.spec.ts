import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { actAndObserve } from '../src/index';
import { startStaticServer, type StaticServer } from '../bench/static-server';

// Regression suite for same-origin iframe traversal (#34). Served over HTTP so the
// parent and child iframe share an origin (file:// iframes are cross-origin in
// Chromium). The action inserts a dialog into the child frame's document.

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let server: StaticServer;

test.beforeAll(async () => {
  server = await startStaticServer(fixturesDir);
});
test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(`${server.origin}/iframe.html`);
  await page.frameLocator('#f').locator('body').waitFor({ timeout: 3000 });
});

test('with frames:true, a change inside a same-origin iframe is captured + offset', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'open in iframe',
    frames: true,
    maxWaitMs: 800,
  });

  const dialog = delta.nodes.find((n) => n.name === 'Iframe dialog' || n.role === 'dialog');
  expect(dialog, 'iframe dialog should be captured').toBeTruthy();
  // Ref is namespaced to the frame, and geometry is offset to page-global coordinates
  // (the iframe sits below the button, so the dialog's global y clears the header).
  expect(dialog!.ref).toMatch(/^f\d/);
  expect(dialog!.geometry!.rect.y).toBeGreaterThan(40);
  expect(dialog!.parentRef === null || /^f\d/.test(dialog!.parentRef)).toBe(true);
});

test('without frames (default), the iframe change is not observed (path unchanged)', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'open',
    maxWaitMs: 800,
  });
  expect(delta.nodes.find((n) => n.name === 'Iframe dialog')).toBeUndefined();
});
