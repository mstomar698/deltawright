// The shared Confidence primitive for v0.6 diagnosis (#47). "Unsure beats confidently
// wrong" is the product's named anti-goal defense, so `unknown`/unsure is a FIRST-CLASS
// outcome — never a fallback we're ashamed of. A diagnosis is a HYPOTHESIS that carries one
// of these confidences; a high claim ('confirmed') is allowed ONLY when an authoritative
// engine (Playwright) named the cause. A diagnosis must never contradict Playwright's
// actionability verdict (DW-02/DW-03). Owned here so no diagnosis surface grows its own
// confidence dialect. See docs/decisions/design-watches.md (DW-03).

export type Confidence = 'confirmed' | 'suspected' | 'unknown';

/**
 * Where the evidence for a diagnosis comes from. Only an authoritative engine
 * (`playwright`, or a `geometry+playwright` agreement) can justify `confirmed`; a
 * geometry-only or timing-only read is inherently a hypothesis (`suspected`); if nothing
 * fired (`none`) the outcome is `unknown`.
 */
export type EvidenceSource =
  | 'playwright' // Playwright's own error string / verdict named the cause
  | 'geometry+playwright' // the geometry read and Playwright's verdict agreed
  | 'geometry' // the geometry read alone
  | 'timing' // a settle / attribution timing heuristic alone
  | 'none'; // no grounding signal fired

const AUTHORITATIVE = new Set<EvidenceSource>(['playwright', 'geometry+playwright']);
const HYPOTHESIS = new Set<EvidenceSource>(['geometry', 'timing']);

export interface Evidence {
  source: EvidenceSource;
  /**
   * The grounding signals point in different directions (e.g. geometry says blocked but
   * Playwright says actionable). Conflicting evidence downgrades confidence one notch —
   * it can never upgrade — so a disagreement is surfaced as a hypothesis, not asserted.
   */
  conflicting?: boolean;
}

/** Strength ordering, high → low. Exported so callers can compare/threshold bands. */
export const CONFIDENCE_ORDER: readonly Confidence[] = ['confirmed', 'suspected', 'unknown'];

/** One notch weaker (used when evidence conflicts). `unknown` is the floor. */
const DOWNGRADE: Record<Confidence, Confidence> = {
  confirmed: 'suspected',
  suspected: 'unknown',
  unknown: 'unknown',
};

/**
 * Assign a confidence to a diagnosis from its evidence (DW-03):
 *  - an authoritative engine named the cause  → `confirmed`
 *  - geometry-only or timing-only             → `suspected` (NEVER `confirmed`)
 *  - no grounding signal                      → `unknown` (first-class unsure)
 *  - conflicting signals                      → one notch down from the above
 */
export function assessConfidence(evidence: Evidence): Confidence {
  const base: Confidence = AUTHORITATIVE.has(evidence.source)
    ? 'confirmed'
    : HYPOTHESIS.has(evidence.source)
      ? 'suspected'
      : 'unknown';
  return evidence.conflicting ? DOWNGRADE[base] : base;
}

/** True when `a` is at least as strong as `b` (confirmed ≥ suspected ≥ unknown). */
export function atLeastAsConfident(a: Confidence, b: Confidence): boolean {
  return CONFIDENCE_ORDER.indexOf(a) <= CONFIDENCE_ORDER.indexOf(b);
}

/**
 * Cap a confidence at `max`, never upgrading it (`confirmed`→`suspected` when max is `suspected`;
 * a weaker input is left untouched). The honest downgrade for a RECONSTRUCTED-only surface — e.g.
 * offline `diagnose-trace` (#9), where the cause is rebuilt from a trace's error string, not
 * live-probed, so it must never claim `confirmed` even though the shared engine would (DW-03).
 */
export function capConfidence(c: Confidence, max: Confidence): Confidence {
  return atLeastAsConfident(c, max) ? max : c;
}
