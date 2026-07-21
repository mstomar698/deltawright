// #9 — the v0.8 flagship. Read a Playwright `trace.zip` OFFLINE (no re-run, no browser) and
// explain why the failing action failed, using the SAME shared `diagnose()` engine the live
// primitive and the reporter use. "The agent reads your failing run."
//
// Honesty is the whole point (DW-02/03):
//  • Reconstructed, not live-probed → every cause is CLAMPED to `suspected`. The engine yields
//    `confirmed` for an authoritative PW error (the same path the live reporter trusts), but here
//    the delta was rebuilt from a trace, so we must never claim `confirmed`. The clamp is
//    load-bearing and separately tested.
//  • Never fabricate → we reuse the reporter's exact classification (`isActionabilityError` /
//    `looksDetached`). A non-actionability failure (assertion, app error) or a gone locator yields
//    an honest "no attributable cause", not a borrowed one.
//  • Only the error string survives offline. Geometry, the Playwright verdict beyond the error,
//    and every observer stat are LIVE artifacts absent from a trace, so the geometry-grounded
//    codes and stats codes are out of reach — by design, not omission.

import { readFile } from 'node:fs/promises';
import { diagnose } from '../host/diagnose';
import { capConfidence, type Confidence } from '../host/confidence';
import { summarizeDiagnoses } from '../host/summarize';
import { isActionabilityError, looksDetached, syntheticDelta } from '../host/synthetic-delta';
import { render } from '../host/serialize';
import type { DiagnosedDelta, Diagnosis } from '../host/types';
import type { RootCauseCode } from '../host/taxonomy';
import { readTraceZip, type TraceInfo } from './read-trace';
import { deriveRouting, type RoutingReport } from './routing';
import { deriveInputIntegrity, type InputIntegrityFinding } from './input-integrity';

export interface TraceDiagnosis {
  /** The trace file path (for the report header), when read from disk. */
  file?: string;
  traceVersion: number;
  playwrightVersion?: string;
  browserName?: string;
  /** The failed action being explained, or null when the trace has no failed action. */
  action: { method: string; selector?: string } | null;
  actionCount: number;
  failedCount: number;
  /** The gated single cause (or `unsure`), after the suspected-clamp. */
  cause: RootCauseCode | 'unsure';
  confidence: Confidence;
  /** True when the failure error explicitly named a detached / closed / never-matched target (a
   *  gone locator). NOT every unresolved locator: a bare `waiting for locator … Timeout` that names
   *  no cause stays `unsure` with this false — we only flag what Playwright explicitly reported. */
  detached: boolean;
  /** The clamped, diagnosed synthetic delta (input to `render`). */
  diagnosed: DiagnosedDelta;
  /** Move 2 routing: co-occurring in-page errors + a route-elsewhere hint (co-occurrence, not cause). */
  routing: RoutingReport;
  /**
   * v0.9 Move 1 OFFLINE input-integrity (#81): reconstructed `input-not-committed` findings — a value
   * action typed X but its after-snapshot committed a shorter, characters-were-lost value. Always
   * `suspected`; additive (empty on a clean/non-value trace, so its report is byte-unchanged); a
   * COMPLEMENT to the live arm (which catches a deferred drop this snapshot may predate).
   */
  inputIntegrity: InputIntegrityFinding[];
  /** Why the result is `unsure`, when it is (else empty). */
  note: string;
}

/** A short human label for the failed action, used as the delta's `action` (render header). */
function actionLabel(a: { method: string; selector?: string }): string {
  return a.selector ? `${a.method} ${a.selector}` : a.method;
}

/**
 * A value-free, honest one-line phrasing of an offline input-integrity finding (v0.9 Move 1). Mirrors
 * the live arm's wording (`diagnose()`): length + shape only (never the typed value — privacy), and
 * "the after-snapshot shows …", NEVER "Playwright's fill failed" (Playwright succeeded; the widget
 * mutated the value after — DW-02/03).
 */
function inputIntegrityLine(f: InputIntegrityFinding): string {
  const where = f.selector ? `${f.method} ${f.selector}` : f.method;
  const detail =
    f.shape === 'never-committed'
      ? `typed ${f.intendedLen} chars, the after-snapshot shows the field empty — suspected input-drop (an async widget may have cleared it after the action)`
      : f.shape === 'truncated'
        ? `typed ${f.intendedLen} chars, the after-snapshot shows ${f.committedLen} (a prefix) — suspected truncation after the action`
        : `typed ${f.intendedLen} chars, the after-snapshot shows ${f.committedLen} (characters were dropped) — suspected dropped-keystrokes`;
  return `[input-not-committed] ${where} — ${detail}`;
}

/** Diagnose an already-read {@link TraceInfo}. Split out so tests can drive it without a zip. */
export function diagnoseTraceInfo(info: TraceInfo, file?: string): TraceDiagnosis {
  const base = {
    file,
    traceVersion: info.traceVersion,
    playwrightVersion: info.playwrightVersion,
    browserName: info.browserName,
    actionCount: info.actions.length,
    failedCount: info.failed.length,
  };

  // v0.9 Move 1 offline arm (#81): reconstruct input-integrity findings from the value actions +
  // their after-snapshots. Independent of whether an action FAILED — a drifted fill usually reports
  // success — so it is computed for every trace and surfaced additively.
  const inputIntegrity = deriveInputIntegrity(info);

  const chosen = info.chosenFailure;
  if (!chosen) {
    // Nothing failed in the trace — an honest, non-fabricated no-cause result.
    const empty = { ...syntheticDelta('(no failed action)'), nodes: [], diagnoses: [] };
    return {
      ...base,
      action: null,
      cause: 'unsure',
      confidence: 'unknown',
      detached: false,
      diagnosed: empty as DiagnosedDelta,
      routing: deriveRouting(info, { domCauseNamed: false }),
      inputIntegrity,
      note: 'no failed action found in the trace — nothing to diagnose',
    };
  }

  const err = chosen.errorText;
  const detached = looksDetached(err);

  // Mirror the reporter's passive classification EXACTLY (shared guards): only a genuine
  // actionability error is diagnosed; a detached locator or an unrelated failure stays unsure.
  let rawDiagnoses: Diagnosis[] = [];
  let note = '';
  if (detached) {
    note =
      'the failing locator did not resolve to an element (detached / never rendered) — no cause fabricated';
  } else if (!isActionabilityError(err)) {
    note = 'the failure was not a recognized Playwright actionability error — no cause inferred';
  } else {
    rawDiagnoses = diagnose(syntheticDelta(err)).diagnoses;
  }

  // The honesty clamp — reconstructed, not live-probed → nothing may claim `confirmed`.
  const diagnoses: Diagnosis[] = rawDiagnoses.map((d) => ({
    ...d,
    confidence: capConfidence(d.confidence, 'suspected'),
  }));

  const delta = { ...syntheticDelta(err), action: actionLabel(chosen) };
  const diagnosed: DiagnosedDelta = { ...delta, diagnoses };

  const summary = summarizeDiagnoses(diagnoses, { detached });
  // Move 2: when Deltawright named a cause, the failure is its own class and co-events are context;
  // when it stayed unsure, a co-occurring uncaught JS error becomes a route-elsewhere hint.
  const routing = deriveRouting(info, { domCauseNamed: summary.cause !== 'unsure' });
  return {
    ...base,
    action: { method: chosen.method, selector: chosen.selector },
    cause: summary.cause,
    confidence: summary.confidence,
    detached,
    diagnosed,
    routing,
    inputIntegrity,
    note: summary.cause === 'unsure' && !note ? 'no cause crossed the confidence threshold' : note,
  };
}

/** Diagnose a `trace.zip` buffer. Throws for a malformed / unsupported trace (see read-trace). */
export function diagnoseTraceBuffer(zip: Buffer, file?: string): TraceDiagnosis {
  return diagnoseTraceInfo(readTraceZip(zip), file);
}

/** Diagnose a `trace.zip` file on disk. */
export async function diagnoseTraceFile(path: string): Promise<TraceDiagnosis> {
  const buf = await readFile(path);
  return diagnoseTraceBuffer(buf, path);
}

const RULE = '─'.repeat(72);

/** Render a {@link TraceDiagnosis} as the human-readable CLI report. */
export function renderTraceReport(d: TraceDiagnosis): string {
  const lines: string[] = [];
  lines.push(`deltawright diagnose-trace${d.file ? ` — ${d.file}` : ''}`);
  const meta = [`trace v${d.traceVersion}`];
  if (d.playwrightVersion) meta.push(`playwright ${d.playwrightVersion}`);
  if (d.browserName) meta.push(d.browserName);
  meta.push('OFFLINE reconstruction (no re-run, no browser)');
  lines.push(meta.join(' · '));

  if (d.action) {
    const sel = d.action.selector ? ` ${d.action.selector}` : '';
    lines.push(
      `failed action: ${d.action.method}${sel}` +
        (d.failedCount > 1 ? `   [${d.failedCount} failed of ${d.actionCount} actions]` : ''),
    );
  } else {
    lines.push(`${d.actionCount} action(s), 0 failed`);
  }

  lines.push(RULE);
  // Render the reconstructed delta + diagnostics ONLY when a cause was actually attributed. With no
  // diagnosis the synthetic node's placeholder `NOT-actionable` verdict is not something Playwright
  // issued — printing it would fabricate a verdict, exactly what this tool must never do. So a
  // non-attributed failure shows the honest one-liner instead.
  if (d.diagnosed.diagnoses.length > 0) {
    lines.push(render(d.diagnosed, { diagnostics: true }).text);
  } else if (d.action) {
    lines.push('(no root cause reconstructed from the trace — see below)');
  } else {
    lines.push('(no failed action in this trace)');
  }
  lines.push(RULE);

  if (d.cause === 'unsure') {
    lines.push(`cause: unsure — ${d.note}`);
  } else {
    lines.push(`cause: ${d.cause} (${d.confidence})`);
  }

  // Move 2 routing — additive: only rendered when in-page and/or harness errors were found, so a
  // clean trace's report is byte-unchanged. Framed as co-occurrence, never causation (DW-03).
  const r = d.routing;
  if (r.signals.length > 0 || r.harnessSignals.length > 0 || r.networkSignals.length > 0) {
    if (r.signals.length > 0) {
      lines.push(
        '',
        'Co-occurring in-page signals in the action window (co-occurrence, NOT proof of cause):',
      );
      for (const s of r.signals) lines.push(`  · [${s.kind}] ${s.text}`);
      const hidden = r.windowCount - r.signals.length;
      if (hidden > 0) lines.push(`  … and ${hidden} more (capped)`);
    }
    if (r.networkSignals.length > 0) {
      lines.push(
        '',
        "HTTP error responses (status ≥ 400) in the failing action's own window (co-occurrence, NOT proof of cause):",
      );
      for (const s of r.networkSignals) lines.push(`  · [${s.status}] ${s.method} ${s.urlPath}`);
      const hidden = r.networkErrorCount - r.networkSignals.length;
      if (hidden > 0) lines.push(`  … and ${hidden} more (capped)`);
    }
    if (r.harnessSignals.length > 0) {
      lines.push(
        '',
        'Backend/infra errors logged by the test-runner during this run (test-scoped, NOT proof of cause):',
      );
      for (const h of r.harnessSignals) lines.push(`  · [${h.source}:${h.bucket}] ${h.text}`);
    }
    if (r.recommendation) lines.push('', `routing: ${r.recommendation}`);
  }

  // v0.9 Move 1 offline input-integrity — additive: rendered only when a genuine committed-value drift
  // was reconstructed, so a clean/non-value trace's report is byte-unchanged. SUSPECTED by design.
  if (d.inputIntegrity.length > 0) {
    lines.push(
      '',
      'Suspected input-integrity (offline reconstruction from the after-snapshot — a value drift, NOT a Playwright failure):',
    );
    for (const f of d.inputIntegrity) lines.push(`  · ${inputIntegrityLine(f)} (suspected)`);
    lines.push(
      '  Limit: the after-snapshot is captured right after the action, so a DEFERRED async drop it',
      '  predates is invisible here — the live input-integrity arm (post-settle read) catches that.',
    );
  }

  lines.push(
    '',
    "Note: this is an OFFLINE reconstruction from the trace's error + call-log. Every cause is a",
    'SUSPECTED hypothesis, never `confirmed` — geometry, the live verdict, and observer stats are',
    'not present in a trace. Deltawright neither re-ran nor changed anything (DW-02/03).',
  );
  return lines.join('\n');
}
