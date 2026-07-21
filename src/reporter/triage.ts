import { diagnose } from '../host/diagnose';
import { type Confidence } from '../host/confidence';
import { summarizeDiagnoses, DEFAULT_MIN_CONFIDENCE } from '../host/summarize';
import { isActionabilityError, looksDetached, syntheticDelta } from '../host/synthetic-delta';
import { checksum } from '../host/checksum';
import type { Delta, Diagnosis } from '../host/types';
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
  /**
   * A cross-test CLUSTERING key for suite-scale triage — "the same observed failure mechanism". In rich
   * mode it is the geometry/timing/message-TOLERANT delta `checksum` (a structural fingerprint that stays
   * stable across the jitter Sentry-style text signatures trip on); in passive mode it is a COARSE
   * signature over the cause + diagnosis-code multiset + flags. `fingerprintSource` makes the resolution
   * visible, not hidden. Grouped only WITHIN a cause code (never across) — see `clusterByCause`.
   */
  fingerprint: string;
  /** `delta` = high-resolution structural fingerprint; `coarse` = error-shape signature (passive mode). */
  fingerprintSource: 'delta' | 'coarse';
  /** Every diagnosis produced, for the machine-readable side-car. */
  diagnoses: Array<Pick<Diagnosis, 'code' | 'confidence' | 'scope' | 'detail'>>;
}

/** A COARSE, passive-mode clustering signature: the cause + the sorted diagnosis-code multiset + the
 *  flags. Deliberately low-resolution (no geometry — a synthetic delta from error text has none), and
 *  labeled `coarse` so consumers never mistake it for the structural delta fingerprint. */
export function coarseSignature(
  cause: Sidecar['cause'],
  diagnosisCodes: readonly string[],
  flags: { detached: boolean; lateWave: boolean; staleRect: boolean },
): string {
  const codes = [...new Set(diagnosisCodes)].sort().join(',');
  const f = `${flags.detached ? 'd' : ''}${flags.lateWave ? 'l' : ''}${flags.staleRect ? 's' : ''}`;
  return `${cause}#${codes}#${f}`;
}

const FAIL_STATUSES = new Set(['failed', 'timedOut']);

// `isActionabilityError`, `looksDetached`, and `syntheticDelta` moved to `../host/synthetic-delta`
// so the offline `diagnose-trace` (#9) reconstructs the SAME synthetic delta from the SAME error
// string this passive path does — one shared classification, no drift.

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

/** Assemble a side-car from a (possibly empty) diagnosis set + flags. Applies the confidence gate. */
function assemble(
  input: TriageInput,
  source: Sidecar['source'],
  diagnoses: Diagnosis[],
  flags: { detached: boolean; reason?: string },
  minConfidence: Confidence,
  delta: Delta | null,
): Sidecar {
  const lateWave = diagnoses.some((d) => d.code === 'late-wave-suspected');
  const staleRect = diagnoses.some((d) => d.code === 'stale-rect-suspected');
  // The confidence gate is the shared reducer (#60) — the side-car and the MCP `diagnose` tool can't
  // drift on which cause crosses the bar. `unsure` cause ⇒ confidence `unknown` (its own contract).
  const summary = summarizeDiagnoses(diagnoses, { minConfidence, detached: flags.detached });
  const crosses = summary.cause !== 'unsure';
  const cause: Sidecar['cause'] = summary.cause;
  const confidence: Confidence = summary.confidence;
  const detail = flags.detached
    ? 'the failing locator did not resolve to an actionable element (detached / not rendered) — no cause fabricated'
    : crosses
      ? summary.primary!.detail
      : (flags.reason ?? 'no cause crossed the confidence threshold');
  // The cross-test clustering key: the structural delta checksum in rich mode; a coarse error-shape
  // signature in passive mode (a synthetic delta has no real geometry to fingerprint).
  const fingerprint = delta
    ? checksum(delta)
    : coarseSignature(
        cause,
        diagnoses.map((d) => d.code),
        {
          detached: flags.detached,
          lateWave,
          staleRect,
        },
      );
  const fingerprintSource: Sidecar['fingerprintSource'] = delta ? 'delta' : 'coarse';
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
    fingerprint,
    fingerprintSource,
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
      attached,
    );
  }

  // PASSIVE mode (zero-edit). Guard against fabrication:
  //  1) a locator that never resolved → detached + unsure (never invent a cause for a gone element);
  if (looksDetached(primaryError)) {
    return assemble(input, 'error-text', [], { detached: true }, minConfidence, null);
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
      null,
    );
  }
  //  3) a real actionability failure → wrap its error in a synthetic delta and diagnose it.
  return assemble(
    input,
    'error-text',
    diagnose(syntheticDelta(primaryError)).diagnoses,
    { detached: false },
    minConfidence,
    null,
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
