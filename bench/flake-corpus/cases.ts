// The labeled flake corpus (#51). GROUND TRUTH for the accuracy harness (#52), authored to
// be non-circular: a case is NEVER scored against a stored Deltawright output. Each case
// carries up to THREE INDEPENDENT ORACLES:
//   1. `verdict`  — the real Playwright action outcome (the reality anchor; validates the
//                   VERDICT / DW-02, not the diagnosis code). Present on live actionability cases.
//   2. `code`     — a hand-authored CONSTRUCTION MANIFEST asserting the intended root cause.
//   3. `truth`    — `window.__truth` fixture instrumentation for hidden causes (wave counts,
//                   scheduled repositions) the DOM alone doesn't reveal.
//
// Anti-strawman: every taxonomy code has a POSITIVE case AND a mandatory NEAR-MISS CONFUSER
// (a superficially-similar DOM whose correct label is different), so precision can't be
// inflated by a one-fixture-per-code set where the author picked both the DOM and the label.
//
// HONESTY: numbers are CORPUS-RELATIVE ("diagnoses correctly on a DOM we assert resembles the
// failure mode"), NOT real-production precision — that stays blocked on #25/#41. Some cases are
// `kind:'delta'` (a hand-constructed Delta) for causes not cleanly reproducible live this cycle;
// they carry a weaker verdict oracle and are stamped as such. The engine's CURRENT behavior on
// each code (incl. known gaps) is recorded in CORPUS.md, discovered by live probe — the corpus
// labels the TRUE cause, and #52 measures the engine against it.

import type { RootCauseCode, Confidence, Delta, Verdict } from '../../src/index';

export interface CorpusAction {
  kind: 'click' | 'fill' | 'select' | 'check' | 'press';
  selector: string;
  value?: string;
  key?: string;
}

/** Extra actAndObserve options a case needs to surface its cause (opt-in flags/tunables). */
export interface CorpusOptions {
  lateWatchMs?: number;
  rectRecheckMs?: number;
  screenshotFallback?: boolean;
  frames?: boolean;
  maxWaitMs?: number;
  inWindowRecurrence?: boolean;
}

export interface CorpusCase {
  id: string;
  /** Construction-manifest oracle: the intended TRUE root cause (or the confuser's correct label). */
  code: RootCauseCode;
  /** Expected confidence band for a correct diagnosis of `code`. */
  confidence: Confidence;
  /** A near-miss confuser: `confusesWith` is the code it superficially resembles but is NOT. */
  confuser: boolean;
  confusesWith?: RootCauseCode;
  /** 'live' runs the fixture through actAndObserve (#52); 'delta' feeds a hand-built Delta. */
  kind: 'live' | 'delta';
  /** Live: fixture path relative to bench/flake-corpus/. */
  fixture?: string;
  action?: CorpusAction;
  options?: CorpusOptions;
  /** Oracle 1 (reality anchor): the real Playwright verdict for the target, when applicable. */
  verdict?: Verdict;
  /** Oracle 3: expected window.__truth (hidden-cause instrumentation). */
  truth?: Record<string, unknown>;
  /** Delta cases: the hand-constructed delta (honesty-stamped; weaker reality anchor). */
  delta?: Delta;
  /** Why this case exists / what it pins. */
  note: string;
}

const R = 'fixtures/reveal.html';
const click = (selector: string): CorpusAction => ({ kind: 'click', selector });
const reveal = (kind: string) => click(`[data-reveal="${kind}"]`);

// --- Minimal hand-built deltas for causes not cleanly reproducible live this cycle ---------
// Each is honesty-stamped `kind:'delta'`; its `verdict` reflects the PW outcome the author
// asserts. They exist so every code has coverage; live expansion pairs with #25/#41.

const baseStats = {
  rawRecords: 2,
  settleMs: 130,
  hitMaxWait: false,
  animationsAwaited: 0,
  droppedBackground: 0,
};

function nodeDelta(
  over: Partial<Delta['nodes'][number]>,
  statsOver: Partial<Delta['stats']> = {},
): Delta {
  return {
    action: 'x',
    stats: { ...baseStats, ...statsOver },
    nodes: [
      {
        ref: 'e1',
        kind: 'added',
        tag: 'button',
        role: 'button',
        name: 'X',
        interactive: true,
        parentRef: null,
        geometry: {
          rect: { x: 10, y: 10, width: 80, height: 30 },
          inViewport: true,
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          pointerEvents: 'auto',
          hitSelf: true,
          coveredBy: null,
          offscreen: false,
        },
        actionability: {
          verdict: 'NOT-actionable',
          reason: null,
          geometryVerdict: 'NOT-actionable',
          playwright: { actionable: false },
          agreed: true,
        },
        ...over,
      },
    ],
  };
}

export const CORPUS: CorpusCase[] = [
  // ===== actionability-blocking (agreed): the engine emits these confidently ==============
  {
    id: 'covered-pos',
    code: 'covered-by-overlay',
    confidence: 'confirmed',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('covered'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'covered', intendedCause: 'covered-by-overlay' },
    note: 'A button fully covered by a higher overlay; geometry + Playwright agree it is blocked.',
  },
  {
    id: 'covered-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'covered-by-overlay',
    kind: 'live',
    fixture: R,
    action: reveal('covered-near'),
    verdict: 'ACTIONABLE',
    note: 'An overlay NEAR the button but not over it — actionable, must NOT be covered-by-overlay.',
  },
  {
    id: 'offscreen-pos',
    code: 'off-screen',
    confidence: 'confirmed',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('offscreen'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'offscreen', intendedCause: 'off-screen' },
    note: 'A fixed button clipped above the viewport Playwright cannot scroll to.',
  },
  {
    id: 'offscreen-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'off-screen',
    kind: 'live',
    fixture: R,
    action: reveal('edge'),
    verdict: 'ACTIONABLE',
    note: 'A fixed button clearly within the viewport — actionable, must NOT be off-screen.',
  },
  {
    id: 'not-visible-pos',
    code: 'not-visible',
    confidence: 'confirmed',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('hidden'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'hidden', intendedCause: 'not-visible' },
    note: 'visibility:hidden — Playwright treats it as not visible (unlike opacity:0).',
  },
  {
    id: 'not-visible-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'not-visible',
    kind: 'live',
    fixture: R,
    action: reveal('faint'),
    verdict: 'ACTIONABLE',
    note: 'opacity:0.05 is barely visible but Playwright clicks it — actionable, must NOT be not-visible.',
  },
  {
    id: 'pointer-events-none-pos',
    code: 'pointer-events-none',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('petnone'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'petnone', intendedCause: 'pointer-events-none' },
    note: 'Playwright reports a generic "intercept"; geometry sees pointer-events:none with NO covering element, so the engine prefers geometry\'s specific self-cause (#71 fix). Suspected — a geometry-only specific cause Playwright confirmed only as "blocked".',
  },
  {
    id: 'pointer-events-none-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'pointer-events-none',
    kind: 'live',
    fixture: R,
    action: reveal('petauto'),
    verdict: 'ACTIONABLE',
    note: 'pointer-events:auto — actionable, must NOT be pointer-events-none.',
  },
  {
    id: 'disabled-pos',
    code: 'disabled',
    confidence: 'confirmed',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('disabled'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'disabled', intendedCause: 'disabled' },
    note: 'A disabled button: geometry cannot see "disabled" so agreed=false. The engine RECOVERS the Playwright-named cause from the disagreed branch (#71 geometry-blind recovery) → disabled/confirmed.',
  },
  {
    id: 'disabled-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'disabled',
    kind: 'live',
    fixture: R,
    action: reveal('ok'),
    verdict: 'ACTIONABLE',
    note: 'A plain enabled button — actionable, must NOT be disabled.',
  },
  {
    id: 'read-only-pos',
    code: 'read-only',
    confidence: 'confirmed',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('readonly'),
    verdict: 'NOT-actionable',
    truth: { reveal: 'readonly', intendedCause: 'read-only' },
    note: 'A read-only input reads geometry-actionable (agreed=false); the engine RECOVERS the Playwright-named cause from the disagreed branch (#71) → read-only/confirmed.',
  },
  {
    id: 'read-only-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'read-only',
    kind: 'delta',
    delta: nodeDelta({
      tag: 'input',
      role: 'textbox',
      name: 'email',
      actionability: {
        verdict: 'ACTIONABLE',
        reason: null,
        geometryVerdict: 'ACTIONABLE',
        playwright: { actionable: true },
        agreed: true,
      },
    }),
    verdict: 'ACTIONABLE',
    note: 'An editable input — actionable, must NOT be read-only.',
  },
  {
    id: 'unstable-animating-pos',
    code: 'unstable-animating',
    confidence: 'confirmed',
    confuser: false,
    kind: 'delta',
    delta: nodeDelta({
      actionability: {
        verdict: 'NOT-actionable',
        reason: 'unstable (animating)',
        geometryVerdict: 'ACTIONABLE',
        playwright: { actionable: false, error: 'unstable (animating)' },
        agreed: false,
      },
    }),
    verdict: 'NOT-actionable',
    note: 'A mid-animation element Playwright deems not stable (geometry cannot see stability, so agreed=false); the engine RECOVERS unstable-animating from the disagreed branch (#71) → confirmed. kind:delta — live CSS-animation reproduction pairs with real-app expansion.',
  },
  {
    id: 'unstable-animating-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'unstable-animating',
    kind: 'delta',
    delta: nodeDelta({
      actionability: {
        verdict: 'ACTIONABLE',
        reason: null,
        geometryVerdict: 'ACTIONABLE',
        playwright: { actionable: true },
        agreed: true,
      },
    }),
    verdict: 'ACTIONABLE',
    note: 'A settled, stable element — actionable, must NOT be unstable-animating.',
  },

  // ===== verdict-disagreement =============================================================
  {
    id: 'geom-disagreement-pos',
    code: 'geom-disagreement',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('covered-input'),
    verdict: 'ACTIONABLE',
    truth: { reveal: 'covered-input', intendedCause: 'geom-disagreement' },
    note: 'A text input covered by an overlay: Playwright can still `fill` it (ACTIONABLE, no hit-test) but geometry sees the cover (NOT-actionable) — a GENUINE disagreement on a geometry-VISIBLE cause, so it stays geom-disagreement (not recovered like the geometry-blind disabled/read-only class). The canonical case DW exists to surface.',
  },
  {
    id: 'geom-disagreement-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'geom-disagreement',
    kind: 'live',
    fixture: R,
    action: reveal('ok'),
    verdict: 'ACTIONABLE',
    note: 'Geometry and Playwright agree (actionable) — no disagreement to flag.',
  },

  // ===== membership-attribution (delta/stats level, from real fixtures) ===================
  {
    id: 'settle-timeout-pos',
    code: 'settle-timeout',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: '../../test/fixtures/toast.html',
    action: click('#open'),
    options: { maxWaitMs: 200 },
    note: 'A continuously-churning page forced against a low maxWait cap → settle-timeout. (Fixture path reuses test/fixtures.)',
  },
  {
    id: 'settle-timeout-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'settle-timeout',
    kind: 'delta',
    delta: nodeDelta({}, { hitMaxWait: false }),
    verdict: 'NOT-actionable',
    note: 'A delta that settled by quiescence (hitMaxWait=false) — must NOT be settle-timeout.',
  },
  {
    id: 'suspected-miss-empty-pos',
    code: 'suspected-miss-empty',
    confidence: 'unknown',
    confuser: false,
    kind: 'delta',
    delta: { action: 'x', nodes: [], stats: { ...baseStats, hitMaxWait: true } },
    note: 'Zero nodes AND the settle cap hit — a no-op or a missed effect (genuinely unsure).',
  },
  {
    id: 'suspected-miss-empty-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'suspected-miss-empty',
    kind: 'delta',
    delta: { action: 'x', nodes: [], stats: { ...baseStats, hitMaxWait: false } },
    note: 'Zero nodes but NO cap hit — a confident no-op, must NOT be suspected-miss-empty.',
  },
  {
    id: 'background-churn-pos',
    code: 'background-churn',
    confidence: 'suspected',
    confuser: false,
    kind: 'delta',
    delta: nodeDelta({}, { droppedBackground: 12 }),
    verdict: 'NOT-actionable',
    note: 'Dominant dropped background churn (12 dropped vs 1 kept) may be masking the change.',
  },
  {
    id: 'background-churn-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'background-churn',
    kind: 'delta',
    delta: nodeDelta({}, { droppedBackground: 1 }),
    verdict: 'NOT-actionable',
    note: 'A single incidental drop next to a real change — must NOT be background-churn.',
  },
  {
    id: 'detached-re-render-pos',
    code: 'detached-re-render',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: R,
    action: reveal('detached'),
    truth: { reveal: 'detached', intendedCause: 'detached-re-render' },
    note: 'The target is inserted then removed + replaced in a microtask (a re-render swap). The original nets out of the reported delta, but the observer counts it as a freshly-added subtree detached in-window (#71 fix #3) → the engine emits detached-re-render (suspected). Only the replacement shows in the delta; a handle to the original would be stale.',
  },
  {
    id: 'detached-re-render-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'detached-re-render',
    kind: 'live',
    fixture: R,
    action: reveal('ok'),
    verdict: 'ACTIONABLE',
    note: 'A target that stays attached — must NOT be detached-re-render.',
  },
  {
    id: 'late-wave-suspected-pos',
    code: 'late-wave-suspected',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: '../../test/fixtures/late-wave.html',
    action: click('#open'),
    options: { lateWatchMs: 1200 },
    truth: { intendedCause: 'late-wave-suspected' },
    note: 'A two-wave render whose second wave lands after settle, flagged via lateWatchMs.',
  },
  {
    id: 'late-wave-suspected-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'late-wave-suspected',
    kind: 'delta',
    delta: nodeDelta({}, { lateStructural: false }),
    verdict: 'NOT-actionable',
    note: 'A single-wave render with the watch on but no late structural mutation — must NOT flag late-wave.',
  },
  {
    id: 'stale-rect-suspected-pos',
    code: 'stale-rect-suspected',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: '../../test/fixtures/stale-rect.html',
    action: click('#open'),
    options: { rectRecheckMs: 800 },
    truth: { intendedCause: 'stale-rect-suspected' },
    note: 'A JS-timer recenter after settle; rectRecheckMs re-reads and flags the stale rect.',
  },
  {
    id: 'stale-rect-suspected-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'stale-rect-suspected',
    kind: 'delta',
    delta: nodeDelta({}),
    verdict: 'NOT-actionable',
    note: 'A node whose rect did not move (no stable=false) — must NOT be stale-rect-suspected.',
  },

  // ===== capture-integrity ===============================================================
  {
    id: 'injection-blocked-pos',
    code: 'injection-blocked',
    confidence: 'confirmed',
    confuser: false,
    kind: 'delta',
    delta: { action: 'x', nodes: [], stats: { ...baseStats } },
    note: 'KNOWN GAP: observer injection failing under a strict CSP is not yet surfaced as a code (addScriptTag throws upstream). kind:delta placeholder; a real CSP fixture pairs with real-app expansion.',
  },
  {
    id: 'injection-blocked-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'injection-blocked',
    kind: 'delta',
    delta: nodeDelta({}),
    verdict: 'NOT-actionable',
    note: 'A page where injection succeeded and a normal delta was produced — must NOT be injection-blocked.',
  },
  {
    id: 'cross-boundary-partial-pos',
    code: 'cross-boundary-partial',
    confidence: 'suspected',
    confuser: false,
    kind: 'delta',
    delta: { action: 'x', nodes: [], stats: { ...baseStats } },
    note: 'KNOWN GAP: a cross-origin frame / closed shadow root skipped during traversal is not yet surfaced as a code. kind:delta placeholder; a real cross-origin fixture pairs with real-app expansion.',
  },
  {
    id: 'cross-boundary-partial-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'cross-boundary-partial',
    kind: 'live',
    fixture: '../../test/fixtures/shadow.html',
    action: click('#open'),
    note: 'An OPEN shadow root IS traversed (fully covered) — must NOT be cross-boundary-partial.',
  },

  // ===== fallback ========================================================================
  {
    id: 'pixel-region-fallback-pos',
    code: 'pixel-region-fallback',
    confidence: 'suspected',
    confuser: false,
    kind: 'live',
    fixture: '../../test/fixtures/canvas.html',
    action: click('#draw'),
    options: { screenshotFallback: true },
    note: 'A canvas draw mutates no DOM; the screenshot-diff fallback reports a pixel region, which the engine now maps to pixel-region-fallback (#71 fix).',
  },
  {
    id: 'pixel-region-fallback-confuser',
    code: 'unknown',
    confidence: 'unknown',
    confuser: true,
    confusesWith: 'pixel-region-fallback',
    kind: 'live',
    fixture: R,
    action: reveal('ok'),
    options: { screenshotFallback: true },
    verdict: 'ACTIONABLE',
    note: 'A real DOM change with the fallback ON — the DOM delta is non-empty, so NO pixel fallback fires.',
  },

  // ===== unknown (first-class unsure) ====================================================
  {
    id: 'unknown-pos',
    code: 'unknown',
    confidence: 'unknown',
    confuser: false,
    kind: 'delta',
    delta: nodeDelta({
      kind: 'attrChanged',
      changedAttrs: ['data-x'],
      actionability: {
        verdict: 'NOT-actionable',
        reason: null,
        geometryVerdict: 'NOT-actionable',
        playwright: { actionable: false },
        agreed: true,
      },
      geometry: {
        rect: { x: 10, y: 10, width: 80, height: 30 },
        inViewport: true,
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        pointerEvents: 'auto',
        hitSelf: true,
        coveredBy: null,
        offscreen: false,
      },
    }),
    verdict: 'NOT-actionable',
    note: 'An agreed NOT-actionable node with no attributable geometry-visible cause → the first-class unsure outcome.',
  },
  {
    id: 'unknown-confuser',
    code: 'covered-by-overlay',
    confidence: 'confirmed',
    confuser: true,
    confusesWith: 'unknown',
    kind: 'live',
    fixture: R,
    action: reveal('covered'),
    verdict: 'NOT-actionable',
    note: 'A clearly-attributable covered case — must NOT collapse to unknown when evidence exists.',
  },
];
