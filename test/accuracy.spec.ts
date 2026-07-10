import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { actAndObserve, diagnose } from '../src/index';
import { ensureInjected, InjectionBlockedError } from '../src/host/inject';
import type { Diagnosis, Verdict } from '../src/index';
import { CORPUS } from '../bench/flake-corpus/load';
import type { CorpusCase } from '../bench/flake-corpus/cases';
import { scoreCase, aggregate, gateFailure, type ScoredInput } from '../bench/flake-corpus/score';

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

test('aggregate: computes recall, silent-miss, confirmed precision, and splits the verdict oracle', () => {
  const scores = [
    scoreCase(
      caseOf({
        id: 'a',
        kind: 'live',
        code: 'disabled',
        confidence: 'confirmed',
        verdict: 'NOT-actionable',
      }),
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
  // Verdict oracle is split by kind (F1): the live case is the DW-02 gate; there are no delta ones.
  expect(m.liveVerdictOracleCases).toBe(1);
  expect(m.liveVerdictAccuracy).toBe(1);
  expect(m.deltaVerdictOracleCases).toBe(0);
  expect(gateFailure(m)).toBeNull(); // one live oracle, 100% → passes
});

test('F2: a confident non-label code co-emitted on a hit case still lowers confirmed precision', () => {
  // The engine correctly names `disabled` (confirmed) AND spuriously names `off-screen`
  // (confirmed) on a second node. Per-case the outcome is a hit, but precision must SEE the
  // spurious confident code — the pre-fix per-case metric hid it (F2).
  const s = scoreCase(
    caseOf({ code: 'disabled', confidence: 'confirmed' }),
    input([diag('disabled', 'confirmed'), diag('off-screen', 'confirmed')]),
  );
  expect(s.outcome).toBe('hit');
  expect(s.confirmedCorrect).toBe(1);
  expect(s.confirmedWrong).toBe(1);
  expect(s.extraSpecificCodes.map((e) => e.code)).toContain('off-screen');
  const m = aggregate([s]);
  expect(m.confirmedPrecision).toBeCloseTo(0.5); // 1 correct / (1 correct + 1 wrong)
});

test('F5: the gate refuses to pass vacuously when there is no live verdict oracle', () => {
  // A suspected co-emission does NOT touch confirmed precision (only confirmed codes count).
  const suspectedExtra = scoreCase(
    caseOf({ code: 'settle-timeout', confidence: 'suspected' }),
    input([diag('settle-timeout', 'suspected'), diag('background-churn', 'suspected')]),
  );
  expect(suspectedExtra.confirmedWrong).toBe(0);

  // No live oracle (all delta / no verdict) → the ONLY hard gate would pass vacuously; guard it.
  const m = aggregate([suspectedExtra]);
  expect(m.liveVerdictOracleCases).toBe(0);
  expect(gateFailure(m)).toMatch(/vacuous/i);

  // A live oracle that drifted → the gate fails with a DW-02 message.
  const drift = aggregate([
    scoreCase(
      caseOf({
        kind: 'live',
        code: 'disabled',
        confidence: 'confirmed',
        verdict: 'NOT-actionable',
      }),
      input([diag('disabled', 'confirmed')], 'ACTIONABLE'),
    ),
  ]);
  expect(gateFailure(drift)).toMatch(/DW-02/);
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
  // These are all delta cases: their authored verdicts are self-consistent (F1), and there is no
  // live oracle here — so the DW-02 gate would (correctly) refuse to pass on this subset alone.
  expect(m.deltaVerdictAccuracy).toBe(1);
  expect(m.liveVerdictOracleCases).toBe(0);
  // The former delta-level silent misses (injection-blocked, cross-boundary-partial) now HIT via
  // their capture-integrity signals (#71 fix #4), so no delta case stays silent.
  expect(known.silent).toBe(0);
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

test('integration (live): an in-window detach + replace is diagnosed detached-re-render (#71 fix #3)', async ({
  page,
}) => {
  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/reveal.html')).href);
  const delta = await actAndObserve(page, (p) => p.click('[data-reveal="detached"]'), {
    label: 'detached',
  });
  // The original is removed + replaced in a microtask: it nets out of the reported delta, but the
  // observer counts the in-window detach → the default-absent flag is set and diagnose emits it.
  expect(delta.stats.detachedReRender).toBe(true);
  const c = CORPUS.find((x) => x.id === 'detached-re-render-pos')!;
  const s = scoreCase(c, diagnose(delta));
  expect(s.outcome).toBe('hit');
  expect(s.emittedCode).toBe('detached-re-render');
  expect(s.emittedConfidence).toBe('suspected');
  // Only the replacement shows in the delta, and it is cleanly actionable — the flag is delta-level.
  expect(delta.nodes.every((n) => n.actionability.verdict !== 'NOT-actionable')).toBe(true);
});

test('detached-re-render honors the background-insert quarantine (a recurring toast must not trip it)', async ({
  page,
}) => {
  // Regression guard (#71 fix #3 review): a recurring BACKGROUND toast that inserts-then-removes
  // in-window is the exact churn bgInsert suppresses from the delta — it must NOT ground
  // detached-re-render. The action itself (opening a persistent modal) adds no in-window detach.
  await page.setContent(`
    <div id="toasts"></div>
    <button id="open">open</button>
    <div id="stage"></div>
    <script>
      setInterval(() => {
        const t = document.createElement('div');
        t.className = 'bg-toast';
        document.getElementById('toasts').appendChild(t);
        setTimeout(() => t.remove(), 8);
      }, 16);
      document.getElementById('open').addEventListener('click', () => {
        const m = document.createElement('div');
        m.id = 'modal';
        m.textContent = 'Modal';
        document.getElementById('stage').appendChild(m);
      });
    </script>
  `);
  const act = (p: typeof page) => p.click('#open');

  // baseline OFF → bgInsert is empty, so nothing is quarantined and the in-window toast detach IS
  // counted: this proves the signal really fires on this pattern (the guard is not vacuous).
  const noBaseline = await actAndObserve(page, act, {
    label: 'open',
    baseline: false,
    maxWaitMs: 400,
  });
  expect(noBaseline.stats.detachedReRender).toBe(true);

  // baseline ON (default) → the recurring toast signature is learned and quarantined, so the
  // detach counter excludes it: detached-re-render must be ABSENT even though toasts churned.
  const withBaseline = await actAndObserve(page, act, { label: 'open', maxWaitMs: 400 });
  expect(withBaseline.stats.detachedReRender).toBeUndefined();
  expect(diagnose(withBaseline).diagnoses.some((d) => d.code === 'detached-re-render')).toBe(false);
});

test('integration (live): a strict CSP that blocks injection degrades to injection-blocked (#71 fix #4b)', async ({
  page,
}) => {
  // script-src 'none' blocks addScriptTag, so the observer can't be injected. actAndObserve must
  // DEGRADE: still run the action, then return an empty delta flagged injectionBlocked, which
  // diagnose maps to injection-blocked (confirmed) — not a silent no-op.
  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
    <button id="go">go</button>
  `);
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go' });
  expect(delta.stats.injectionBlocked).toBe(true);
  expect(delta.nodes).toHaveLength(0);
  const c = CORPUS.find((x) => x.id === 'injection-blocked-pos')!;
  const s = scoreCase(c, diagnose(delta));
  expect(s.outcome).toBe('hit');
  expect(s.emittedCode).toBe('injection-blocked');
  expect(s.emittedConfidence).toBe('confirmed');
});

test('ensureInjected: only an addScriptTag block raises InjectionBlockedError; a normal page injects', async ({
  page,
}) => {
  // Guards the degrade gate (#71 fix #4b review): the confirmed injection-blocked path must fire
  // ONLY on an authoritative addScriptTag rejection, never on a probe/transient throw — so the
  // marker error is raised exactly there and nowhere else. (Uses real navigations, not two
  // setContent calls, because a <meta> CSP can leak across setContent within one document.)
  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/csp-blocked.html')).href);
  await expect(ensureInjected(page)).rejects.toThrow(InjectionBlockedError);

  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/reveal.html')).href);
  await expect(ensureInjected(page)).resolves.toBeUndefined();
});

test('integration (live): an uninjectable child frame is counted and diagnosed cross-boundary-partial (#71 fix #4a)', async ({
  page,
}) => {
  // Exercises the REAL armChildFrames skip path (not a hand-authored stat): a child frame whose
  // srcdoc CSP blocks injection is skipped during frames:true traversal → stats.crossBoundarySkipped
  // → cross-boundary-partial (suspected). The main-frame click still produces an observable delta.
  await page.goto(pathToFileURL(resolve(FLAKE_DIR, 'fixtures/cross-boundary.html')).href);
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'go', frames: true });
  expect(delta.stats.crossBoundarySkipped).toBeGreaterThanOrEqual(1);
  const c = CORPUS.find((x) => x.id === 'cross-boundary-partial-pos')!;
  const s = scoreCase(c, diagnose(delta));
  expect(s.outcome).toBe('hit');
  expect(s.emittedCode).toBe('cross-boundary-partial');
  expect(s.emittedConfidence).toBe('suspected');
});
