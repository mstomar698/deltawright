// Move 2 — honest ownership-routing (offline arm). PURE: given a parsed trace, produce a ROUTING hint
// — "this failure may not be Deltawright's DOM-actionability class; route it elsewhere." Three channels:
//   • IN-PAGE (console/pageError) — window-correlated to the failing action; a pageError flips
//     `suspectedNotDomCause` → route to the app owner. Empty on a legacy app that swallows its JS errors.
//   • NETWORK (the trace's `*.network` member) — HTTP error responses (status ≥ 400), WINDOW-CORRELATED
//     to the failing action on the SAME monotonic clock. A 5xx in the action's own window → flips
//     `suspectedBackendCause` → route to backend. This closes the offline↔live asymmetry for the
//     field-dominant class: a backend fault presenting as a DOM timeout. (debug A / trace-native.)
//   • HARNESS (test.trace stdout/stderr backend errors) — TEST-SCOPED (a different clock), where a
//     backend-dominated portal logs its gateway 5xx / refused connection → also flips
//     `suspectedBackendCause`. The two backend channels are complementary (structured vs stdout).
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

import type { HarnessSignal, TraceCoEvent, TraceInfo, TraceNetworkEvent } from './read-trace';

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
  /** HTTP error responses (status ≥ 400) from the trace's `*.network` member that co-occurred in the
   *  failing action's window, time-ordered + capped at {@link MAX_SIGNALS} — the structured backend
   *  channel (window-correlated, unlike the test-scoped harness channel). */
  networkSignals: TraceNetworkEvent[];
  /** Total in-window HTTP error responses BEFORE the cap — truncation is visible, not hidden. */
  networkErrorCount: number;
  /**
   * SUSPECTED "not a DOM-actionability cause": a real JS exception co-occurred AND Deltawright did
   * not name a DOM cause (it was unsure, or the failure was not an actionability error). A hint the
   * agent routes on — never an assertion of the cause.
   */
  suspectedNotDomCause: boolean;
  /**
   * SUSPECTED backend/infra cause: an HTTP error response (status ≥ 400) co-occurred in the failing
   * action's WINDOW (the trace `*.network` channel, monotonic-correlated) AND/OR the test-runner logged a
   * backend error during the run (the HARNESS channel, test-scoped) — AND Deltawright named no DOM cause,
   * so route to backend. The network channel is window-correlated (a real co-occurrence); the harness
   * channel is a weaker run-level co-occurrence (a wall-clock stdout line). Either way — never a cause.
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
    networkSignals: [],
    networkErrorCount: 0,
    suspectedNotDomCause: false,
    suspectedBackendCause: false,
    recommendation: '',
  };
  const chosen = info.chosenFailure;
  // A backend error (harness stdout OR a trace network 5xx) is a routing signal even with no in-page
  // co-events, so we proceed when ANY channel has something (the empty short-circuit needs all empty).
  if (
    !chosen ||
    (info.coEvents.length === 0 &&
      info.harnessSignals.length === 0 &&
      info.networkEvents.length === 0)
  ) {
    return empty;
  }

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
  const suspectedBackendFromHarness = harnessSignals.length > 0 && !opts.domCauseNamed;

  // --- Network channel: HTTP error responses (status ≥ 400) from the trace's own `*.network` member,
  //     WINDOW-CORRELATED to the failing action (monotonic clock). Like the in-page hint, the flip
  //     requires a BOUNDED window (a real co-occurrence, never an open-ended [start, ∞)); the signals are
  //     still listed as context on an unbounded window. Page-wide + all-origin (a third-party 4xx can
  //     appear) — that width is disclosed in the recommendation, never upgraded to "the backend caused it".
  const netInScope = info.networkEvents.filter((e) =>
    inWindow(e.time, chosen.startTime, rightEdge),
  );
  const networkErrorCount = netInScope.length;
  // networkEvents are already time-sorted by parseNetworkEvents, and a filter preserves order → the
  // first MAX_SIGNALS are the earliest in-window errors (list-and-clamp; networkErrorCount is the total).
  const networkSignals = netInScope.slice(0, MAX_SIGNALS);
  const suspectedBackendFromNetwork =
    networkErrorCount > 0 && !opts.domCauseNamed && rightEdge !== undefined;

  const suspectedBackendCause = suspectedBackendFromHarness || suspectedBackendFromNetwork;

  // --- Recommendation: name whichever route(s) fired; backend and app-JS are distinct routes. ---
  const routes: string[] = [];
  if (suspectedBackendFromNetwork) {
    const statuses = [...new Set(netInScope.map((e) => e.status))].sort((a, b) => a - b).join(', ');
    routes.push(
      `route to BACKEND — the trace recorded ${networkErrorCount} HTTP error response(s) [status ${statuses}] in this action's own window (all origins)`,
    );
  }
  if (suspectedBackendFromHarness) {
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
    networkSignals,
    networkErrorCount,
    suspectedNotDomCause,
    suspectedBackendCause,
    recommendation,
  };
}
