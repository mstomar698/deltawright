// The canonical, CLOSED root-cause taxonomy for v0.6 (#46). Every diagnosis Deltawright
// can emit MUST be one of these codes or `unknown` — a single shared vocabulary is what
// lets six potential diagnosis surfaces (matchers, side-car, MCP, …) stay one accurate
// place instead of drifting into three dialects. Each code is grounded in a REAL primitive
// signal the delta/engine already produces (or will, per #48–#50); none is a vibe.
//
// This is the CONTRACT the diagnosis engine (#48) fulfils; it may name signals that later
// tickets wire in (`lateStructural` #49, `stable` #50). Changing the code set is governed
// by DW-04: it requires an ADR + a corpus relabel + an accuracy-harness re-run, enforced by
// the frozen lock in test/taxonomy.spec.ts. See docs/specs/v0.6-root-cause-taxonomy.md.

/** The six top-level buckets a code belongs to. Closed. */
export type RootCauseCategory =
  | 'actionability-blocking'
  | 'verdict-disagreement'
  | 'membership-attribution'
  | 'outcome-integrity'
  | 'capture-integrity'
  | 'fallback'
  | 'unknown';

/**
 * The closed set of real primitive signals a code may be grounded in. Each names a
 * concrete thing the injected read, the settle result, or Playwright's engine produces —
 * NOT an inferred property. `catch-all` is reserved for `unknown` alone. The `PrimitiveSignal`
 * type is DERIVED from this array, so the two can never drift.
 */
export const PRIMITIVE_SIGNALS = [
  'hitSelf', // elementFromPoint(center) is (a descendant of) the node
  'coveredBy', // label of the covering element when hitSelf is false
  'inViewport', // rect intersects the layout viewport
  'offscreen', // center point lies outside the viewport
  'computed-style', // getComputedStyle (display/visibility/opacity/pointer-events)
  'getAnimations', // running Web Animations at read time
  'playwright-error', // Playwright's trial-action error string
  'playwright-verdict', // Playwright's authoritative actionable/not verdict
  'agreed', // did the geometry read and Playwright agree
  'hitMaxWait', // settle hit the maxWaitMs cap
  'droppedBackground', // count of nodes dropped as background churn
  'recurringInsert', // peak in-window insertion recurrence of a non-baseline container (#7)
  'empty-delta', // zero reported nodes
  'ref-staleified', // a node's data-dw-ref went stale (element detached)
  'lateStructural', // structural mutation after settle resolved (gap-E, #49)
  'stable', // target rect unchanged on post-settle re-read (gap-F, #50)
  'committed-value', // post-settle read of a value-bearing target's committed value vs intent (#Move1)
  'addScriptTag-failure', // observer injection threw (e.g. CSP)
  'traversal-skip', // a cross-origin frame / closed shadow root was skipped
  'screenshot-fallback', // the screenshot-diff produced a pixel-region node
  'catch-all', // reserved: `unknown` only
] as const;

export type PrimitiveSignal = (typeof PRIMITIVE_SIGNALS)[number];

/** The closed set of root-cause codes. `unknown` is the first-class "unsure" outcome. */
export type RootCauseCode =
  | 'covered-by-overlay'
  | 'off-screen'
  | 'not-visible'
  | 'disabled'
  | 'read-only'
  | 'pointer-events-none'
  | 'unstable-animating'
  | 'geom-disagreement'
  | 'input-not-committed'
  | 'background-churn'
  | 'detached-re-render'
  | 'settle-timeout'
  | 'suspected-miss-empty'
  | 'late-wave-suspected'
  | 'stale-rect-suspected'
  | 'injection-blocked'
  | 'cross-boundary-partial'
  | 'pixel-region-fallback'
  | 'unknown';

export interface RootCauseSpec {
  /** The code itself (equals its key in ROOT_CAUSE_TAXONOMY). */
  code: RootCauseCode;
  /** Which bucket the code belongs to. */
  category: RootCauseCategory;
  /** One-line meaning surfaced to a human/agent. */
  meaning: string;
  /** The real primitive signal(s) grounding this code. Non-empty; `unknown` uses catch-all. */
  signals: readonly PrimitiveSignal[];
  /** Human gloss of how the signals combine to justify the code. */
  grounding: string;
}

// The table. The `as const satisfies` keeps every entry's `code` in sync with its key at
// compile time, and forces the record to cover EVERY RootCauseCode (exhaustive/closed).
export const ROOT_CAUSE_TAXONOMY = {
  'covered-by-overlay': {
    code: 'covered-by-overlay',
    category: 'actionability-blocking',
    meaning:
      'The hit-point is occupied by another element; Playwright and geometry agree it is blocked.',
    signals: ['hitSelf', 'coveredBy', 'playwright-error'],
    grounding:
      "hitSelf=false with a coveredBy label, corroborated by Playwright's intercepts-pointer-events error.",
  },
  'off-screen': {
    code: 'off-screen',
    category: 'actionability-blocking',
    meaning: 'The target is outside the viewport / scrolled away.',
    signals: ['offscreen', 'inViewport'],
    grounding: 'offscreen=true, or the rect does not intersect the viewport (inViewport=false).',
  },
  'not-visible': {
    code: 'not-visible',
    category: 'actionability-blocking',
    meaning: 'The target is display:none, visibility:hidden, or opacity:0.',
    signals: ['playwright-verdict', 'computed-style'],
    grounding:
      "Playwright's 'element is not visible', corroborated by the computed display/visibility/opacity read.",
  },
  disabled: {
    code: 'disabled',
    category: 'actionability-blocking',
    meaning: 'The control is disabled.',
    signals: ['playwright-verdict'],
    grounding: "Playwright's role-aware probe reports the element disabled.",
  },
  'read-only': {
    code: 'read-only',
    category: 'actionability-blocking',
    meaning: 'The input is read-only — fillable-shaped but not editable.',
    signals: ['playwright-verdict'],
    grounding: "Playwright's isEditable=false on a text input the geometry deemed reachable.",
  },
  'pointer-events-none': {
    code: 'pointer-events-none',
    category: 'actionability-blocking',
    meaning: 'Computed pointer-events:none on the target swallows the click.',
    signals: ['computed-style'],
    grounding: "getComputedStyle(target).pointerEvents === 'none'.",
  },
  'unstable-animating': {
    code: 'unstable-animating',
    category: 'actionability-blocking',
    meaning: 'The element is mid-animation and not yet stable.',
    signals: ['playwright-verdict', 'getAnimations'],
    grounding:
      "Playwright's 'element is not stable', corroborated by non-empty getAnimations at read time.",
  },
  'geom-disagreement': {
    code: 'geom-disagreement',
    category: 'verdict-disagreement',
    meaning:
      'Geometry and Playwright reached different verdicts; Playwright wins and the direction is surfaced, never overriding.',
    signals: ['agreed', 'playwright-verdict'],
    grounding:
      "agreed=false between the geometry read and Playwright's authoritative verdict (the [geom:] marker).",
  },
  'input-not-committed': {
    code: 'input-not-committed',
    category: 'outcome-integrity',
    meaning:
      'A value-bearing action reported success, but the field committed a strict subsequence of the intended value — characters were cleared, truncated, or dropped after the action.',
    signals: ['committed-value'],
    grounding:
      "the post-settle committed value (el.value) is a proper subsequence of the intended value, is shorter, AND at least one DROPPED character is a letter or number (real content lost) — never-committed (empty), truncated (a prefix), or dropped-keystrokes (a non-prefix subsequence). A value that is not a subsequence (a case/reorder mask) OR that dropped ONLY separators/whitespace (a subtractive card/phone/trim mask, which IS a shorter subsequence) is NOT flagged — an intended reformat is indistinguishable from corruption. Always `suspected`: it compares intent, it does not override Playwright's success (DW-02/03).",
  },
  'background-churn': {
    code: 'background-churn',
    category: 'membership-attribution',
    meaning: 'High background insertion/mutation churn may be masking the real change.',
    signals: ['droppedBackground', 'recurringInsert'],
    grounding:
      'droppedBackground is high relative to the reported node count, OR a single insertion signature recurred past the suspected threshold AND kept settle from quiescing (post-action churn — suspected, since a slow/large streamed payload can also cap).',
  },
  'detached-re-render': {
    code: 'detached-re-render',
    category: 'membership-attribution',
    meaning: 'The target was removed or replaced by a re-render mid-action.',
    signals: ['ref-staleified'],
    grounding: "the node's data-dw-ref went stale (element detached) during reconciliation.",
  },
  'settle-timeout': {
    code: 'settle-timeout',
    category: 'membership-attribution',
    meaning: 'Settle hit the maxWaitMs cap rather than going quiet.',
    signals: ['hitMaxWait'],
    grounding: 'hitMaxWait=true in the settle result.',
  },
  'suspected-miss-empty': {
    code: 'suspected-miss-empty',
    category: 'membership-attribution',
    meaning:
      'Zero nodes AND the settle cap was hit: a true no-op OR a missed effect — reported as unsure, not a confident no-op.',
    signals: ['empty-delta', 'hitMaxWait'],
    grounding: 'an empty node set combined with hitMaxWait=true.',
  },
  'late-wave-suspected': {
    code: 'late-wave-suspected',
    category: 'membership-attribution',
    meaning:
      'A structural mutation arrived after settle resolved (a two-wave render); flagged, not captured (gap-E).',
    signals: ['lateStructural'],
    grounding:
      'the opt-in late-wave watch saw a structural mutation after settle (lateStructural=true).',
  },
  'stale-rect-suspected': {
    code: 'stale-rect-suspected',
    category: 'membership-attribution',
    meaning:
      'A post-settle JS reposition moved the target after its rect was read; flagged, not re-read (gap-F).',
    signals: ['stable'],
    grounding: "the opt-in rect-recheck saw the target's rect move after the read (stable=false).",
  },
  'injection-blocked': {
    code: 'injection-blocked',
    category: 'capture-integrity',
    meaning: 'The observer script could not be injected (e.g. a strict CSP).',
    signals: ['addScriptTag-failure'],
    grounding: 'ensureInjected/addScriptTag threw for the target frame.',
  },
  'cross-boundary-partial': {
    code: 'cross-boundary-partial',
    category: 'capture-integrity',
    meaning: 'A cross-origin frame or closed shadow root was skipped, so coverage is partial.',
    signals: ['traversal-skip'],
    grounding: 'a frame/shadow boundary was skipped during traversal.',
  },
  'pixel-region-fallback': {
    code: 'pixel-region-fallback',
    category: 'fallback',
    meaning: 'No DOM delta; a screenshot-diff region stood in (canvas/WebGL).',
    signals: ['screenshot-fallback'],
    grounding: 'the screenshot-diff fallback produced a synthetic pixel-region node.',
  },
  unknown: {
    code: 'unknown',
    category: 'unknown',
    meaning:
      "Insufficient evidence to name a cause — the first-class 'unsure' outcome. Silence beats a wrong label.",
    signals: ['catch-all'],
    grounding: 'no grounding signal fired; emitted rather than guessing (DW-03).',
  },
} as const satisfies Record<RootCauseCode, RootCauseSpec>;

/** All root-cause codes, in declaration order. */
export const ROOT_CAUSE_CODES = Object.keys(ROOT_CAUSE_TAXONOMY) as RootCauseCode[];

/** Look up a code's spec, or `undefined` if it is not a defined code. */
export function rootCauseSpec(code: string): RootCauseSpec | undefined {
  return (ROOT_CAUSE_TAXONOMY as Record<string, RootCauseSpec>)[code];
}

/** Narrow an arbitrary string to a defined code, else `unknown` (never throws). */
export function toRootCauseCode(code: string): RootCauseCode {
  return code in ROOT_CAUSE_TAXONOMY ? (code as RootCauseCode) : 'unknown';
}
