// Consolidated scorer across N realistic runs: precision/FP, cross-run cluster stability, priority order,
// and flake detection — all in one pass, scored vs ground truth. Emits results/matrix.json for the artifact.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readSidecars, clusterByCause, prioritize } from 'deltawright/aggregate';
import { GROUPS, groupFor } from '../suite/support/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runDirs = readdirSync(resolve(ROOT, 'results')).filter((d) => /^real-\d+-sidecars$/.test(d)).map((d) => resolve(ROOT, 'results', d));
const bare = (t) => (t.split('.spec.ts > ')[1] ?? t);
const NAMEABLE = new Set(['covered-by-overlay', 'off-screen']);

// --- per-side-car precision/FP across all runs ---
let named = 0, correct = 0, unsure = 0, wrong = 0, records = 0;
const perCauseNamed = {};
for (const dir of runDirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.deltawright-sidecar.json'))) {
    const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    const g = groupFor(bare(s.test));
    records++;
    if (s.cause === 'unsure') { unsure++; continue; }
    named++;
    const ok = g && s.cause === g.category;
    if (ok) { correct++; perCauseNamed[s.cause] = (perCauseNamed[s.cause] ?? 0) + 1; }
    else wrong++;
  }
}

// --- cross-run clustering + priority (the real API, over all run dirs) ---
const recs = readSidecars(runDirs);
const clusterReport = clusterByCause(recs);
const queue = prioritize(clusterReport);

// --- flake detection: distinct flaky tests, failures-in-N-of-runs ---
const byTest = {};
for (const r of recs) (byTest[r.testId] ??= new Set()).add(r.runId);
const flaky = Object.entries(byTest)
  .filter(([t]) => /flaky load/.test(t))
  .map(([t, runs]) => ({ test: bare(t), fails: runs.size }));
const flakeDist = {};
for (const f of flaky) flakeDist[f.fails] = (flakeDist[f.fails] ?? 0) + 1;

const out = {
  runs: runDirs.length,
  totalRecords: records,
  precision: { named, correct, wrong, pct: named ? Math.round((100 * correct) / named) : 0 },
  hardFalsePositives: wrong,
  abstained: unsure,
  perCauseNamed,
  clusters: clusterReport.clusters.map((c) => ({ code: c.code, blastRadius: c.blastRadius, runs: c.runs, confidence: c.confidence })),
  unsureSingletons: clusterReport.unsure.length,
  priority: queue.rows.map((r) => ({ rank: r.rank, code: r.code, blastRadius: r.blastRadius })),
  flake: { distinctFlakyTests: flaky.length, failsInNofRuns: flakeDist },
};
writeFileSync(resolve(ROOT, 'results/matrix.json'), JSON.stringify(out, null, 2));

console.log(`\n══ full matrix — ${out.runs} realistic runs, ${records} failure records ══\n`);
console.log('HONESTY GATE  hard false-positives:', wrong, wrong === 0 ? '✅' : '❌');
console.log('PRECISION     named-correct:', `${correct}/${named} = ${out.precision.pct}%`);
console.log('ABSTENTION    unsure:', unsure, `(${Math.round((100 * unsure) / records)}%)`);
console.log('named per cause (across 3 runs):', JSON.stringify(perCauseNamed));
console.log('\nclusters (stable across runs):');
out.clusters.forEach((c) => console.log(`  ${c.code} × ${c.blastRadius} tests · ${c.runs} runs · ${c.confidence}`));
console.log('unsure singletons:', out.unsureSingletons);
console.log('\npriority fix-first:', out.priority.map((r) => `#${r.rank} ${r.code}(${r.blastRadius})`).join('  '));
console.log('\nflake detection:', out.flake.distinctFlakyTests, 'distinct flaky tests · fails-in-N-of-3:', JSON.stringify(out.flake.failsInNofRuns));
