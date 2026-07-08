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

test('should_emit_geom_disagreement_with_direction_when_agreed_is_false', () => {
  const diagnoses = diagnose(delta([disabledButton])).diagnoses;
  const d = diagnoses.find((x) => x.ref === 'dis');
  expect(d?.code).toBe('geom-disagreement');
  // Direction is carried both ways: Playwright's authoritative verdict (+ reason) AND what
  // geometry read.
  expect(d?.detail).toContain('Playwright NOT-actionable');
  expect(d?.detail).toContain('disabled');
  expect(d?.detail).toContain('geometry read ACTIONABLE');
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
  const nodes = [coveredAgreed, coveredInputDisagree, disabledButton];
  const out = diagnose(delta(nodes));
  const byRef = new Map(nodes.map((n) => [n.ref, n]));

  for (const d of out.diagnoses) {
    if (d.scope !== 'node' || !d.ref) continue;
    const n = byRef.get(d.ref)!;
    // A node Playwright deems ACTIONABLE must never receive a blocking code.
    if (n.actionability.verdict === 'ACTIONABLE') {
      expect(BLOCKING.has(d.code), `${d.ref} actionable but got blocking ${d.code}`).toBe(false);
    }
    // A blocking code only ever attaches to a NOT-actionable node the engines agreed on.
    if (BLOCKING.has(d.code)) {
      expect(n.actionability.verdict).toBe('NOT-actionable');
      expect(n.actionability.agreed).toBe(true);
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
