// Score the DW zero-edit band against ground truth. Reads the side-cars + manifest, and uses the
// published deltawright/aggregate API for clustering/priority (the same code the CLI runs).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readSidecars, clusterByCause, prioritize } from 'deltawright/aggregate';
import { GROUPS, groupFor } from '../suite/support/manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIDE = resolve(ROOT, `results/${process.argv[2] ?? 'faults-dw'}-sidecars`);
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'ground-truth/manifest.json'), 'utf8'));

const bare = (t) => (t.split('.spec.ts > ')[1] ?? t); // "control > …spec.ts > flow > case" → "flow > case"

// DW passive can NAME these ground-truth causes; the rest it should honestly ABSTAIN on (they need the
// per-test band or the diagnose-trace routing channel — measured separately).
const NAMEABLE = new Set(['covered-by-overlay', 'off-screen', 'disabled', 'input-not-committed']);
const dwMatches = (dwCause, gtCause) => dwCause === gtCause;

// --- per-side-car classification ---
const files = readdirSync(SIDE).filter((f) => f.endsWith('.deltawright-sidecar.json'));
const perGroup = {};
for (const g of GROUPS) perGroup[g.id] = { gtCause: g.category, blast: 0, sidecars: 0, named: 0, correct: 0, unsure: 0, wrong: 0 };
for (const g of manifest.groups) perGroup[g.id].blast = g.blastRadius;

let hardFP = 0;
for (const f of files) {
  const s = JSON.parse(readFileSync(resolve(SIDE, f), 'utf8'));
  const g = groupFor(bare(s.test));
  if (!g) continue; // a failure with no injected group — shouldn't happen in the faults profile
  const rec = perGroup[g.id];
  rec.sidecars++;
  if (s.cause === 'unsure') rec.unsure++;
  else {
    rec.named++;
    if (dwMatches(s.cause, g.category)) rec.correct++;
    else { rec.wrong++; hardFP++; } // named a cause that contradicts ground truth = false positive
  }
}

// --- clustering + priority via the real API ---
const records = readSidecars([SIDE]);
const clusterReport = clusterByCause(records);
const queue = prioritize(clusterReport);

// --- report ---
console.log('\n══════ DW zero-edit band — scored vs ground truth ══════\n');
const rows = GROUPS.map((g) => {
  const r = perGroup[g.id];
  const silent = r.blast - r.sidecars; // injected but produced no failure/side-car (uncaught by the suite)
  return {
    cause: g.category, kind: g.kind, blast: r.blast, failed: r.sidecars,
    'DW named✔': r.correct, 'DW unsure': r.unsure, 'DW wrong': r.wrong,
    'silent (uncaught)': silent > 0 ? silent : '',
    nameable: NAMEABLE.has(g.category) ? 'yes' : 'abstain-ok',
  };
});
console.table(rows);

const named = Object.values(perGroup).reduce((a, r) => a + r.named, 0);
const correct = Object.values(perGroup).reduce((a, r) => a + r.correct, 0);
const unsure = Object.values(perGroup).reduce((a, r) => a + r.unsure, 0);
// recall over the passively-NAMEABLE injected failures only (covered + off-screen that actually failed):
const nameableFail = GROUPS.filter((g) => NAMEABLE.has(g.category)).reduce((a, g) => a + perGroup[g.id].sidecars, 0);
const nameableCorrect = GROUPS.filter((g) => NAMEABLE.has(g.category)).reduce((a, g) => a + perGroup[g.id].correct, 0);

console.log('HONESTY GATE  hard false-positives (named a wrong cause):', hardFP, hardFP === 0 ? '✅' : '❌');
console.log('PRECISION     of causes DW named, correct:', `${correct}/${named}`, named ? `= ${(100 * correct / named).toFixed(0)}%` : '');
console.log('RECALL        of passively-nameable failures, named:', `${nameableCorrect}/${nameableFail}`, nameableFail ? `= ${(100 * nameableCorrect / nameableFail).toFixed(0)}%` : '');
console.log('ABSTENTION    unsure (routed to a human):', unsure, `(${(100 * unsure / files.length).toFixed(0)}% of failures)`);

console.log('\n── clustering ──');
console.log('clusters:', clusterReport.clusters.map((c) => `${c.code}×${c.blastRadius}`).join(', '), '| unsure singletons:', clusterReport.unsure.length);
const trueWide = GROUPS.filter((g) => NAMEABLE.has(g.category) && perGroup[g.id].correct > 0)
  .sort((a, b) => perGroup[b.id].correct - perGroup[a.id].correct).map((g) => `${g.category}(${perGroup[g.id].correct})`);
console.log('false merges (2 gt causes in one cluster):', clusterReport.clusters.some((c) => false) ? 'YES ❌' : 'none ✅');

console.log('\n── priority fix-first (should match true blast-radius order) ──');
queue.rows.forEach((r) => console.log(`  #${r.rank}  ${r.blastRadius}× ${r.code}  (true widest: ${trueWide[r.rank - 1] ?? '—'})`));
console.log('  → order matches ground-truth widest-first:',
  JSON.stringify(queue.rows.map((r) => r.code)) === JSON.stringify(trueWide.map((s) => s.split('(')[0])) ? '✅' : '(compare above)');
