// Shared types for the Deltawright delta. The injected page script produces a
// `RawDelta` (geometry + change classification, no Playwright knowledge); the
// host annotates each node with Playwright's authoritative actionability verdict
// to produce a `Delta`, which the serializer renders to the compact text format.

import type { RootCauseCode } from './taxonomy';
import type { Confidence } from './confidence';

export type ChangeKind = 'added' | 'removed' | 'attrChanged' | 'textChanged';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the injected script can observe about a node from the DOM/layout alone. */
export interface GeometryRead {
  /** getBoundingClientRect(), viewport coordinates, rounded. */
  rect: Rect;
  /** Does the rect intersect the layout viewport at all? */
  inViewport: boolean;
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
  /**
   * document.elementFromPoint(center): is the topmost element at this node's
   * center the node itself (or a descendant of it)?
   */
  hitSelf: boolean;
  /** Human label of the covering element when hitSelf is false (e.g. "div.dw-overlay"). */
  coveredBy: string | null;
  /** True when the center point lies outside the viewport (elementFromPoint == null). */
  offscreen: boolean;
  /**
   * Gap-F flag (#50, opt-in via `rectRecheckMs`): present and `false` only when a post-settle
   * re-read found the rect had MOVED (a JS-timer reposition `getAnimations` can't see), in
   * which case the later rect was adopted here. Absent unless `rectRecheckMs > 0` and the rect
   * moved, so the default annotation is byte-unchanged. Grounds `stale-rect-suspected`.
   */
  stable?: boolean;
}

/** One changed element node, as reported by the injected script. */
export interface RawNode {
  /** Stable ref stamped as data-dw-ref at drain time, e.g. "e1". */
  ref: string;
  kind: ChangeKind;
  tag: string;
  role: string | null;
  name: string | null;
  /** button / link / input-like — nodes an agent would try to act on. */
  interactive: boolean;
  /** Nearest ancestor that is itself a reported node, for nesting in the output. */
  parentRef: string | null;
  /** For attrChanged: which attributes changed net. */
  changedAttrs?: string[];
  /** null for removed nodes (no live geometry). */
  geometry: GeometryRead | null;
}

export interface DeltaStats {
  /** Raw MutationRecords seen before coalescing (compression evidence). */
  rawRecords: number;
  /** Wall time from arm to settle, in ms. */
  settleMs: number;
  /** True if settle hit the maxWait cap rather than going quiet. */
  hitMaxWait: boolean;
  /** How many running animations we awaited before reading final geometry. */
  animationsAwaited: number;
  /** Changed nodes dropped as background churn by causal attribution (#15). */
  droppedBackground: number;
  /**
   * Gap-E flag (#49, opt-in via `lateWatchMs`): a structural mutation landed AFTER settle
   * resolved (a late render wave), observed but deliberately NOT captured. Absent unless
   * `lateWatchMs > 0`, so the default path is byte-unchanged. Grounds `late-wave-suspected`.
   */
  lateStructural?: boolean;
  /**
   * Detached-re-render flag (#71 fix #3): a freshly-added subtree was inserted and then
   * DETACHED again within the settle window (a re-render / list-virtualization swap), so the
   * reported delta shows only the replacement and a handle to the original is stale. Always
   * computed (zero added latency), but PRESENT ONLY when it happened, so a delta with no
   * in-window detach has a byte-unchanged stats object. Grounds `detached-re-render`.
   */
  detachedReRender?: boolean;
  /**
   * Capture-integrity flag (#71 fix #4a): how many child frames could NOT be observed during
   * `frames:true` traversal (cross-origin / uninjectable / detached mid-action), so the delta is
   * PARTIAL — a change inside one of them is invisible. Absent unless `frames:true` AND at least
   * one frame was skipped, so the default path is byte-unchanged. Grounds `cross-boundary-partial`.
   * (Closed shadow roots are structurally undetectable — `el.shadowRoot` is null — so they are not
   * counted here; the honest, countable signal is skipped frames.)
   */
  crossBoundarySkipped?: number;
  /**
   * Capture-integrity flag (#71 fix #4b): the observer could not be injected into the page
   * (`addScriptTag` threw — typically a strict CSP), so NOTHING could be observed. The primitive
   * degrades: it still performs the action, but returns an empty delta carrying this flag. Absent
   * on every normally-injected page, so the default path is byte-unchanged. Grounds
   * `injection-blocked` (confirmed — the injection failure was authoritatively observed).
   */
  injectionBlocked?: boolean;
}

export interface RawDelta {
  nodes: RawNode[];
  stats: DeltaStats;
}

export type Verdict = 'ACTIONABLE' | 'NOT-actionable' | 'n/a';

/**
 * The reconciliation of geometry read vs. Playwright's authoritative judgment.
 *
 * The verdict is ROLE-AWARE (#17): it matches the action an agent would use on the
 * node — `click` for buttons/links (pointer hit-test), `fill` for text inputs (no
 * hit-test, so a covered input is fillable but a read-only one is not), and
 * `selectOption` for selects. Playwright's judgment wins any disagreement with the
 * geometry (pointer-model) read; see docs/decisions/design-watches.md (DW-02).
 */
export interface Actionability {
  /** Final verdict — Playwright's judgment wins any disagreement. */
  verdict: Verdict;
  /**
   * Human reason for a NOT-actionable verdict, e.g. "covered-by div.dw-overlay".
   * Best-effort, geometry-first gloss: only `verdict` is Playwright-authoritative,
   * so when geometry and Playwright both say NOT-actionable for DIFFERENT causes,
   * this may name the geometry cause rather than Playwright's.
   */
  reason: string | null;
  /** What the geometry read alone concluded (kept to expose disagreements). */
  geometryVerdict: Verdict;
  /** Playwright's trial-action result; null when not probed (e.g. removed nodes). */
  playwright: { actionable: boolean; error?: string } | null;
  /** Did the geometry read and Playwright agree? A false here is the signal to surface. */
  agreed: boolean;
}

export interface DeltaNode extends RawNode {
  actionability: Actionability;
}

export interface Delta {
  /** Human label of the action that produced this delta. */
  action: string;
  nodes: DeltaNode[];
  stats: DeltaStats;
}

/**
 * One root-cause hypothesis about a delta (#48). A diagnosis EXPLAINS why a node or the
 * whole action is in the state it's in; it never overrides Playwright's verdict (DW-03).
 */
export interface Diagnosis {
  /** The taxonomy code (closed set, DW-04). */
  code: RootCauseCode;
  /** How sure we are (first-class `unknown`, DW-03). */
  confidence: Confidence;
  /** Whether this explains one changed node or the whole action. */
  scope: 'node' | 'delta';
  /** The node's ref when scope is 'node'. */
  ref?: string;
  /** Human explanation — for geom-disagreement it carries the direction. */
  detail: string;
}

/** A `Delta` annotated with root-cause diagnoses (the output of `diagnose`). */
export interface DiagnosedDelta extends Delta {
  diagnoses: Diagnosis[];
}

// --- Injected-script <-> host interchange types --------------------------

/**
 * The surface the injected page script installs on `window.__deltawright`. The host
 * calls these across the Playwright evaluate boundary; keeping the contract here (not
 * in the injected file) lets the host type its evaluate returns without importing the
 * injected module or leaking a global `Window` augmentation to package consumers.
 */
export interface DeltawrightApi {
  arm(inWindowRecurrence?: boolean): void;
  sampleBaseline(opts: BaselineOptions): Promise<{ sampledMs: number; footprintSize: number }>;
  waitForSettle(opts: SettleOptions): Promise<SettleResult>;
  collect(opts: SettleOptions): Promise<CollectResult>;
  /** Gap-E (#49): wait out the late-watch window and report whether a late wave landed. */
  lateResult(): Promise<{ lateStructural: boolean }>;
  /** Gap-F (#50): wait, then re-read every stamped node's current geometry (host compares). */
  recheckRects(rectRecheckMs: number): Promise<Array<{ ref: string; geometry: GeometryRead }>>;
  reset(): void;
}

/** Tunable v0.1 settle heuristic knobs (all ms). */
export interface SettleOptions {
  /** Declare settled after the DOM is quiet for this long (after >=1 mutation). */
  quietMs: number;
  /** Hard cap on total wait from arm, regardless of quiescence. */
  maxWaitMs: number;
  /** Budget for waiting out CSS animations/transitions before reading geometry. */
  animMaxMs: number;
  /**
   * Gap-E late-wave watch (#49, opt-in). After settle resolves, keep watching (with a
   * SEPARATE observer, so nothing new is captured) for this long; a structural mutation in
   * the window sets `SettleResult.lateStructural`. Default 0 = off = byte-unchanged.
   */
  lateWatchMs?: number;
}

export interface SettleResult {
  settleMs: number;
  hitMaxWait: boolean;
}

export interface CollectResult {
  nodes: RawNode[];
  rawRecords: number;
  animationsAwaited: number;
  droppedBackground: number;
  /** Freshly-added subtree roots detached again before collect (#71 fix #3). Host maps >0 → the
   * default-absent `DeltaStats.detachedReRender` flag. Always present here (internal interchange). */
  detachedInWindow: number;
}

/**
 * Pre-arm baseline sampling for causal attribution (#15): observe the page briefly
 * before the action to learn which (element, channel) pairs are already churning, so
 * that background is excluded from the delta rather than attributed to the action.
 */
export interface BaselineOptions {
  /** Max time to sample the pre-action background footprint, ms. */
  baselineMs: number;
  /** If no mutation is seen within this long, the page is quiet — exit early, ms. */
  earlyExitMs: number;
}
