// Read a Playwright `trace.zip` into the minimal shape #9 needs: the failed action's method,
// selector, and the FULL error string a live `catch (e) { e.message }` would carry. The trace
// format is internal, undocumented, and version-migrated, so we (a) parse the JSONL ourselves —
// never import `playwright-core` internals — and (b) hard-refuse any trace `version` we have not
// validated, so we never mis-parse a shifted format. Currently validated: trace v8 (PW 1.4x–1.6x).
//
// The one subtlety worth stating: an action's terse error is just "Timeout Nms exceeded." — the
// actionability CAUSE ("… intercepts pointer events", "element is not enabled", …) lives in the
// separate `log` (retry call-log) events. Live Playwright concatenates them into the thrown
// message; we reconstruct the same string so the shared diagnose() reads the identical signal.

import { readZipEntry, zipEntryNames } from './zip';

/** Trace `version`s whose event shape this reader has been validated against. */
export const SUPPORTED_TRACE_VERSIONS: ReadonlySet<number> = new Set([8]);

/** A trace whose `version` is outside {@link SUPPORTED_TRACE_VERSIONS} — refused, not guessed. */
export class UnsupportedTraceVersionError extends Error {
  constructor(
    readonly version: number,
    readonly supported: readonly number[],
  ) {
    super(
      `unsupported Playwright trace version ${version} (supported: ${supported.join(', ')}). ` +
        `Regenerate the trace with a compatible Playwright, or update deltawright.`,
    );
    this.name = 'UnsupportedTraceVersionError';
  }
}

/** A file that is not a parseable Playwright trace (no context-options / no trace member). */
export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceParseError';
  }
}

/**
 * A co-occurring event in the trace that is NOT a Playwright action — an in-page `console` error/
 * warning or an uncaught `pageError` (Move 2 routing). It is surfaced as a ROUTING SIGNAL only:
 * co-occurrence is not causation (DW-03), so it never becomes a taxonomy code or a verdict.
 */
export interface TraceCoEvent {
  kind: 'pageerror' | 'console-error' | 'console-warning';
  /** The message text (single line, trimmed + capped). */
  text: string;
  /** Trace-relative time (ms) the event fired — for correlating to the failing action's window. */
  time: number;
}

/**
 * A BACKEND/infra error line found in the test-runner's own output (`test.trace` stdout/stderr, or the
 * test-level `error` event) — Move 2 harness routing. On a backend-dominated legacy portal the fault
 * (a gateway 5xx, a refused connection) is logged HERE, not in the browser console. UNLIKE the in-page
 * co-events, stdout/stderr carry a wall-clock `timestamp` (not the action-relative `time`), so these
 * are TEST-SCOPED — "logged during this test run", not correlated to the failing action's window. A
 * routing candidate, never a cause (DW-03).
 */
export interface HarnessSignal {
  source: 'stdout' | 'stderr' | 'error';
  /** Generic infra bucket — `5xx/gateway`, `4xx`, or `conn/network`. Never an app-specific identifier. */
  bucket: string;
  /** The matched line (single line, capped). */
  text: string;
}

// A backend/infra error shape in harness output. Every alternative requires an HTTP/status/connection
// CONTEXT — never a bare 3-digit number, which would false-match a stack frame (`app.js:504:12`), a
// latency (`503 ms`), a count/ID (`processed 500 records`), a coordinate, or a failed-assertion literal
// (`Expected: 504`). It also EXCLUDES a bare "timeout" (the test's OWN failure — circular). So only
// "a request to the backend failed" survives, distinct from the DOM timeout (precision over recall).
const BACKEND_ERROR =
  /responded with a status of (?:4\d\d|5\d\d)|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\binternal server error\b|\b(?:status(?:\s*code)?|http)\b[:/ =]{0,4}(?:4\d\d|5\d\d)\b|\b(?:4\d\d|5\d\d)\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|too many requests|not found|forbidden|unauthorized|request timeout)\b|\bhttp[/ ]?\d(?:\.\d)?\s*(?:4\d\d|5\d\d)\b|\beconn(?:refused|reset|aborted)\b|\bsocket hang up\b|\benotfound\b|\bnetwork error\b/i;

// Classify an ALREADY-MATCHED backend line into a generic infra bucket (never app-specific). Order:
// connection → 5xx → 4xx (the line already matched BACKEND_ERROR, so a non-conn, non-5xx line is 4xx).
function harnessBucket(line: string): string {
  if (
    /\beconn(?:refused|reset|aborted)\b|\bsocket hang up\b|\benotfound\b|\bnetwork error\b/i.test(
      line,
    )
  )
    return 'conn/network';
  if (/bad gateway|service unavailable|gateway time|internal server error|\b5\d\d\b/i.test(line))
    return '5xx/gateway';
  return '4xx';
}

export interface TraceAction {
  callId: string;
  /** click / fill / press / … (or `action` when the trace did not name it). */
  method: string;
  /** The action's target selector, when it had one. */
  selector?: string;
  /** Action start time (ms), from the `before` event — the left edge of its window. */
  startTime?: number;
  /** Action end time (ms), from the matched `after` event — the right edge of its window. */
  endTime?: number;
  /** The action's terse error (`{ message, name }`), present only on a failed action. */
  error?: { message: string; name?: string };
  /** The full retry call-log messages, in time order — where the actionability cause is recorded. */
  callLog: string[];
  /**
   * The single concrete cause line extracted from the call-log (e.g. `<div…> intercepts pointer
   * events`, `element is not enabled`), or undefined when the log named no specific cause. This is
   * the actionability SIGNAL, with the retry/scroll/wait boilerplate stripped.
   */
  causeLine?: string;
  /**
   * The concise grounding error the diagnosis reads: `method: <terse message>[ — <causeLine>]`.
   * It carries the cause keyword (so `codeFromPlaywrightError` keys on it) WITHOUT the repeated
   * call-log — and, unlike the raw log, it excludes the `locator resolved to <…>` line whose HTML
   * could carry a stray keyword (e.g. a `disabled` attribute) and mis-key a different failure.
   */
  errorText: string;
  /** True when this action carried an error (it failed). */
  failed: boolean;
}

export interface TraceInfo {
  traceVersion: number;
  playwrightVersion?: string;
  browserName?: string;
  sdkLanguage?: string;
  /** All actions, in start-time order. */
  actions: TraceAction[];
  /** The subset that failed, in start-time order. */
  failed: TraceAction[];
  /** In-page console error/warning + uncaught pageError events, in time order (Move 2 routing). */
  coEvents: TraceCoEvent[];
  /** Backend/infra error lines from the test-runner's own output (test-scoped; Move 2 harness routing). */
  harnessSignals: HarnessSignal[];
  /**
   * The failure to diagnose: the LAST failed action. In a normal test, execution stops at the
   * first unhandled throw, so there is exactly one; when soft assertions / try-catch produce
   * several, the last is the one nearest the reported end of the run. Null when nothing failed.
   */
  chosenFailure: TraceAction | null;
}

// Playwright's call-log interleaves the actionability cause with retry/scroll/wait boilerplate.
// These patterns are that boilerplate; whatever remains is the concrete cause line. The
// `locator resolved to …` line is INTENTIONALLY boilerplate — its resolved-element HTML can carry
// an incidental keyword (a `disabled` attribute on a covered button) that would mis-key the cause.
// The `retrying …` / `attempting …` matchers are keyword-anchored (not end-anchored) so Playwright's
// real suffixes — `retrying click action (trial run)`, `retrying click action, attempt #2` — are
// still stripped and never mistaken for the cause line.
const CALL_LOG_BOILERPLATE: readonly RegExp[] = [
  /^waiting for locator\b/,
  /^locator resolved to\b/,
  /^attempting\b/,
  /^retrying\b/,
  /^waiting\b/, // "waiting 20ms", "waiting for element to be visible, enabled and stable", …
  /^scrolling into view\b/,
  /^done scrolling$/,
  /^element is visible, enabled and stable$/,
];

/** The last non-boilerplate call-log line — Playwright's final named cause — or undefined. */
function extractCauseLine(callLog: string[]): string | undefined {
  let cause: string | undefined;
  for (const raw of callLog) {
    const line = raw.trim();
    if (!line) continue;
    if (CALL_LOG_BOILERPLATE.some((re) => re.test(line.toLowerCase()))) continue;
    cause = line;
  }
  return cause;
}

/** First line of a co-event message, trimmed and capped — never a multi-line stack or a novel. */
function capText(s: string): string {
  const firstLine = s.split('\n')[0]!.trim();
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
}

/** Cap on how many harness lines we scan-keep before dedup — a chatty harness must not run away. */
const HARNESS_SCAN_CAP = 200;

/**
 * Scan one stdout/stderr/error blob for BACKEND-error lines and append them (capped). A blob can be
 * multi-line; we keep only the lines that match {@link BACKEND_ERROR} (not every log line), each
 * classified into a generic infra bucket. Text is capped single-line; the raw blob is never retained.
 */
function scanHarness(blob: string, source: HarnessSignal['source'], out: HarnessSignal[]): void {
  for (const raw of blob.split('\n')) {
    if (out.length >= HARNESS_SCAN_CAP) return;
    const line = raw.trim();
    if (!line || !BACKEND_ERROR.test(line)) continue;
    out.push({ source, bucket: harnessBucket(line), text: capText(line) });
  }
}

/** The concise grounding error: terse message + the concrete cause line (no repeated call-log). */
function buildErrorText(
  method: string,
  message: string | undefined,
  causeLine: string | undefined,
): string {
  if (message && causeLine) return `${method}: ${message} — ${causeLine}`;
  if (message) return `${method}: ${message}`;
  if (causeLine) return `${method}: ${causeLine}`;
  return `${method}: failed`;
}

interface BeforeEvent {
  startTime?: number;
  method?: string;
  params?: { selector?: unknown };
}

/** First value of `key` across the context-options events that is a string. */
function pickString(ctxs: Record<string, unknown>[], key: string): string | undefined {
  const hit = ctxs.map((c) => c[key]).find((v) => typeof v === 'string');
  return hit as string | undefined;
}

/** Parse the merged trace JSONL text into {@link TraceInfo}. Enforces the version guard. */
export function parseTraceEvents(text: string): TraceInfo {
  // A @playwright/test trace.zip carries TWO context-options events (the runner's `test.trace` and
  // the context's `0-trace.trace`); the browser/version fields are split across them, so we collect
  // all of them and take the first defined value of each rather than trusting whichever came first.
  const ctxs: Record<string, unknown>[] = [];
  const befores = new Map<string, BeforeEvent>();
  const afters = new Map<
    string,
    { error?: { message?: unknown; name?: string }; endTime?: number }
  >();
  const logs = new Map<string, Array<{ time: number; message: string }>>();
  const coEvents: TraceCoEvent[] = [];
  const harnessRaw: HarnessSignal[] = [];

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e: { type?: string; callId?: string; [k: string]: unknown };
    try {
      e = JSON.parse(s);
    } catch {
      continue; // tolerate a truncated trailing line rather than fail the whole read
    }
    switch (e.type) {
      case 'context-options':
        ctxs.push(e as Record<string, unknown>);
        break;
      // 'before' is the v8 action-start event; 'action' is an older combined shape we accept as a
      // best-effort fallback (still version-guarded below, so it only reaches here for a known ver).
      case 'before':
      case 'action':
        if (typeof e.callId === 'string') befores.set(e.callId, e as BeforeEvent);
        break;
      case 'after':
        if (typeof e.callId === 'string')
          afters.set(e.callId, e as { error?: { message?: unknown }; endTime?: number });
        break;
      case 'log':
        if (typeof e.callId === 'string' && typeof e.message === 'string') {
          const arr = logs.get(e.callId) ?? [];
          arr.push({ time: typeof e.time === 'number' ? e.time : 0, message: e.message });
          logs.set(e.callId, arr);
        }
        break;
      // Move 2 routing co-events. `console` carries an in-page console message; the browser also
      // logs a failed request as a console error, so this channel catches those too. We keep only
      // error/warning levels (log/info/debug is pure noise on a legacy app).
      case 'console': {
        const level = (e as { messageType?: unknown }).messageType;
        const text = (e as { text?: unknown }).text;
        if ((level === 'error' || level === 'warning') && typeof text === 'string') {
          coEvents.push({
            kind: level === 'error' ? 'console-error' : 'console-warning',
            text: capText(text),
            time: typeof e.time === 'number' ? e.time : 0,
          });
        }
        break;
      }
      // An uncaught JS exception is a BrowserContext `pageError` event (NOT a `console` type).
      case 'event': {
        const ev = e as {
          method?: unknown;
          params?: { error?: { error?: { message?: unknown } } };
        };
        if (ev.method === 'pageError') {
          const message = ev.params?.error?.error?.message;
          if (typeof message === 'string') {
            coEvents.push({
              kind: 'pageerror',
              text: capText(message),
              time: typeof e.time === 'number' ? e.time : 0,
            });
          }
        }
        break;
      }
      // Move 2 harness routing: the test-runner's own stdout/stderr (and the top-level test `error`)
      // in `test.trace` — where a backend-dominated portal logs the gateway 5xx / refused connection
      // that the browser console never sees. Only BACKEND-error lines are kept (see scanHarness).
      case 'stdout':
      case 'stderr': {
        const txt = (e as { text?: unknown }).text;
        if (typeof txt === 'string') scanHarness(txt, e.type, harnessRaw);
        break;
      }
      case 'error': {
        const message = (e as { message?: unknown }).message;
        if (typeof message === 'string') scanHarness(message, 'error', harnessRaw);
        break;
      }
    }
  }

  const traceVersion = ctxs.map((c) => c.version).find((v) => typeof v === 'number') as
    number | undefined;
  if (traceVersion === undefined) {
    throw new TraceParseError(
      'not a Playwright trace (no context-options event with a numeric version)',
    );
  }
  if (!SUPPORTED_TRACE_VERSIONS.has(traceVersion)) {
    throw new UnsupportedTraceVersionError(traceVersion, [...SUPPORTED_TRACE_VERSIONS]);
  }

  const built: Array<{ startTime: number; action: TraceAction }> = [];
  for (const [callId, before] of befores) {
    const after = afters.get(callId);
    const callLog = (logs.get(callId) ?? []).sort((a, b) => a.time - b.time).map((l) => l.message);
    const errObj = after?.error;
    const error =
      errObj && errObj.message != null
        ? { message: String(errObj.message), name: errObj.name }
        : undefined;
    const method = typeof before.method === 'string' ? before.method : 'action';
    const selector = before.params?.selector != null ? String(before.params.selector) : undefined;
    const causeLine = extractCauseLine(callLog);
    const startTime = typeof before.startTime === 'number' ? before.startTime : 0;
    const endTime = typeof after?.endTime === 'number' ? after.endTime : undefined;
    built.push({
      startTime,
      action: {
        callId,
        method,
        selector,
        startTime,
        endTime,
        error,
        callLog,
        causeLine,
        errorText: buildErrorText(method, error?.message, causeLine),
        failed: !!error,
      },
    });
  }
  built.sort((a, b) => a.startTime - b.startTime);
  const actions = built.map((b) => b.action);
  const failed = actions.filter((a) => a.failed);
  coEvents.sort((a, b) => a.time - b.time);
  // A backend error is usually logged many times (per retry / per request); dedup by content and cap
  // so the report shows the DISTINCT backend faults, not N copies.
  const seen = new Set<string>();
  const harnessSignals: HarnessSignal[] = [];
  for (const h of harnessRaw) {
    const key = `${h.source}|${h.bucket}|${h.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    harnessSignals.push(h);
    if (harnessSignals.length >= 12) break;
  }
  return {
    traceVersion,
    playwrightVersion: pickString(ctxs, 'playwrightVersion'),
    browserName: pickString(ctxs, 'browserName'),
    sdkLanguage: pickString(ctxs, 'sdkLanguage'),
    actions,
    failed,
    coEvents,
    harnessSignals,
    chosenFailure: failed.length ? failed[failed.length - 1]! : null,
  };
}

/**
 * Read a Playwright `trace.zip` buffer into {@link TraceInfo}. Merges every `*.trace` member
 * (the action stream can be split across more than one), then parses + version-guards.
 */
export function readTraceZip(zipBuf: Buffer): TraceInfo {
  const traceMembers = zipEntryNames(zipBuf).filter((n) => n.endsWith('.trace'));
  if (traceMembers.length === 0) {
    throw new TraceParseError('trace.zip has no *.trace member — not a Playwright trace archive');
  }
  const text = traceMembers.map((n) => readZipEntry(zipBuf, n)!.toString('utf8')).join('\n');
  return parseTraceEvents(text);
}
