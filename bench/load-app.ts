import type { Page } from '@playwright/test';
import { bundleApp } from './bundle-app';

export interface AppConfig {
  rows: number;
  noise: boolean;
  intervalMs: number;
}

const PAGE_SHELL =
  '<!doctype html><html><head><meta charset="utf-8" />' +
  '<style>body{font-family:system-ui;margin:16px;color:#111}' +
  'table{border-collapse:collapse;margin-top:12px}' +
  'td,th{border:1px solid #ccc;padding:2px 8px;font-size:13px;text-align:left}' +
  '.toolbar button{font-size:14px;padding:6px 12px}</style></head>' +
  '<body><div id="root"></div></body></html>';

/**
 * Load the bundled React app into the page with the given config. Config is set on
 * window before the bundle runs so the app reads it on mount.
 */
export async function loadReactApp(page: Page, config: AppConfig): Promise<void> {
  const app = await bundleApp('./apps/react-app.tsx');
  await page.setContent(PAGE_SHELL);
  await page.evaluate((c) => {
    (window as unknown as { __benchConfig: AppConfig }).__benchConfig = c;
  }, config);
  await page.addScriptTag({ content: app });
  await page.waitForSelector('#open-modal');
}
