// Move 2 — honest ownership-routing (offline arm). PURE: given a parsed trace, produce a ROUTING hint
// — "this failure may not be Deltawright's DOM-actionability class; route it elsewhere." Two channels:
//   • IN-PAGE (console/pageError) — window-correlated to the failing action; a pageError flips
//     `suspectedNotDomCause` → route to the app owner. Empty on a legacy app that swallows its JS errors.
//   • HARNESS (test.trace stdout/stderr backend errors) — TEST-SCOPED (a different clock), where a
//     backend-dominated portal actually logs its gateway 5xx / refused connection → flips
//     `suspectedBackendCause` → route to backend/infra. This is the channel that yields on real
//     legacy-enterprise corpora, where the DOM timeout is a symptom of a backend fault.
//
// The honesty rules are the whole point (DW-03):
//  • CO-OCCURRENCE, NEVER CAUSATION. An error that fired during the window is a candidate the agent
//    weighs, never "the cause". A client-side echo cannot prove a backend/app fault caused the failure.
//  • Only an uncaught `pageError` (a real JS exception) flips the `suspectedNotDomCause` hint. A
//    `console.error` is surfaced as context but never upgraded to a verdict — legacy apps log them
//    constantly, so console-alone would cry wolf.
//  • LIST-AND-CLAMP. Signals are capped and the true in-window count is reported, so a noisy legacy
//    console is summarized honestly, never silently truncated.
//  • It emits NO taxonomy code and touches NO verdict — routing is adjacent metadata, not a diagnosis.

import type { HarnessSignal, TraceCoEvent, TraceInfo } from './read-trace';

export type RoutingSignal = TraceCoEvent;

export interface RoutingReport {
  /** Co-occurring signals within the failing action's window, in time order (capped at {@link MAX_SIGNALS}). */
  signals: RoutingSignal[];
  /** Total co-events in the window BEFORE the cap — so truncation is visible, not hidden. */
  windowCount: number;
  /** Uncaught pageError(s) in the window (the strong signal that flips the in-page hint). */
  pageErrorCount: number;
  /** Backend/infra error lines from the test-runner's output (test-scoped; deduped + capped). */
  harnessSignals: HarnessSignal[];
  /**
   * SUSPECTED "not a DOM-actionability cause": a real JS exception co-occurred AND Deltawright did
   * not name a DOM cause (it was unsure, or the failure was not an actionability error). A hint the
   * agent routes on — never an assertion of the cause.
   */
  suspectedNotDomCause: boolean;
  /**
   * SUSPECTED backend/infra cause: the test-runner logged a backend HTTP/connection error during the
   * run AND Deltawright named no DOM cause → route to backend/infra. TEST-SCOPED (stdout/stderr carry
   * a wall-clock timestamp, not the action-window clock), so it is a weaker, run-level co-occurrence
   * than the window-correlated in-page hint — never a cause.
   */
  suspectedBackendCause: boolean;
  /** One-line routing recommendation, or '' when there is nothing to route. */
  recommendation: string;
}

/** Cap on listed signals — a noisy legacy console must not flood the report. */
export const MAX_SIGNALS = 6;

/** Is `t` within [lo, hi]? Inclusive; treats a missing bound as unbounded on that side. */
function inWindow(t: number, lo: number | undefined, hi: number | undefined): boolean {
  if (lo !== undefined && t < lo) return false;
  if (hi !== undefined && t > hi) return false;
  return true;
}

/**
 * Derive the routing report for a trace. `domCauseNamed` is whether Deltawright's own diagnosis named
 * a DOM-actionability cause for this failure (from diagnose-trace) — when it did, the failure IS
 * Deltawright's class and co-events are only context; when it did not, a co-occurring JS error becomes
 * a route-elsewhere hint.
 */
export function deriveRouting(info: TraceInfo, opts: { domCauseNamed: boolean }): RoutingReport {
  const empty: RoutingReport = {
    signals: [],
    windowCount: 0,
    pageErrorCount: 0,
    harnessSignals: [],
    suspectedNotDomCause: false,
    suspectedBackendCause: false,
    recommendation: '',
  };
  const chosen = info.chosenFailure;
  // A backend error in the harness output is a routing signal even with no in-page co-events, so we
  // proceed when EITHER channel has something (the empty short-circuit needs both to be empty).
  if (!chosen || (info.coEvents.length === 0 && info.harnessSignals.length === 0)) return empty;

  // The failing action's window is [startTime, rightEdge]. The right edge is the action's own
  // endTime; on an edge trace that lacks one it falls back to the NEXT action's start (actions are
  // start-time ordered). When neither is known — a terminal action with no endTime — the right edge
  // is unbounded: co-events are still LISTED as context, but the hint must NOT flip on an unbounded
  // window (an unrelated later exception could otherwise manufacture a route). startTime is always a
  // number from the reader, so the left edge is always bounded.
  const idx = info.actions.findIndex((a) => a.callId === chosen.callId);
  const nextStart =
    idx >= 0 && idx + 1 < info.actions.length ? info.actions[idx + 1]!.startTime : undefined;
  const rightEdge = chosen.endTime ?? nextStart;

  // --- In-page channel: window-correlated console/pageError ---
  const inScope = info.coEvents.filter((e) => inWindow(e.time, chosen.startTime, rightEdge));
  const pageErrorCount = inScope.filter((e) => e.kind === 'pageerror').length;
  // The hint requires a BOUNDED window (a real co-occurrence), never an open-ended [startTime, ∞).
  const suspectedNotDomCause = pageErrorCount > 0 && !opts.domCauseNamed && rightEdge !== undefined;
  // Keep the pageError(s) in the capped list FIRST — they are the evidence the recommendation cites,
  // so the clamp must never slice out the very signal that flipped the hint. Re-sort by time so the
  // displayed order is still chronological; windowCount stays the true pre-cap total.
  const signals = [
    ...inScope.filter((e) => e.kind === 'pageerror'),
    ...inScope.filter((e) => e.kind !== 'pageerror'),
  ]
    .slice(0, MAX_SIGNALS)
    .sort((a, b) => a.time - b.time);

  // --- Harness channel: test-scoped backend/infra errors from the runner's stdout/stderr ---
  const harnessSignals = info.harnessSignals;
  const suspectedBackendCause = harnessSignals.length > 0 && !opts.domCauseNamed;

  // --- Recommendation: name whichever route(s) fired; backend and app-JS are distinct routes. ---
  const routes: string[] = [];
  if (suspectedBackendCause) {
    const buckets = [...new Set(harnessSignals.map((h) => h.bucket))].sort().join(', ');
    routes.push(
      `route to BACKEND/INFRA — the test-runner logged ${harnessSignals.length} backend error line(s) [${buckets}] during this run (test-scoped)`,
    );
  }
  if (suspectedNotDomCause) {
    routes.push(
      `route to the APP OWNER — ${pageErrorCount} uncaught JS error(s) co-occurred in the action window`,
    );
  }
  const recommendation = routes.length
    ? `SUSPECTED not-a-DOM-cause (Deltawright named no actionability cause): ${routes.join('; also ')} — prefer routing over self-healing the selector. Co-occurrence, not proof.`
    : '';

  return {
    signals,
    windowCount: inScope.length,
    pageErrorCount,
    harnessSignals,
    suspectedNotDomCause,
    suspectedBackendCause,
    recommendation,
  };
}
