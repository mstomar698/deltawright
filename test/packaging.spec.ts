import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  render as srcRender,
  serialize as srcSerialize,
  checksum as srcChecksum,
} from '../src/index';
import { GOLDEN_DELTA, GOLDEN_TEXT } from './fixtures/packaging-golden';

// Exercises the BUILT distributable (dist/), not the source tree — the thing a user
// actually installs. Everything here runs the built artifact through plain `node`.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = resolve(root, 'dist/index.js');
const distMcp = resolve(root, 'dist/mcp/server.js');
const distMatchers = resolve(root, 'dist/matchers/index.js');
const distReporter = resolve(root, 'dist/reporter/index.js');
const distWait = resolve(root, 'dist/wait/index.js');

// Build once if dist/ is missing so the suite is runnable standalone. CI builds
// explicitly before the tests, so this is a no-op there.
test.beforeAll(() => {
  if (!existsSync(distIndex)) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
});

test('should_import_from_built_package_without_tsx', () => {
  // Plain node (no tsx, no bundler) importing the built ESM by file URL: proves the
  // build resolves under vanilla Node and exports the public surface as functions.
  const url = pathToFileURL(distIndex).href;
  const script = [
    `import * as dw from ${JSON.stringify(url)};`,
    `const need = ['actAndObserve','serialize','render','tokenCount','checksum',`,
    `  'normalizeDelta','annotateActionability','geometryVerdict','ensureInjected',`,
    `  'injectedSource','diffChangedRegion','suggest'];`,
    `const missing = need.filter((k) => typeof dw[k] !== 'function');`,
    `if (missing.length) { console.error('MISSING:' + missing.join(',')); process.exit(2); }`,
    `console.log('OK:' + need.length);`,
  ].join('\n');
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('OK:12');
});

test('should_import_matchers_subpath_from_dist', () => {
  // The `deltawright/matchers` subpath (#53) resolves from dist under plain node and exports the
  // preflight fn + matcher bag as functions/objects.
  const url = pathToFileURL(distMatchers).href;
  const script = [
    `import * as m from ${JSON.stringify(url)};`,
    `const fns = ['preflight','toBeActionable','toMatchDeltaChecksum','toMatchDeltaSnapshot','matchDeltaChecksum'];`,
    `const okFns = fns.every((k) => typeof m[k] === 'function');`,
    `const okBag = m.dwMatchers && ['toBeActionable','toMatchDeltaChecksum','toMatchDeltaSnapshot']`,
    `  .every((k) => typeof m.dwMatchers[k] === 'function');`,
    `if (!okFns || !okBag) { console.error('BAD'); process.exit(2); }`,
    `console.log('OK');`,
  ].join('\n');
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('OK');
});

test('should_import_reporter_subpath_from_dist', () => {
  // The `deltawright/reporter` subpath (#55): a default-exported Reporter class + the pure triage
  // core + the delta-attachment helper resolve from dist under plain node.
  const url = pathToFileURL(distReporter).href;
  const script = [
    `import Reporter, { triageFailure, renderTriageText, attachDelta, DELTA_ATTACHMENT_NAME } from ${JSON.stringify(url)};`,
    `const okClass = typeof Reporter === 'function' && typeof new Reporter({}).onTestEnd === 'function';`,
    `const okFns = [triageFailure, renderTriageText, attachDelta].every((f) => typeof f === 'function');`,
    `const okConst = DELTA_ATTACHMENT_NAME === 'deltawright-delta';`,
    `const nullOnPass = triageFailure({ status: 'passed', title: 't', errorMessages: [], attachments: [] }) === null;`,
    `if (!okClass || !okFns || !okConst || !nullOnPass) { console.error('BAD'); process.exit(2); }`,
    `console.log('OK');`,
  ].join('\n');
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('OK');
});

test('should_import_wait_subpath_from_dist', () => {
  // The `deltawright/wait` subpath (#58): the observeConsequences settle-signal resolves from dist.
  const url = pathToFileURL(distWait).href;
  const script = [
    `import { observeConsequences } from ${JSON.stringify(url)};`,
    `if (typeof observeConsequences !== 'function') { console.error('BAD'); process.exit(2); }`,
    `console.log('OK');`,
  ].join('\n');
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('OK');
});

test('should_run_mcp_bin_from_dist', async () => {
  test.setTimeout(30_000);
  // The built bin carries a node shebang and is executable.
  expect(readFileSync(distMcp, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  expect(statSync(distMcp).mode & 0o111).toBeGreaterThan(0);

  // And it actually runs from dist under plain node, speaking MCP over stdio.
  const transport = new StdioClientTransport({ command: 'node', args: [distMcp] });
  const client = new Client({ name: 'dw-pkg-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['act_and_observe', 'navigate', 'snapshot']);
  } finally {
    await client.close();
  }
});

test('should_typecheck_against_published_types', () => {
  test.setTimeout(60_000);
  // Typecheck a by-name consumer against the built types, resolving the package the
  // way a published consumer would (nodenext + the exports map). Non-zero tsc throws.
  const tsc = resolve(root, 'node_modules/.bin/tsc');
  try {
    execFileSync(tsc, ['-p', 'test/fixtures/packaging/tsconfig.json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`consumer typecheck failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
      cause: err,
    });
  }
});

test('should_keep_default_serialized_bytes_unchanged', async () => {
  // The built serializer must produce byte-identical output to the source serializer
  // AND to the frozen golden — the build must never silently move the default bytes.
  const dist: typeof import('../src/index') = await import(pathToFileURL(distIndex).href);

  expect(srcSerialize(GOLDEN_DELTA)).toBe(GOLDEN_TEXT);
  expect(dist.serialize(GOLDEN_DELTA)).toBe(GOLDEN_TEXT);

  expect(dist.render(GOLDEN_DELTA).text).toBe(srcRender(GOLDEN_DELTA).text);
  expect(dist.render(GOLDEN_DELTA).tokens).toBe(srcRender(GOLDEN_DELTA).tokens);
  expect(dist.checksum(GOLDEN_DELTA)).toBe(srcChecksum(GOLDEN_DELTA));
});
