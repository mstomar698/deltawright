// v0.9 Move 2 — honest ownership-routing (LIVE arm). The parallel of the OFFLINE trace arm
// (`src/trace/routing.ts`): "this failure may not be Deltawright's DOM-actionability class; route it
// elsewhere." The offline arm is capped by what a trace records — a legacy app that swallows its JS
// errors leaves the in-page channel empty. The live arm instead catches responses / requestfailed /
// pageerrors / console errors AS THEY HAPPEN via `page.on(...)`, scoped to the action+settle window
// (the listener LIFETIME is the window — no timestamp math), so it yields on the LIVE path even when a
// trace would be silent.
//
// The honesty rules follow the offline arm (DW-03), but the live network channel is deliberately WIDER
// than the offline harness channel — disclosed here and in the ADR so it is never mistaken for parity:
//  • CO-OCCURRENCE, NEVER CAUSATION. An event that fired during the window is a candidate the agent
//    weighs, never "the cause". A client-side echo cannot prove a backend/app fault caused the failure.
//  • Only an uncaught `pageerror` (a real JS exception) may flip `suspectedNotDomCause`, and only when
//    Deltawright named NO DOM actionability cause. A `console.error` is surfaced as context but never
//    upgraded to a verdict — legacy apps log them constantly, so console-alone would cry wolf.
//  • A page-wide status ≥ 400 response OR a `requestfailed` flips `suspectedBackendCause` — but a
//    CLIENT-ABORT requestfailed (`net::ERR_ABORTED`) is EXCLUDED (the page cancelled its own request,
//    not a backend fault). This channel is page-wide + ALL-ORIGIN (it can see a third-party analytics
//    404/429), UNLIKE the offline arm, which reads only curated harness backend-error log lines. So the
//    backend hint is framed as a co-occurrence signal to WEIGH, never a directive "route to backend".
//  • LIST-AND-CLAMP. Signals are capped and the true in-window count is reported, so a noisy legacy
//    console is summarized honestly, never silently truncated.
//  • It emits NO taxonomy code and touches NO verdict — routing is adjacent metadata, not a diagnosis.
//    Playwright's action outcome stays authoritative and is NEVER overridden (DW-02).
//
// PRIVACY: console text and response URLs can carry PII, so the report NEVER surfaces a full raw URL
// or full console text — only a kind, a status, a query-stripped URL path, and a length-capped snippet.
// (Mirrors the redaction stance elsewhere: input-integrity surfaces lengths/shape, MCP labels are
// redacted.)

import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

/** The channel a co-occurring live signal came from. Mirrors the offline `TraceCoEvent.kind` plus the
 *  two network channels a trace does not expose the same way (`response`, `requestfailed`). */
export type LiveSignalKind =
  'pageerror' | 'console-error' | 'console-warning' | 'response' | 'requestfailed';

/** Cap on listed signals — a noisy legacy console must not flood the report. Mirrors the offline
 *  `MAX_SIGNALS` in `src/trace/routing.ts` (kept local so the live arm stays decoupled from trace
 *  parsing). */
export const MAX_SIGNALS = 6;

/** Length cap for a redacted console/pageerror snippet (privacy — never the full text). */
export const SNIPPET_MAX = 200;

/**
 * A RAW captured event — plain, browser-independent data. The impure collector fills it (holding the
 * full URL / message in memory only transiently); the PURE builder redacts it into a
 * {@link LiveRoutingSignal}. Kept as the builder's input so the builder is unit-testable without a
 * browser, and so redaction (a pure transform) is exercised by the pure tests.
 */
export interface RawLiveSignal {
  kind: LiveSignalKind;
  /** For `response`: the HTTP status (>= 400 only — the collector drops the rest). */
  status?: number;
  /** For `response`/`requestfailed`: the full URL (the builder strips the query string). */
  url?: string;
  /** For `pageerror`/`console-*`/`requestfailed`: the message/error text (the builder caps it). */
  text?: string;
}

/** The collector's output / the builder's input: co-occurring events in fire order (chronological). */
export interface CollectedLiveSignals {
  /** Raw events captured during the window, in the order they fired. The builder redacts + clamps. */
  raw: RawLiveSignal[];
}

/** One redacted co-occurring signal as surfaced to the caller (no raw URL or full console text). */
export interface LiveRoutingSignal {
  kind: LiveSignalKind;
  /** For `response`: the HTTP status code (>= 400). */
  status?: number;
  /** For `response`/`requestfailed`: the URL PATH — query string stripped (privacy). */
  path?: string;
  /** For `pageerror`/`console-*`/`requestfailed`: a length-capped message snippet (privacy). */
  snippet?: string;
}

/**
 * The live ownership-routing report — the parallel of the offline `RoutingReport`. Present on
 * `DeltaStats.routing` ONLY when the caller opted in via `actAndObserve`'s `routeSignals`, so the
 * default path is byte-unchanged. Field names are kept consistent with the offline report.
 */
export interface LiveRoutingReport {
  /** Co-occurring signals captured in the window, capped at {@link MAX_SIGNALS} (pageerror kept first). */
  signals: LiveRoutingSignal[];
  /** Total co-events in the window BEFORE the cap — so truncation is visible, not hidden. */
  windowCount: number;
  /** Uncaught pageerror(s) in the window (the strong signal that flips the in-page hint). */
  pageErrorCount: number;
  /** Status-≥400 responses + failed requests (EXCLUDING client aborts) in the window — page-wide,
   *  all-origin. The signal that flips the backend hint. */
  backendCount: number;
  /**
   * SUSPECTED "not a DOM-actionability cause": a real JS exception co-occurred AND Deltawright named
   * no DOM actionability cause. A hint the agent routes on — never an assertion of the cause.
   */
  suspectedNotDomCause: boolean;
  /**
   * SUSPECTED backend/infra cause: a status-≥400 response or a non-abort failed request co-occurred
   * (page-wide, all-origin) AND Deltawright named no DOM cause → a signal to WEIGH toward backend/infra.
   * Co-occurrence only, never a cause — and wider than the offline arm's curated-log channel.
   */
  suspectedBackendCause: boolean;
  /** One-line routing recommendation, or '' when there is nothing to route. */
  recommendation: string;
}

/** Strip the query string (and any userinfo) from a URL — surface only origin + path (privacy). */
function urlPath(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    // Not a parseable URL — best-effort: drop anything after '?'.
    return raw.split('?')[0] ?? raw;
  }
}

/** Collapse whitespace and cap to {@link SNIPPET_MAX} chars, appending a length indicator when cut. */
function snippet(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_MAX) return text;
  return `${text.slice(0, SNIPPET_MAX)}… (${text.length} chars)`;
}

/** Redact one raw event into a leak-free surfaced signal (query-stripped path, capped snippet). */
function redact(e: RawLiveSignal): LiveRoutingSignal {
  const sig: LiveRoutingSignal = { kind: e.kind };
  if (e.status !== undefined) sig.status = e.status;
  if (e.url !== undefined) sig.path = urlPath(e.url);
  if (e.text !== undefined && e.text.length > 0) sig.snippet = snippet(e.text);
  return sig;
}

/**
 * Derive the live routing report from the collected signals. PURE — no browser, no page. `domCauseNamed`
 * is whether Deltawright named a DOM-actionability cause for this action: in `actAndObserve` the action
 * reached settle through Playwright (its outcome was SUCCESS), so no DOM cause was named and a
 * co-occurring JS error / backend error becomes a route-elsewhere hint; a review or a diagnosis that
 * DID name a DOM cause passes `true`, suppressing the flip (the co-events stay context, not a route).
 */
export function buildLiveRouting(
  collected: CollectedLiveSignals,
  opts: { domCauseNamed: boolean },
): LiveRoutingReport {
  const raw = collected.raw;
  const pageErrorCount = raw.filter((e) => e.kind === 'pageerror').length;
  const backendCount = raw.filter(
    (e) => e.kind === 'response' || e.kind === 'requestfailed',
  ).length;

  // Only an uncaught pageerror flips the in-page hint (a console.error is context, never a verdict);
  // a 4xx/5xx or a failed request flips the backend hint. Both suppressed when DW named a DOM cause.
  const suspectedNotDomCause = pageErrorCount > 0 && !opts.domCauseNamed;
  const suspectedBackendCause = backendCount > 0 && !opts.domCauseNamed;

  // LIST-AND-CLAMP: keep the pageerror(s) FIRST — they are the evidence the recommendation cites, so
  // the clamp must never slice out the very signal that flipped the hint. The rest stay in fire order.
  // windowCount stays the TRUE pre-cap total, so truncation is visible.
  const ordered = [
    ...raw.filter((e) => e.kind === 'pageerror'),
    ...raw.filter((e) => e.kind !== 'pageerror'),
  ];
  const signals = ordered.slice(0, MAX_SIGNALS).map(redact);

  // Recommendation — name whichever route(s) fired; backend and app-JS are distinct routes. Same
  // phrasing style as the offline arm.
  const routes: string[] = [];
  if (suspectedBackendCause) {
    // Honest CO-OCCURRENCE, not a directive: the backend channel is page-wide + all-origin (it also
    // sees third-party responses), so "N HTTP errors co-occurred" is a signal to WEIGH, never proof
    // that a backend fault caused THIS failure. (The offline harness arm reads curated backend-error
    // log lines and is narrower — see the ADR disclosure.)
    routes.push(
      `${backendCount} HTTP error response(s)/failed request(s) co-occurred in the window (observed page-wide, all origins) — WEIGH as a possible backend/infra signal, not a cause`,
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
    windowCount: raw.length,
    pageErrorCount,
    backendCount,
    suspectedNotDomCause,
    suspectedBackendCause,
    recommendation,
  };
}

/** A live-routing collection session: listeners are attached, and `detach()` removes them and returns
 *  what fired during their lifetime (the action+settle window). */
export interface LiveRoutingCollector {
  detach(): CollectedLiveSignals;
}

/**
 * IMPURE half: attach the four page-level listeners and collect co-occurring signals into raw data.
 * The listener LIFETIME is the routing window — the caller attaches just before the action and calls
 * `detach()` after settle closes (in a `finally`, so a throwing action can't leak them). Named handler
 * refs + `page.off(...)` (never `removeAllListeners`, which would nuke unrelated listeners), so the
 * page's listener counts return to their pre-attach baseline.
 */
export function attachLiveRouting(page: Page): LiveRoutingCollector {
  const raw: RawLiveSignal[] = [];

  const onResponse = (res: Response): void => {
    const status = res.status();
    if (status >= 400) raw.push({ kind: 'response', status, url: res.url() });
  };
  const onRequestFailed = (req: Request): void => {
    const errorText = req.failure()?.errorText;
    // EXCLUDE a client-side cancellation. `net::ERR_ABORTED` is the page/test cancelling its OWN request
    // — a superseded fetch, an abandoned navigation, an AbortController — NOT a backend/infra fault.
    // Counting it would flip the backend hint on a healthy page merely because a cancel co-occurred in
    // the settle window. Match ONLY that sentinel (word-bounded): a genuine `net::ERR_CONNECTION_ABORTED`
    // (a connection dropped by the network/server) contains "ABORTED" but is a REAL infra fault and must
    // be kept — as are ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, ERR_TIMED_OUT, ….
    if (errorText && /\bERR_ABORTED\b/i.test(errorText)) return;
    raw.push({ kind: 'requestfailed', url: req.url(), text: errorText });
  };
  const onPageError = (err: Error): void => {
    raw.push({ kind: 'pageerror', text: err.message });
  };
  const onConsole = (msg: ConsoleMessage): void => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      raw.push({
        kind: type === 'error' ? 'console-error' : 'console-warning',
        text: msg.text(),
      });
    }
  };

  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('pageerror', onPageError);
  page.on('console', onConsole);

  return {
    detach(): CollectedLiveSignals {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      return { raw };
    },
  };
}
