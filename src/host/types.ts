// Shared types for the Deltawright delta. The injected page script produces a
// `RawDelta` (geometry + change classification, no Playwright knowledge); the
// host annotates each node with Playwright's authoritative actionability verdict
// to produce a `Delta`, which the serializer renders to the compact text format.

import type { RootCauseCode } from './taxonomy';
import type { Confidence } from './confidence';
import type { LiveRoutingReport } from './live-routing';

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
/** An accessibility STATE attribute's value transition on an attrChanged node (#8). */
export interface AttrStateChange {
  attr: string;
  /** The attribute's value before the action (null = it was absent). */
  old: string | null;
  /** The attribute's value after the action (null = it was removed). */
  new: string | null;
}

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
  /**
   * Accessibility STATE transitions (#8): the old→new VALUES for allowlisted state attributes
   * (aria-expanded/selected/checked/pressed/…, disabled, open, …) that changed — the direction the
   * mutation delta's `changedAttrs` names alone can't express ("the menu is now open"). Present only
   * for an attrChanged node that toggled a state attribute, so the default surface is byte-unchanged.
   * ADDITIVE + non-authoritative: it annotates the SAME node (never relabels role/name — DW-03) and
   * does not affect the verdict (DW-02) or the checksum fingerprint.
   */
  stateChanges?: AttrStateChange[];
  /**
   * Live-region politeness (#8): set when this node is inside a region that ANNOUNCES changes to
   * assistive tech (`aria-live="polite"|"assertive"`, or `role=status|log`→polite / `role=alert`→
   * assertive). An `aria-live="off"` (or empty = default off) region is explicitly silenced, so it is
   * treated as no live region and this stays unset — the field never claims an announcement that ARIA
   * suppresses. Annotation only, no verdict impact.
   */
  ariaLive?: string;
  /** null for removed nodes (no live geometry). */
  geometry: GeometryRead | null;
}

/**
 * The relationship between a value-bearing action's INTENDED value and the field's COMMITTED value,
 * read after the settle window (v0.9 Move 1). Language- and obfuscation-independent — a pure
 * string comparison, no role/name/text. The three LOSS shapes (committed is a shorter subsequence of
 * intent AND a letter/number was dropped) ground `input-not-committed`; `transformed` is deliberately
 * NOT flagged (an intended mask is indistinguishable from corruption — DW-03); `clean` means equal.
 */
export type InputShape =
  | 'clean' // committed === intended
  | 'never-committed' // committed is empty while intent had content (an async widget cleared it)
  | 'truncated' // committed is a proper prefix of intent (a length-limited field)
  | 'dropped' // committed is a non-prefix subsequence of intent with a letter/number dropped
  | 'transformed'; // a case/reorder mask, OR only separators/whitespace removed — NOT flagged

/**
 * Post-settle input-integrity fact (v0.9 Move 1). Present on `DeltaStats` ONLY when the opt-in
 * `inputIntegrity` read ran AND the committed value drifted (shape !== 'clean'), so the default
 * path is byte-unchanged. PRIVACY: it carries only the shape + the two LENGTHS — never the raw
 * intended/committed strings (which can be a password or PII). Grounds `input-not-committed`.
 */
export interface InputIntegrityStat {
  shape: Exclude<InputShape, 'clean'>;
  /** Length of the value the caller intended to enter. */
  intendedLen: number;
  /** Length of the value the field actually committed after settle. */
  committedLen: number;
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
   * Background-churn flag (#7 detection): the peak number of times a single element-insertion
   * signature recurred DURING the settle window for a container NOT already in the pre-arm
   * background baseline — i.e. churn (toasts, virtualized rows, a polling feed) that STARTED after
   * the action. Always computed (zero added latency), but PRESENT ONLY at/above the suspected
   * threshold, so a normal page's stats object is byte-unchanged. Grounds `background-churn`
   * (suspected). NON-behavioral: settle timing and delta membership are unchanged — this only
   * explains a live-page settle-timeout / noise; per #30 in-window signal must flag, never drop.
   */
  recurringInsert?: number;
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
  /**
   * Post-settle input-integrity (v0.9 Move 1, opt-in via `actAndObserve`'s `inputIntegrity`). Set
   * ONLY when the option ran AND the committed value drifted from the intended value (a loss shape
   * OR a transform); absent on every action that did not opt in (or committed cleanly), so the
   * default path is byte-unchanged. `diagnose()` maps its loss shapes → `input-not-committed`
   * (suspected). PRIVACY: no raw values — see `InputIntegrityStat`.
   */
  inputIntegrity?: InputIntegrityStat;
  /**
   * Move 3 flag (opt-in via `awaitQuiescence`): whether the app was network-idle (no in-flight
   * XHR/fetch, no framework hook busy) at the settle point. Present ONLY when `awaitQuiescence` ran,
   * so the default stats object is byte-unchanged. `false` alongside `hitMaxWait` means the app was
   * still making requests when the cap was hit — a genuinely-not-ready signal.
   */
  quiescent?: boolean;
  /**
   * Live ownership-routing report (v0.9 Move 2 live arm, opt-in via `actAndObserve`'s `routeSignals`).
   * Present ONLY when the option ran — the page listeners were attached around the action + settle and
   * captured co-occurring response/pageerror/console signals; absent on every action that did not opt
   * in, so the default path is byte-unchanged. CO-OCCURRENCE metadata, never causation: it emits no
   * taxonomy code and never changes a verdict (DW-02/03). See {@link LiveRoutingReport}.
   */
  routing?: LiveRoutingReport;
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
  /**
   * Preflight (#53): read one element's geometry on demand, for the actionability matcher's
   * `[geom:]` annotation. Additive and stateless — it never touches the observer/arm/collect
   * state, so it works standalone (no prior actAndObserve) and is a no-op when absent (the host
   * degrades to a Playwright-only verdict if injection was blocked). Called via
   * `locator.evaluate(el => window.__deltawright.probeGeometry(el))`.
   */
  probeGeometry(el: Element): GeometryRead;
  /** Move 3 (opt-in): install the in-flight XHR/fetch counter. The host calls this BEFORE the action
   *  ONLY when `awaitQuiescence` is set, so a default run leaves the page's native fetch/XHR untouched
   *  (non-interference). Idempotent. */
  enableQuiescence(): void;
  /** Move 3: read-only network-idle probe — true when no XHR/fetch is in flight and no framework
   *  idle hook (e.g. `Ext.Ajax.isLoading`) is busy. The settle path reads it when `awaitQuiescence`. */
  isQuiescent(): boolean;
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
  /**
   * Framework-agnostic network-idle quiescence (v0.9 Move 3, opt-in). When true, settle resolves
   * only once the DOM is quiet AND the app's in-flight request count is zero (a monkey-patched
   * XHR/fetch counter — an accurate count of requests made through the patched globals, not a
   * heuristic; it does not see a fetch called via a reference captured before the patch, or a child
   * frame's own globals), plus any framework idle hook (`Ext.Ajax.isLoading`). Still bounded by
   * `maxWaitMs` (a cap always resolves). Read-only: it never
   * fires events or forces loads. This is "act/observe when the app is actually ready" for RPC-driven
   * legacy apps — improving the observe-consequences niche. Default false = the settle logic is
   * byte-unchanged. NOTE: GWT's zero-network `Scheduler` deferred waves are NOT network, so this does
   * not catch them (that is `#49`'s late-watch); it catches XHR/fetch/GWT-RPC in-flight work.
   */
  awaitQuiescence?: boolean;
}

export interface SettleResult {
  settleMs: number;
  hitMaxWait: boolean;
  /**
   * Move 3: present ONLY when `awaitQuiescence` was set — whether the app was network-idle
   * (in-flight count 0, no framework hook busy) at the settle point. `false` at a `maxWaitMs` cap
   * means the app was STILL making requests when we gave up (a genuinely-not-ready signal). Absent
   * on the default path, so the default `SettleResult` is byte-unchanged.
   */
  quiescent?: boolean;
}

/**
 * Default v0.1 settle knobs. Lives on this side-effect-free leaf (not in actAndObserve) so lean
 * consumers — e.g. `deltawright/wait` — can reference it without dragging actAndObserve's
 * screenshot-diff/pngjs subtree. `actAndObserve` re-exports it as the canonical home.
 */
export const DEFAULT_SETTLE: SettleOptions = { quietMs: 120, maxWaitMs: 2000, animMaxMs: 1000 };

export interface CollectResult {
  nodes: RawNode[];
  rawRecords: number;
  animationsAwaited: number;
  droppedBackground: number;
  /** Freshly-added subtree roots detached again before collect (#71 fix #3). Host maps >0 → the
   * default-absent `DeltaStats.detachedReRender` flag. Always present here (internal interchange). */
  detachedInWindow: number;
  /** Peak in-window insertion recurrence for a non-baseline signature (#7). Host maps >= the
   * suspected threshold → the default-absent `DeltaStats.recurringInsert`. Always present here. */
  recurringInsert: number;
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
