// Move 2 — honest ownership-routing (offline arm). PURE: given a parsed trace, correlate the
// in-page console/pageError co-events to the failing action's time window and produce a ROUTING
// hint — "this failure may not be Deltawright's DOM-actionability class; route it elsewhere."
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

import type { TraceCoEvent, TraceInfo } from './read-trace';

export type RoutingSignal = TraceCoEvent;

export interface RoutingReport {
  /** Co-occurring signals within the failing action's window, in time order (capped at {@link MAX_SIGNALS}). */
  signals: RoutingSignal[];
  /** Total co-events in the window BEFORE the cap — so truncation is visible, not hidden. */
  windowCount: number;
  /** Uncaught pageError(s) in the window (the strong signal that flips the hint). */
  pageErrorCount: number;
  /**
   * SUSPECTED "not a DOM-actionability cause": a real JS exception co-occurred AND Deltawright did
   * not name a DOM cause (it was unsure, or the failure was not an actionability error). A hint the
   * agent routes on — never an assertion of the cause.
   */
  suspectedNotDomCause: boolean;
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
    suspectedNotDomCause: false,
    recommendation: '',
  };
  const chosen = info.chosenFailure;
  if (!chosen || info.coEvents.length === 0) return empty;

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

  const inScope = info.coEvents.filter((e) => inWindow(e.time, chosen.startTime, rightEdge));
  if (inScope.length === 0) return empty;

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

  let recommendation = '';
  if (suspectedNotDomCause) {
    recommendation =
      `SUSPECTED not-a-DOM-cause: ${pageErrorCount} uncaught JS error(s) co-occurred in the ` +
      'action window and Deltawright named no actionability cause — consider routing to the app ' +
      'owner (a code/app fault) rather than self-healing the selector. Co-occurrence, not proof.';
  }

  return {
    signals,
    windowCount: inScope.length,
    pageErrorCount,
    suspectedNotDomCause,
    recommendation,
  };
}
