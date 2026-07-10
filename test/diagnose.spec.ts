import { test, expect } from '@playwright/test';
import { diagnose } from '../src/host/diagnose';
import { serialize, render } from '../src/host/serialize';
import type { Delta, DeltaNode, DeltaStats, GeometryRead, Actionability } from '../src/host/types';

// The pure diagnose(delta) engine (#48). Agree-or-flag, verdict never overridden, unsure
// first-class, and default serialized bytes unchanged when diagnostics are off.

function geom(over: Partial<GeometryRead> = {}): GeometryRead {
  return {
    rect: { x: 10, y: 20, width: 80, height: 30 },
    inViewport: true,
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto',
    hitSelf: true,
    coveredBy: null,
    offscreen: false,
    ...over,
  };
}

function node(over: Partial<DeltaNode> & { actionability: Actionability }): DeltaNode {
  return {
    ref: 'e1',
    kind: 'added',
    tag: 'button',
    role: 'button',
    name: 'OK',
    interactive: true,
    parentRef: null,
    geometry: geom(),
    ...over,
  };
}

const STATS: DeltaStats = {
  rawRecords: 3,
  settleMs: 120,
  hitMaxWait: false,
  animationsAwaited: 0,
  droppedBackground: 0,
};

function delta(nodes: DeltaNode[], stats: Partial<DeltaStats> = {}): Delta {
  return { action: 'click "OK"', nodes, stats: { ...STATS, ...stats } };
}

// A covered target both engines agree is blocked.
const coveredAgreed = node({
  ref: 'cov',
  geometry: geom({ hitSelf: false, coveredBy: 'div.overlay' }),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'covered-by div.overlay',
    geometryVerdict: 'NOT-actionable',
    playwright: { actionable: false, error: 'covered (intercepted)' },
    agreed: true,
  },
});

// A covered input Playwright can still fill: geometry says blocked, Playwright says fine.
const coveredInputDisagree = node({
  ref: 'inp',
  tag: 'input',
  role: 'textbox',
  name: 'email',
  geometry: geom({ hitSelf: false, coveredBy: 'div.overlay' }),
  actionability: {
    verdict: 'ACTIONABLE',
    reason: null,
    geometryVerdict: 'NOT-actionable',
    playwright: { actionable: true },
    agreed: false,
  },
});

// A disabled button: Playwright NOT-actionable, geometry reads it as actionable.
const disabledButton = node({
  ref: 'dis',
  name: 'Submit',
  geometry: geom(),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'disabled',
    geometryVerdict: 'ACTIONABLE',
    playwright: { actionable: false, error: 'disabled' },
    agreed: false,
  },
});

// A read-only input: Playwright NOT-actionable (not editable), geometry reads it actionable.
const readOnlyInput = node({
  ref: 'ro',
  tag: 'input',
  role: 'textbox',
  name: 'email',
  geometry: geom(),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'read-only',
    geometryVerdict: 'ACTIONABLE',
    playwright: { actionable: false, error: 'read-only' },
    agreed: false,
  },
});

// A mid-animation element: Playwright NOT-actionable (not stable), geometry cannot see stability.
const unstableAnimating = node({
  ref: 'an',
  name: 'Confirm',
  geometry: geom(),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'unstable (animating)',
    geometryVerdict: 'ACTIONABLE',
    playwright: { actionable: false, error: 'unstable (animating)' },
    agreed: false,
  },
});

// A GENUINE geom-disagreement: Playwright reports a generic intercept (NOT-actionable) but
// geometry sees NOTHING covering the target (hitSelf, no coveredBy) → geometry reads it
// ACTIONABLE. `covered-by-overlay` is a geometry-VISIBLE cause, so geometry's dissent is real
// counter-evidence — this must stay geom-disagreement, never be recovered as a blocking code.
const interceptedButGeomClean = node({
  ref: 'ig',
  name: 'Confirm',
  geometry: geom({ hitSelf: true, coveredBy: null }),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'covered (intercepted)',
    geometryVerdict: 'ACTIONABLE',
    playwright: { actionable: false, error: 'covered (intercepted)' },
    agreed: false,
  },
});

// Disabled AND covered: BOTH engines say NOT-actionable (agreed), but Playwright's
// authoritative cause is `disabled` while geometry only sees the cover. Playwright wins.
const disabledAndCovered = node({
  ref: 'dc',
  name: 'Submit',
  geometry: geom({ hitSelf: false, coveredBy: 'div.overlay' }),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'covered-by div.overlay', // geometry-first for clicks
    geometryVerdict: 'NOT-actionable',
    playwright: { actionable: false, error: 'disabled' },
    agreed: true,
  },
});

// A pointer-events:none node where Playwright's error is not specific → only geometry named
// the cause → suspected, not confirmed.
const pointerEventsNone = node({
  ref: 'pe',
  geometry: geom({ pointerEvents: 'none' }),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'pointer-events:none',
    geometryVerdict: 'NOT-actionable',
    playwright: { actionable: false, error: 'not-actionable' }, // generic, unrecognised
    agreed: true,
  },
});

// A pointer-events:none target as it really reads live: elementFromPoint returns the element
// BEHIND, so coveredBy is set AND Playwright reports the generic "intercept". The engine must
// still name pointer-events-none (the true self-cause), NOT covered-by-overlay (#71).
const pointerEventsIntercept = node({
  ref: 'pei',
  geometry: geom({ pointerEvents: 'none', hitSelf: false, coveredBy: 'div.behind' }),
  actionability: {
    verdict: 'NOT-actionable',
    reason: 'covered-by div.behind',
    geometryVerdict: 'NOT-actionable',
    playwright: { actionable: false, error: 'covered (intercepted)' },
    agreed: true,
  },
});

// A screenshot-diff pixel region (#20 fallback): no DOM element, verdict n/a.
const pixelRegion: DeltaNode = {
  ref: 'px1',
  kind: 'added',
  tag: 'canvas-region',
  role: null,
  name: 'pixel region changed (500px)',
  interactive: false,
  parentRef: null,
  geometry: geom({ hitSelf: true }),
  actionability: {
    verdict: 'n/a',
    reason: 'pixel-region (screenshot-diff; no DOM element)',
    geometryVerdict: 'n/a',
    playwright: null,
    agreed: true,
  },
};

test('should_classify_covered_target_as_covered_by_overlay_only_when_geometry_and_playwright_agree', () => {
  const agree = diagnose(delta([coveredAgreed])).diagnoses;
  const covDiag = agree.find((d) => d.ref === 'cov');
  expect(covDiag?.code).toBe('covered-by-overlay');
  expect(covDiag?.confidence).toBe('confirmed');

  // Same covered geometry, but the engines DISagree (fillable covered input): must NOT be
  // covered-by-overlay — only agreement earns the blocking code.
  const disagree = diagnose(delta([coveredInputDisagree])).diagnoses;
  const inpDiag = disagree.find((d) => d.ref === 'inp');
  expect(inpDiag?.code).toBe('geom-disagreement');
  expect(disagree.some((d) => d.code === 'covered-by-overlay')).toBe(false);
});

test('should_emit_geom_disagreement_with_direction_when_a_visible_cause_disagrees', () => {
  // A geometry-VISIBLE cause (covered) that geometry did NOT corroborate — a real conflict, so
  // it stays a flagged disagreement (NOT recovered into a blocking code, unlike the blind
  // causes below).
  const diagnoses = diagnose(delta([interceptedButGeomClean])).diagnoses;
  const d = diagnoses.find((x) => x.ref === 'ig');
  expect(d?.code).toBe('geom-disagreement');
  // Direction is carried both ways: Playwright's authoritative verdict (+ reason) AND what
  // geometry read.
  expect(d?.detail).toContain('Playwright NOT-actionable');
  expect(d?.detail).toContain('intercepted');
  expect(d?.detail).toContain('geometry read ACTIONABLE');
});

test('should_recover_geometry_blind_causes_from_the_disagreed_branch', () => {
  // #71 recall fix: disabled / read-only / unstable-animating are Playwright-only causes
  // geometry cannot see, so the node reads geometry-ACTIONABLE (agreed=false). Geometry's
  // "actionable" is structural blindness, not counter-evidence, so the Playwright-named cause
  // is recovered as CONFIRMED — it is the verdict's reason, never a contradiction of it.
  const dis = diagnose(delta([disabledButton])).diagnoses.find((d) => d.ref === 'dis');
  expect(dis?.code).toBe('disabled');
  expect(dis?.confidence).toBe('confirmed');
  expect(dis?.detail).toContain('geometry cannot observe');
  expect(dis?.detail).toContain('geometry read ACTIONABLE');

  const ro = diagnose(delta([readOnlyInput])).diagnoses.find((d) => d.ref === 'ro');
  expect(ro?.code).toBe('read-only');
  expect(ro?.confidence).toBe('confirmed');

  const an = diagnose(delta([unstableAnimating])).diagnoses.find((d) => d.ref === 'an');
  expect(an?.code).toBe('unstable-animating');
  expect(an?.confidence).toBe('confirmed');

  // A geometry-VISIBLE cause geometry dissents on is NOT a blind cause → still flagged, no code.
  const ig = diagnose(delta([interceptedButGeomClean])).diagnoses.find((d) => d.ref === 'ig');
  expect(ig?.code).toBe('geom-disagreement');
});

test('should_never_contradict_the_playwright_verdict', () => {
  const BLOCKING = new Set([
    'covered-by-overlay',
    'off-screen',
    'not-visible',
    'pointer-events-none',
    'disabled',
    'read-only',
    'unstable-animating',
  ]);
  const nodes = [
    coveredAgreed,
    coveredInputDisagree,
    disabledButton,
    readOnlyInput,
    unstableAnimating,
    interceptedButGeomClean,
  ];
  const out = diagnose(delta(nodes));
  const byRef = new Map(nodes.map((n) => [n.ref, n]));

  for (const d of out.diagnoses) {
    if (d.scope !== 'node' || !d.ref) continue;
    const n = byRef.get(d.ref)!;
    // A node Playwright deems ACTIONABLE must never receive a blocking code (the DW-02 line).
    if (n.actionability.verdict === 'ACTIONABLE') {
      expect(BLOCKING.has(d.code), `${d.ref} actionable but got blocking ${d.code}`).toBe(false);
    }
    // A blocking code only ever attaches to a NOT-actionable node. (It may be agreed OR a
    // recovered geometry-blind cause where geometry dissented — but never ACTIONABLE.)
    if (BLOCKING.has(d.code)) {
      expect(n.actionability.verdict).toBe('NOT-actionable');
    }
  }
  // The fillable covered input (ACTIONABLE) is only flagged, never blocked.
  const inp = out.diagnoses.find((d) => d.ref === 'inp');
  expect(inp?.code).toBe('geom-disagreement');
  expect(inp?.detail).toContain('Playwright ACTIONABLE');
});

test('should_prefer_the_playwright_named_cause_over_a_geometry_only_pick', () => {
  // Verdict-agreement is not cause-agreement: Playwright authoritatively named `disabled`,
  // so the diagnosis is `disabled` (confirmed), NOT `covered-by-overlay`, even though
  // geometry saw the cover. Regression guard for the confidence over-claim (#48 review).
  const dc = diagnose(delta([disabledAndCovered])).diagnoses.find((d) => d.ref === 'dc');
  expect(dc?.code).toBe('disabled');
  expect(dc?.confidence).toBe('confirmed');
  expect(dc?.detail).toContain('disabled');
  expect(dc?.detail).toContain('geometry read covered-by-overlay');

  // When only geometry names a specific cause (Playwright agrees it is blocked but its error
  // is not specific), the code is geometry's but the confidence is SUSPECTED, never confirmed.
  const pe = diagnose(delta([pointerEventsNone])).diagnoses.find((d) => d.ref === 'pe');
  expect(pe?.code).toBe('pointer-events-none');
  expect(pe?.confidence).toBe('suspected');
});

test('should_name_pointer_events_none_not_covered_when_the_target_swallows_the_hit', () => {
  // #71: Playwright's generic "intercept" must not become covered-by-overlay when the target's
  // own pointer-events:none is why the hit misses (even though elementFromPoint set coveredBy).
  const d = diagnose(delta([pointerEventsIntercept])).diagnoses.find((x) => x.ref === 'pei');
  expect(d?.code).toBe('pointer-events-none');
  expect(d?.confidence).toBe('suspected');
});

test('should_map_a_pixel_region_node_to_pixel_region_fallback', () => {
  // #71: the screenshot-diff fallback node is surfaced as pixel-region-fallback (suspected).
  const diagnoses = diagnose(delta([pixelRegion])).diagnoses;
  const d = diagnoses.find((x) => x.code === 'pixel-region-fallback');
  expect(d?.confidence).toBe('suspected');
  expect(d?.ref).toBe('px1');
});

test('should_flag_delta_level_settle_timeout_and_background_churn', () => {
  // Non-empty delta that hit the cap → settle-timeout (suspected), not suspected-miss-empty.
  const timeout = diagnose(delta([coveredAgreed], { hitMaxWait: true })).diagnoses;
  const st = timeout.find((d) => d.code === 'settle-timeout');
  expect(st?.scope).toBe('delta');
  expect(st?.confidence).toBe('suspected');
  expect(timeout.some((d) => d.code === 'suspected-miss-empty')).toBe(false);

  // Dominant dropped churn → background-churn (suspected). One kept node, many dropped.
  const churn = diagnose(delta([coveredAgreed], { droppedBackground: 12 })).diagnoses;
  const bc = churn.find((d) => d.code === 'background-churn');
  expect(bc?.confidence).toBe('suspected');
  // A couple of incidental drops next to a real change must NOT trip it.
  const quiet = diagnose(delta([coveredAgreed], { droppedBackground: 1 })).diagnoses;
  expect(quiet.some((d) => d.code === 'background-churn')).toBe(false);
});

test('should_flag_detached_re_render_from_the_in_window_detach_signal', () => {
  // #71 fix #3: the observer set stats.detachedReRender because a freshly-added subtree was
  // detached again within the window (a re-render swap). diagnose emits detached-re-render as a
  // delta-level SUSPECTED note — an add-then-detach can also be a benign transient, so never
  // confirmed; it never touches the verdict of the surviving (replacement) node.
  const clean = node({
    ref: 'r2',
    name: 'Confirm (re-rendered)',
    actionability: {
      verdict: 'ACTIONABLE',
      reason: null,
      geometryVerdict: 'ACTIONABLE',
      playwright: { actionable: true },
      agreed: true,
    },
  });
  const flagged = diagnose(delta([clean], { detachedReRender: true })).diagnoses;
  const d = flagged.find((x) => x.code === 'detached-re-render');
  expect(d?.scope).toBe('delta');
  expect(d?.confidence).toBe('suspected');
  expect(d?.detail).toContain('detached');
  // The surviving replacement node is still cleanly actionable — the flag is delta-level only.
  expect(flagged.some((x) => x.scope === 'node')).toBe(false);

  // No in-window detach (field absent) → no detached-re-render.
  const quiet = diagnose(delta([clean])).diagnoses;
  expect(quiet.some((x) => x.code === 'detached-re-render')).toBe(false);
});

test('should_not_diagnose_a_removed_or_clean_node', () => {
  const removed = node({
    ref: 'rm',
    kind: 'removed',
    geometry: null,
    actionability: {
      verdict: 'n/a',
      reason: 'removed',
      geometryVerdict: 'n/a',
      playwright: null,
      agreed: true,
    },
  });
  const clean = node({
    ref: 'ok',
    actionability: {
      verdict: 'ACTIONABLE',
      reason: null,
      geometryVerdict: 'ACTIONABLE',
      playwright: { actionable: true },
      agreed: true,
    },
  });
  const diagnoses = diagnose(delta([removed, clean])).diagnoses.filter((d) => d.scope === 'node');
  expect(diagnoses).toHaveLength(0);
});

test('should_return_unknown_low_confidence_on_ambiguous_delta', () => {
  // Empty delta AND the settle cap was hit: a no-op or a missed effect — genuinely unsure.
  const out = diagnose(delta([], { hitMaxWait: true }));
  const miss = out.diagnoses.find((d) => d.code === 'suspected-miss-empty');
  expect(miss).toBeDefined();
  expect(miss?.confidence).toBe('unknown');
  expect(miss?.scope).toBe('delta');
});

test('should_leave_default_serialized_bytes_unchanged_when_diagnostics_off', () => {
  const base = delta([coveredAgreed], { hitMaxWait: true });
  const diagnosed = diagnose(base);

  // Diagnostics OFF (default): the diagnosed delta serializes byte-identically to the plain
  // delta — the new field is inert on the default path.
  expect(serialize(diagnosed)).toBe(serialize(base));
  expect(render(diagnosed).text).toBe(render(base).text);
  expect(render(diagnosed).tokens).toBe(render(base).tokens);

  // Diagnostics ON: a diagnostics section is appended (and only then).
  const on = serialize(diagnosed, { diagnostics: true });
  expect(on).not.toBe(serialize(base));
  expect(on).toContain('diagnostics:');
  expect(on).toContain('covered-by-overlay');
  expect(on.startsWith(serialize(base))).toBe(true);
});
