import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';

// In a published build the injected script is a pre-bundled IIFE emitted next to
// the compiled bundle (see scripts/build.mjs), so the package is self-contained and
// needs no build step at runtime. The candidates cover both compiled entry depths:
// dist/index.js resolves the first, dist/mcp/server.js the second.
const PREBUILT_CANDIDATES = [
  new URL('./injected/observer.global.js', import.meta.url),
  new URL('../injected/observer.global.js', import.meta.url),
];
// In the dev/source tree there is no pre-built artifact; bundle the TS observer on
// demand instead. esbuild is only a devDependency, imported lazily so the built
// package never pulls it in at runtime.
const observerSourceEntry = new URL('../injected/observer.ts', import.meta.url);

let bundled: Promise<string> | null = null;

async function loadInjectedSource(): Promise<string> {
  for (const candidate of PREBUILT_CANDIDATES) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // Not this location — try the next, then fall back to a source-tree bundle.
    }
  }
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(observerSourceEntry)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
  });
  const out = result.outputFiles?.[0]?.text;
  if (!out) throw new Error('deltawright: failed to bundle injected script');
  return out;
}

/**
 * The injected page script as a single self-contained IIFE. Cached after the first
 * call. Authoring the page script as normal TypeScript keeps it type-checked and
 * testable; it is flattened into something we can drop into the page — pre-bundled
 * at build time for the published package, or bundled on demand in the dev tree.
 */
export function injectedSource(): Promise<string> {
  if (!bundled) bundled = loadInjectedSource();
  return bundled;
}

/**
 * Thrown by `ensureInjected` ONLY when `addScriptTag` itself is rejected — the authoritative
 * "the observer could not be injected" signal, typically a strict CSP (`script-src 'none'`).
 * Distinct from a presence-probe or bundle failure (which propagate as their own errors), so a
 * caller can degrade on THIS and only this, and never mislabel a transient/config fault as a
 * confirmed injection block (#71 fix #4b; DW-03).
 */
export class InjectionBlockedError extends Error {
  constructor(cause: string) {
    super(`observer injection blocked: ${cause}`);
    this.name = 'InjectionBlockedError';
  }
}

/**
 * Ensure window.__deltawright is installed on the page. Idempotent: the injected
 * script no-ops if it is already present. We use addScriptTag (a program context)
 * rather than page.evaluate(string) so the bundled IIFE runs cleanly regardless of
 * expression-vs-statement quirks. A blocked addScriptTag (strict CSP) — and ONLY that —
 * is re-thrown as `InjectionBlockedError`; the presence probe and the bundle load above it
 * throw their own errors so a transient/config fault is never mistaken for a CSP block.
 */
export async function ensureInjected(target: Page | Frame): Promise<void> {
  const present = await target.evaluate(() => typeof (window as any).__deltawright !== 'undefined');
  if (present) return;
  const source = await injectedSource();
  try {
    await target.addScriptTag({ content: source });
  } catch (e) {
    throw new InjectionBlockedError(e instanceof Error ? e.message : String(e));
  }
}
