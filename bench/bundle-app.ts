import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, Promise<string>>();

/**
 * Bundle a benchmark app (.tsx, real React) into a self-contained IIFE string the
 * harness injects into a page. Cached per entry. NODE_ENV=production so we measure
 * against React's production reconciliation, not dev-mode overhead.
 */
export function bundleApp(relPath: string): Promise<string> {
  let p = cache.get(relPath);
  if (!p) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url));
    p = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).then((r) => {
      const out = r.outputFiles?.[0]?.text;
      if (!out) throw new Error(`bundleApp: no output for ${relPath}`);
      return out;
    });
    cache.set(relPath, p);
  }
  return p;
}
