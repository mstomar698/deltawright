import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';

const observerEntry = fileURLToPath(new URL('../injected/observer.ts', import.meta.url));

let bundled: Promise<string> | null = null;

/**
 * Bundle the injected page script (src/injected/observer.ts) into a single
 * self-contained IIFE. Cached after the first call. Authoring the page script
 * as normal TypeScript keeps it type-checked and testable; esbuild flattens it
 * into something we can drop into the page.
 */
export function injectedSource(): Promise<string> {
  if (!bundled) {
    bundled = build({
      entryPoints: [observerEntry],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
    }).then((result) => {
      const out = result.outputFiles?.[0]?.text;
      if (!out) throw new Error('deltawright: failed to bundle injected script');
      return out;
    });
  }
  return bundled;
}

/**
 * Ensure window.__deltawright is installed on the page. Idempotent: the injected
 * script no-ops if it is already present. We use addScriptTag (a program context)
 * rather than page.evaluate(string) so the bundled IIFE runs cleanly regardless of
 * expression-vs-statement quirks.
 */
export async function ensureInjected(target: Page | Frame): Promise<void> {
  const present = await target.evaluate(() => typeof (window as any).__deltawright !== 'undefined');
  if (present) return;
  const source = await injectedSource();
  await target.addScriptTag({ content: source });
}
