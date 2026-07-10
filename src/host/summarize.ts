import { atLeastAsConfident, type Confidence } from './confidence';
import { ROOT_CAUSE_TAXONOMY, type RootCauseCategory, type RootCauseCode } from './taxonomy';
import type { Diagnosis } from './types';

// The ONE reduction from a diagnose() diagnosis set → a single gated cause + taxonomy category +
// unsure flag (#60). Both the #55 triage side-car and the #60 MCP `diagnose` tool consume this, so
// they can't grow two dialects of "which cause won and is it confident enough to name". Pure.
//
// DW-03: `unsure` beats confidently-wrong. A specific cause is emitted ONLY at/above the confidence
// gate; below it, and for the taxonomy's own `unknown` bucket, the result is `unsure` with a null
// category — never a real category surfaced under a hypothesis.

/** Emit a specific cause only at or above this confidence; below it the outcome is `unsure`. */
export const DEFAULT_MIN_CONFIDENCE: Confidence = 'suspected';

export interface CauseSummary {
  /** The taxonomy code that won the gate, or `unsure` when nothing crossed it. */
  cause: RootCauseCode | 'unsure';
  confidence: Confidence;
  /** The taxonomy category of `cause`, or null when unsure / the `unknown` bucket (never surfaced). */
  category: RootCauseCategory | null;
  /** True when no specific cause crossed the gate (or it resolved to the `unknown` bucket). */
  unsure: boolean;
  /** A geometry↔Playwright disagreement was present among the diagnoses (DW-02 kept it a hypothesis). */
  geomDisagreement: boolean;
  /** The strongest specific diagnosis considered (null when none / detached), gate aside. */
  primary: Diagnosis | null;
}

/**
 * Pick the strongest specific (node/delta) diagnosis as the primary cause. `unknown` is never
 * specific — it is the first-class unsure outcome, so it can never win.
 */
export function primaryDiagnosis(diagnoses: Diagnosis[]): Diagnosis | null {
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

/**
 * Reduce a diagnosis set to a single gated cause + category + unsure flag. Pure and shared, so every
 * diagnosis surface reads the same "did any cause cross the confidence gate" decision.
 *
 * @param opts.detached when true, forces `unsure` — a gone/never-rendered locator has no cause to
 *        name, so it must degrade rather than borrow one from unrelated diagnoses.
 */
export function summarizeDiagnoses(
  diagnoses: Diagnosis[],
  opts: { minConfidence?: Confidence; detached?: boolean } = {},
): CauseSummary {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const geomDisagreement = diagnoses.some((d) => d.code === 'geom-disagreement');
  const primary = opts.detached ? null : primaryDiagnosis(diagnoses);
  const crosses = primary != null && atLeastAsConfident(primary.confidence, minConfidence);
  const cause: RootCauseCode | 'unsure' = crosses ? primary!.code : 'unsure';
  const confidence: Confidence = crosses ? primary!.confidence : 'unknown';
  // Never surface the `unknown` category as a real category (mirrors the aggregator, #59): the
  // taxonomy's `unknown` IS a category but it means "we don't know" — fold it into unsure instead.
  const rawCategory = crosses ? (ROOT_CAUSE_TAXONOMY[primary!.code]?.category ?? null) : null;
  const category: RootCauseCategory | null = rawCategory === 'unknown' ? null : rawCategory;
  return {
    cause,
    confidence,
    category,
    unsure: !crosses || category === null,
    geomDisagreement,
    primary,
  };
}
