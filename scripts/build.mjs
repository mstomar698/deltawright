// Builds the distributable package. Three outputs, in order:
//   1. compiled ESM + .d.ts for the public entry points (via tsup);
//   2. a pre-bundled injected-observer IIFE the host reads at runtime, so the
//      published package is self-contained and needs no build step to inject;
//   3. executable bins carrying a `node` shebang.
// Run with `npm run build`. The dev/test path still runs TypeScript directly via
// tsx, so this only has to produce a faithful, installable artifact.
import { build as tsupBuild } from 'tsup';
import { build as esbuild } from 'esbuild';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

// 1. Compile the public entry points. `clean` wipes dist/ first, so this runs
//    before the observer emit below.
await tsupBuild({
  entry: {
    index: 'src/index.ts',
    'mcp/server': 'src/mcp/server.ts',
    'matchers/index': 'src/matchers/index.ts',
    'reporter/index': 'src/reporter/index.ts',
    'wait/index': 'src/wait/index.ts',
    'aggregate/index': 'src/aggregate/index.ts',
    'trace/diagnose-trace': 'src/trace/diagnose-trace.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  treeshake: true,
  // esbuild is a devDependency, imported lazily only in the dev/source tree
  // (src/host/inject.ts). Never bundle it into the published output.
  external: ['esbuild'],
  silent: true,
});

// 2. Pre-bundle the injected page script into a self-contained IIFE. Same esbuild
//    options as the dev-tree fallback in src/host/inject.ts, so the injected bytes
//    are identical whether read from disk (published) or bundled on demand (dev).
await mkdir(resolve(dist, 'injected'), { recursive: true });
await esbuild({
  entryPoints: [resolve(root, 'src/injected/observer.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: resolve(dist, 'injected/observer.global.js'),
});

// 3. tsup carries the source shebang (which points at tsx for the dev path);
//    normalize the built bins to a plain node shebang and mark them executable.
const NODE_SHEBANG = '#!/usr/bin/env node';
for (const rel of ['mcp/server.js', 'cli.js']) {
  const file = resolve(dist, rel);
  const body = (await readFile(file, 'utf8')).replace(/^#![^\n]*\n/, '');
  await writeFile(file, `${NODE_SHEBANG}\n${body}`);
  await chmod(file, 0o755);
}

console.log('build: dist/ ready — index, mcp/server, cli, injected/observer.global.js');
