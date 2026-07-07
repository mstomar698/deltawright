import { chromium, type Browser, type Page } from '@playwright/test';
import { actAndObserve, render } from '../index';

// A long-lived browser session behind the MCP server. Kept separate from the server
// so the actual logic is unit-testable without the stdio protocol.

export type McpAction =
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'select'; selector: string; value: string }
  | { kind: 'check'; selector: string }
  | { kind: 'press'; selector: string; key: string };

function describe(action: McpAction): string {
  switch (action.kind) {
    case 'fill':
      return `fill "${action.selector}" = ${JSON.stringify(action.value)}`;
    case 'select':
      return `select "${action.selector}" = ${JSON.stringify(action.value)}`;
    case 'press':
      return `press ${action.key} on "${action.selector}"`;
    default:
      return `${action.kind} "${action.selector}"`;
  }
}

async function perform(page: Page, action: McpAction): Promise<void> {
  const locator = page.locator(action.selector);
  switch (action.kind) {
    case 'click':
      await locator.click();
      break;
    case 'fill':
      await locator.fill(action.value);
      break;
    case 'select':
      await locator.selectOption(action.value);
      break;
    case 'check':
      await locator.check();
      break;
    case 'press':
      await locator.press(action.key);
      break;
  }
}

export class DeltawrightSession {
  private browser?: Browser;
  private page?: Page;

  private async ensurePage(): Promise<Page> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    if (!this.page)
      this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    return this.page;
  }

  /** Navigate and return the initial full accessibility snapshot (the starting map). */
  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();
    await page.goto(url);
    const snap = await page.locator('body').ariaSnapshot();
    return `navigated to ${url}\n\n${snap}`;
  }

  /**
   * Perform ONE action and return the compact delta — the core value: what changed,
   * where, and whether the agent can act on it, with no before/after snapshot.
   */
  async act(action: McpAction): Promise<string> {
    const page = await this.ensurePage();
    const delta = await actAndObserve(page, (p) => perform(p, action), { label: describe(action) });
    const { text, tokens } = render(delta);
    const dropped = delta.stats.droppedBackground
      ? `, ${delta.stats.droppedBackground} background changes filtered`
      : '';
    return `${text}\n\n(${tokens} tokens${dropped})`;
  }

  /** The full accessibility snapshot — the fallback when a full map is needed. */
  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    return page.locator('body').ariaSnapshot();
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }
}
