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
