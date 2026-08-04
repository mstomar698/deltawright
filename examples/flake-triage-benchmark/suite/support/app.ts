import type { Page } from '@playwright/test';
import { faultFor } from './manifest.mjs';

/** Navigate to a flow with the fault the active profile assigns to THIS test title (clean by default).
 *  Tests drive the healthy path and assert the healthy outcome — so an injected fault makes them fail. */
export async function openFlow(page: Page, title: string, hash: string): Promise<void> {
  const fault = faultFor(title);
  await page.goto(`/?fault=${fault}#${hash}`);
}

/** A tiny deterministic value generator so parameter tables read cleanly. */
export const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
