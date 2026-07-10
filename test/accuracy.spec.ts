import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { actAndObserve, diagnose } from '../src/index';
import type { Diagnosis, Verdict } from '../src/index';
import { CORPUS } from '../bench/flake-corpus/load';
import type { CorpusCase } from '../bench/flake-corpus/cases';
import { scoreCase, aggregate, type ScoredInput } from '../bench/flake-corpus/score';

// The accuracy harness (#52) scores diagnose() against the labeled corpus (#51). These guard the
// PURE scorer contract (browser-free) + the DW-02 verdict floor on the delta cases and a live
// smoke — so a scoring regression or a reality (verdict) drift fails CI. The full 36-case sweep is
// `npm run bench:accuracy` (reporting-first: only the DW-02 floor fails the run today).

const FLAKE_DIR = resolve(process.cwd(), 'bench/flake-corpus');

function input(diagnoses: Diagnosis[], verdict?: Verdict, interactive = true): ScoredInput {
  return {
    diagnoses,
    nodes: verdict ? [{ interactive, actionability: { verdict } }] : [],
  };
}
const diag = (code: Diagnosis['code'], confidence: Diagnosis['confidence']): Diagnosis => ({
  code,
  confidence,
  scope: 'node',
  ref: 'e1',
  detail: '',
});
const caseOf = (over: Partial<CorpusCase>): CorpusCase => ({
  id: 't',
  code: 'covered-by-overlay',
  confidence: 'confirmed',
  confuser: false,
  kind: 'delta',
  note: '',
  ...over,
});

test('scorer: a matching specific code at the right band is a hit', () => {
  const s = scoreCase(
    caseOf({ code: 'disabled', confidence: 'confirmed' }),
    input([diag('disabled', 'confirmed')]),
  );
  expect(s.outcome).toBe('hit');
  expect(s.confidenceMatch).toBe(true);
});

test('scorer: no specific code while a real cause exists is a silent-miss', () => {
  const s = scoreCase(caseOf({ code: 'detached-re-render', confidence: 'suspected' }), input([]));
  expect(s.outcome).toBe('silent-miss');
});

test('scorer: a different specific code is a mislabel', () => {
  const s = scoreCase(
    caseOf({ code: 'pointer-events-none', confidence: 'suspected' }),
    input([diag('covered-by-overlay', 'confirmed')]),
  );
  expect(s.outcome).toBe('mislabel');
  expect(s.emittedCode).toBe('covered-by-overlay');
});

test('scorer: an unknown-labeled case staying silent is correct-unsure; naming the confuser is a false-positive', () => {
  const clean = scoreCase(caseOf({ code: 'unknown', confidence: 'unknown' }), input([]));
  expect(clean.outcome).toBe('correct-unsure');

  const fooled = scoreCase(
    caseOf({ code: 'unknown', confidence: 'unknown', confuser: true, confusesWith: 'off-screen' }),
    input([diag('off-screen', 'confirmed')]),
  );
  expect(fooled.outcome).toBe('false-positive');
  expect(fooled.emittedCode).toBe('off-screen');
});

test('scorer: the verdict oracle compares the target node verdict to reality (DW-02)', () => {
  const ok = scoreCase(
    caseOf({ code: 'disabled', confidence: 'confirmed', verdict: 'NOT-actionable' }),
    input([diag('disabled', 'confirmed')], 'NOT-actionable'),
  );
  expect(ok.verdictMatch).toBe(true);

  const drift = scoreCase(
    caseOf({ code: 'disabled', confidence: 'confirmed', verdict: 'NOT-actionable' }),
    input([diag('disabled', 'confirmed')], 'ACTIONABLE'),
  );
  expect(drift.verdictMatch).toBe(false);
});

test('aggregate: computes recall, silent-miss, confirmed precision, and the DW-02 floor', () => {
  const scores = [
    scoreCase(
      caseOf({ id: 'a', code: 'disabled', confidence: 'confirmed', verdict: 'NOT-actionable' }),
      input([diag('disabled', 'confirmed')], 'NOT-actionable'),
    ),
    scoreCase(caseOf({ id: 'b', code: 'detached-re-render', confidence: 'suspected' }), input([])),
    scoreCase(
      caseOf({
        id: 'c',
        code: 'unknown',
        confidence: 'unknown',
        confuser: true,
        confusesWith: 'off-screen',
      }),
      input([]),
    ),
  ];
  const m = aggregate(scores);
  expect(m.specificCases).toBe(2);
  expect(m.hits).toBe(1);
  expect(m.silentMisses).toBe(1);
  expect(m.recall).toBeCloseTo(0.5);
  expect(m.silentMissRate).toBeCloseTo(0.5);
  expect(m.confirmedPrecision).toBe(1); // 1 confirmed correct, 0 confirmed wrong
  expect(m.verdictAccuracy).toBe(1);
});

test('integration: every delta corpus case scores as expected and never drifts the verdict (DW-02)', () => {
  const deltaCases = CORPUS.filter((c) => c.kind === 'delta');
  expect(deltaCases.length).toBeGreaterThan(0);
  const known = { hit: 0, silent: 0, unsure: 0 };
  for (const c of deltaCases) {
    const d = diagnose(c.delta!);
    const s = scoreCase(c, d);
    // A hand-authored delta must never make the engine emit a CONFIDENT wrong label, and its
    // authored verdict must match the delta (the DW-02 reality anchor).
    expect(['hit', 'silent-miss', 'correct-unsure'], `${c.id} → ${s.outcome}`).toContain(s.outcome);
    if (s.verdictMatch !== undefined) expect(s.verdictMatch, `${c.id} verdict`).toBe(true);
    if (s.outcome === 'hit') known.hit++;
    else if (s.outcome === 'silent-miss') known.silent++;
    else known.unsure++;
  }
  const m = aggregate(deltaCases.map((c) => scoreCase(c, diagnose(c.delta!))));
  expect(m.verdictAccuracy).toBe(1);
  // The known delta-level silent misses (injection-blocked, cross-boundary-partial) show up here.
  expect(known.silent).toBeGreaterThanOrEqual(2);
});

test('integration (live): a disabled target is recovered and its verdict matches reality', async ({
  page,
}) => {
  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/reveal.html')).href);
  const delta = await actAndObserve(page, (p) => p.click('[data-reveal="disabled"]'), {
    label: 'disabled',
  });
  const c = CORPUS.find((x) => x.id === 'disabled-pos')!;
  const s = scoreCase(c, diagnose(delta));
  expect(s.outcome).toBe('hit');
  expect(s.emittedCode).toBe('disabled');
  expect(s.emittedConfidence).toBe('confirmed');
  expect(s.verdictMatch).toBe(true); // DW-02: NOT-actionable, as Playwright really finds it
});

test('integration (live): a covered fillable input is a genuine geom-disagreement, verdict ACTIONABLE', async ({
  page,
}) => {
  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/reveal.html')).href);
  const delta = await actAndObserve(page, (p) => p.click('[data-reveal="covered-input"]'), {
    label: 'covered-input',
  });
  const c = CORPUS.find((x) => x.id === 'geom-disagreement-pos')!;
  const s = scoreCase(c, diagnose(delta));
  expect(s.outcome).toBe('hit');
  expect(s.emittedCode).toBe('geom-disagreement');
  expect(s.verdictMatch).toBe(true); // DW-02: ACTIONABLE (fill has no hit-test)
});
