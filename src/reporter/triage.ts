import { diagnose } from '../host/diagnose';
import { atLeastAsConfident, type Confidence } from '../host/confidence';
import type { Delta, DeltaNode, Diagnosis } from '../host/types';
import type { RootCauseCode } from '../host/taxonomy';

// Flake-triage side-car core (#55). PURE + browser-free: given a failed test's error/attachments it
// produces a taxonomy-labeled triage side-car, or null for a passing test. The Playwright Reporter
// (index.ts) is a thin wrapper that maps TestCase/TestResult onto this and writes the files.
//
// It CONSUMES the one diagnose() engine (so it hard-gates on the #52 accuracy harness): a delta the
// test attached is diagnosed directly (rich mode, carries late-wave / stale-rect); with no delta it
// builds a SYNTHETIC delta from the Playwright actionability error and diagnoses that (passive,
// zero-edit). It NEVER fabricates: an unresolved/detached locator degrades to `unsure` + `detached`.

/** The attachment name a test (or the opt-in fixture) uses to hand a real Delta to the reporter. */
export const DELTA_ATTACHMENT_NAME = 'deltawright-delta';

/** Emit a specific cause only at or above this confidence; below it the side-car says `unsure`. */
const DEFAULT_MIN_CONFIDENCE: Confidence = 'suspected';

export interface TriageInput {
  /** Playwright test result status; only 'failed' / 'timedOut' yield a side-car. */
  status: string;
  /** Human title (e.g. the joined title path). */
  title: string;
  /** Error messages from the failed test (first is the primary). */
  errorMessages: string[];
  /** Test attachments — a `deltawright-delta` JSON body switches on rich mode. */
  attachments: Array<{ name: string; contentType?: string; body?: Buffer | string }>;
}

export interface TriageOptions {
  /** Emit a specific cause only at/above this band; below → `unsure`. Default `suspected`. */
  minConfidence?: Confidence;
}

export interface Sidecar {
  test: string;
  status: string;
  /** Where the diagnosis came from: a real attached delta, the failure error text, or nothing. */
  source: 'delta-attachment' | 'error-text';
  /** The taxonomy code, or `unsure` when nothing crosses the confidence threshold. */
  cause: RootCauseCode | 'unsure';
  confidence: Confidence;
  detail: string;
  /** The failing locator did not resolve to an actionable element (gone / never rendered). */
  detached: boolean;
  /** A late structural wave was flagged (rich mode; needs a delta with lateWatch). */
  lateWave: boolean;
  /** A post-settle rect move was flagged (rich mode; needs a delta with rectRecheck). */
  staleRect: boolean;
  /** Every diagnosis produced, for the machine-readable side-car. */
  diagnoses: Array<Pick<Diagnosis, 'code' | 'confidence' | 'scope' | 'detail'>>;
}

const FAIL_STATUSES = new Set(['failed', 'timedOut']);

/** A locator/timeout that never resolved to an element — degrade to detached, never fabricate. */
function looksDetached(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not attached to the dom') ||
    m.includes('element is not attached') ||
    m.includes('was detached from the dom') || // auto-waiting locator retry (a re-render swap)
    m.includes('no element matching') ||
    m.includes('has been closed') // target page / context / browser closed
  );
}

/**
 * Is this a genuine Playwright ACTIONABILITY / timeout failure whose error names a real cause — as
 * opposed to an assertion diff, an app error, or a stack trace that merely CONTAINS a taxonomy word?
 * The passive path only diagnoses these; everything else stays `unsure` (never fabricate). Matches the
 * structured Playwright phrasings, not a bare keyword anywhere in the text.
 */
function isActionabilityError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /element is not (visible|enabled|stable|editable|attached)/.test(m) ||
    m.includes('intercepts pointer events') ||
    m.includes('outside of the viewport') ||
    looksDetached(m)
  );
}

/** A minimal synthetic Delta carrying the failure's Playwright error, for diagnose() (passive). */
function syntheticDelta(errorMessage: string): Delta {
  const node: DeltaNode = {
    ref: 'e1',
    kind: 'attrChanged',
    tag: 'element',
    role: null,
    name: null,
    interactive: true,
    parentRef: null,
    geometry: null,
    actionability: {
      verdict: 'NOT-actionable',
      reason: null,
      geometryVerdict: 'n/a',
      // The failed action's own Playwright error IS an authoritative actionability signal, the same
      // source diagnose() treats as authoritative from a trial probe — pass it through verbatim.
      playwright: { actionable: false, error: errorMessage },
      agreed: true,
    },
  };
  return {
    action: 'failed action',
    nodes: [node],
    stats: {
      rawRecords: 0,
      settleMs: 0,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
    },
  };
}

/** Parse a `deltawright-delta` attachment body into a Delta, or null if absent/unparseable. */
function deltaFromAttachments(atts: TriageInput['attachments']): Delta | null {
  const hit = atts.find((a) => a.name === DELTA_ATTACHMENT_NAME && a.body != null);
  if (!hit || hit.body == null) return null;
  try {
    const text = typeof hit.body === 'string' ? hit.body : hit.body.toString('utf8');
    const parsed = JSON.parse(text) as Delta;
    // Validate node shape too (not just the array) so a structurally-invalid delta falls back to
    // passive triage rather than throwing out of diagnose() (which reads node.actionability.verdict).
    const validNodes =
      Array.isArray(parsed?.nodes) &&
      parsed.nodes.every(
        (n) =>
          n &&
          typeof (n as { actionability?: { verdict?: unknown } }).actionability?.verdict ===
            'string',
      );
    if (parsed && validNodes && parsed.stats) return parsed;
  } catch {
    // malformed attachment — fall back to passive error-text triage.
  }
  return null;
}

/** Pick the strongest specific (node/delta) diagnosis as the primary cause. */
function primaryDiagnosis(diagnoses: Diagnosis[]): Diagnosis | null {
  const specific = diagnoses.filter((d) => d.code !== 'unknown');
  if (specific.length === 0) return null;
  // Prefer the highest confidence; on a TIE keep the earlier one — blocking node causes are pushed
  // before the delta-level notes, so a confirmed node cause wins over a suspected late-wave/stale-rect
  // flag, and a suspected node cause wins a tie against a suspected delta note. `d` is taken only when
  // it is STRICTLY stronger than the incumbent.
  return specific.reduce((best, d) =>
    atLeastAsConfident(best.confidence, d.confidence) ? best : d,
  );
}

/** Assemble a side-car from a (possibly empty) diagnosis set + flags. Applies the confidence gate. */
function assemble(
  input: TriageInput,
  source: Sidecar['source'],
  diagnoses: Diagnosis[],
  flags: { detached: boolean; reason?: string },
  minConfidence: Confidence,
): Sidecar {
  const lateWave = diagnoses.some((d) => d.code === 'late-wave-suspected');
  const staleRect = diagnoses.some((d) => d.code === 'stale-rect-suspected');
  const primary = flags.detached ? null : primaryDiagnosis(diagnoses);
  const crosses = primary != null && atLeastAsConfident(primary.confidence, minConfidence);
  const cause: Sidecar['cause'] = crosses ? primary!.code : 'unsure';
  const confidence: Confidence = crosses ? primary!.confidence : 'unknown';
  const detail = flags.detached
    ? 'the failing locator did not resolve to an actionable element (detached / not rendered) — no cause fabricated'
    : crosses
      ? primary!.detail
      : (flags.reason ?? 'no cause crossed the confidence threshold');
  return {
    test: input.title,
    status: input.status,
    source,
    cause,
    confidence,
    detail,
    detached: flags.detached,
    lateWave,
    staleRect,
    diagnoses: diagnoses.map((d) => ({
      code: d.code,
      confidence: d.confidence,
      scope: d.scope,
      detail: d.detail,
    })),
  };
}

/**
 * Triage one test outcome into a side-car, or null when there is nothing to attach (a passing /
 * skipped test). Pure — no I/O, no Playwright, no browser. NEVER fabricates: only a real delta or a
 * genuine actionability error is diagnosed; a detached locator or an unrelated failure stays `unsure`.
 */
export function triageFailure(input: TriageInput, opts: TriageOptions = {}): Sidecar | null {
  if (!FAIL_STATUSES.has(input.status)) return null;

  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const primaryError = input.errorMessages[0] ?? '';

  // RICH mode: a real attached delta is diagnosed directly (carries late-wave / stale-rect).
  const attached = deltaFromAttachments(input.attachments);
  if (attached) {
    return assemble(
      input,
      'delta-attachment',
      diagnose(attached).diagnoses,
      { detached: false },
      minConfidence,
    );
  }

  // PASSIVE mode (zero-edit). Guard against fabrication:
  //  1) a locator that never resolved → detached + unsure (never invent a cause for a gone element);
  if (looksDetached(primaryError)) {
    return assemble(input, 'error-text', [], { detached: true }, minConfidence);
  }
  //  2) only a GENUINE Playwright actionability error is diagnosable from text — otherwise a failure
  //     whose message merely contains a taxonomy word (an assertion diff, an app error, a stack
  //     trace) would be mis-diagnosed. Everything else stays `unsure`.
  if (!isActionabilityError(primaryError)) {
    return assemble(
      input,
      'error-text',
      [],
      {
        detached: false,
        reason:
          'the failure was not a recognized Playwright actionability error — no cause inferred',
      },
      minConfidence,
    );
  }
  //  3) a real actionability failure → wrap its error in a synthetic delta and diagnose it.
  return assemble(
    input,
    'error-text',
    diagnose(syntheticDelta(primaryError)).diagnoses,
    { detached: false },
    minConfidence,
  );
}

/** Render a side-car as the human-readable `triage.txt`. */
export function renderTriageText(s: Sidecar): string {
  const lines = [
    `deltawright triage — ${s.test}`,
    `status: ${s.status}   source: ${s.source}`,
    `cause: ${s.cause}${s.cause === 'unsure' ? '' : ` (${s.confidence})`}`,
    `detail: ${s.detail}`,
  ];
  const flags: string[] = [];
  if (s.detached) flags.push('detached/not-rendered');
  if (s.lateWave) flags.push('late-wave-suspected');
  if (s.staleRect) flags.push('stale-rect-suspected');
  if (flags.length) lines.push(`flags: ${flags.join(', ')}`);
  if (s.diagnoses.length) {
    lines.push('diagnoses:');
    for (const d of s.diagnoses) {
      lines.push(`  [${d.scope}] ${d.code} (${d.confidence}) — ${d.detail}`);
    }
  }
  lines.push(
    '',
    'Note: a triage cause is a HYPOTHESIS from Playwright’s own failure signal, not proof.',
  );
  return lines.join('\n');
}
