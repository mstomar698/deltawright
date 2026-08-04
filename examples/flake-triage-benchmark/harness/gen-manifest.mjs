// Emit ground-truth/manifest.json: for every test in the suite, whether the `faults` profile injects a
// fault, its true cause category, and per-cause blast radius (distinct tests). Uses the test list from
// Playwright (--list --reporter=json) so the manifest can never drift from the actual suite.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GROUPS, groupFor } from '../suite/support/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = execFileSync('npx', ['playwright', 'test', '--project=control', '--list', '--reporter=json'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, FAULT_PROFILE: 'clean' }, maxBuffer: 64 * 1024 * 1024,
});
const listed = JSON.parse(raw);
const titles = [];
const walk = (s) => {
  for (const spec of s.specs ?? []) titles.push(spec.title);
  for (const c of s.suites ?? []) walk(c);
};
for (const s of listed.suites ?? []) walk(s);

const injected = titles
  .map((t) => ({ title: t, group: groupFor(t) }))
  .filter((x) => x.group)
  .map((x) => ({ title: x.title, cause: x.group.category, faultId: x.group.id, kind: x.group.kind }));

const blastRadius = {};
for (const g of GROUPS) blastRadius[g.id] = injected.filter((i) => i.faultId === g.id).length;

const manifest = {
  totalTests: titles.length,
  injectedCount: injected.filter((i) => i.kind === 'hard').length,
  groups: GROUPS.map((g) => ({ id: g.id, cause: g.category, kind: g.kind, blastRadius: blastRadius[g.id] })),
  injected,
};
mkdirSync(resolve(ROOT, 'ground-truth'), { recursive: true });
writeFileSync(resolve(ROOT, 'ground-truth/manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest: ${titles.length} tests, ${manifest.injectedCount} hard-injected`);
console.log('blast radius by cause:', JSON.stringify(blastRadius));
