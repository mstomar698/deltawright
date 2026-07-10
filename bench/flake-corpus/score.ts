// Pure scoring for the accuracy harness (#52). Separated from the browser-driving CLI
// (`bench/run-accuracy.ts`) so the scoring rules are deterministic and unit-testable without
// Playwright. Ground truth is the corpus construction manifest (`code` + `confidence`) plus the
// reality-anchor `verdict`; NEVER a stored Deltawright output. All numbers are CORPUS-RELATIVE.
//
// Scoring is per-CASE against its labeled cause `c.code` (not per-emitted-diagnosis): a case is a
// `hit` when the engine emits `c.code` somewhere in the delta's diagnoses. This deliberately does
// NOT penalise an incidental extra diagnosis on an otherwise-correct case — a known, honesty-
// stamped simplification for the seed corpus, tightened with real-app data (#25/#41).

import type { Confidence, Diagnosis, RootCauseCode, Verdict } from '../../src/index';
import type { CorpusCase } from './cases';

/** The delta shape the scorer reads — just diagnoses + the node verdicts (for the DW-02 oracle). */
export interface ScoredInput {
  diagnoses: Diagnosis[];
  nodes: Array<{ interactive: boolean; actionability: { verdict: Verdict } }>;
}

export type Outcome =
  | 'hit' // emitted the labeled specific cause
  | 'silent-miss' // a real cause existed but the engine emitted no specific code (stayed silent)
  | 'mislabel' // emitted a DIFFERENT specific code than the label
  | 'correct-unsure' // label is `unknown` and the engine correctly emitted no specific cause
  | 'false-positive'; // label is `unknown` but the engine named a specific cause anyway

export interface CaseScore {
  id: string;
  confuser: boolean;
  expectedCode: RootCauseCode;
  expectedConfidence: Confidence;
  outcome: Outcome;
  /** The code the outcome scored against (the hit, or the wrong specific code). */
  emittedCode?: RootCauseCode;
  emittedConfidence?: Confidence;
  /** Only meaningful on `hit`: did the emitted confidence band match the label's? */
  confidenceMatch: boolean;
  /** DW-02 reality oracle (when the case carries a `verdict`): target node's verdict vs reality. */
  verdictExpected?: Verdict;
  verdictActual?: Verdict;
  verdictMatch?: boolean;
}

/**
 * Score one case against the engine's diagnosed delta. The target node for the verdict oracle is
 * chosen INDEPENDENTLY of the verdict (first interactive node, else first node) so the DW-02 check
 * is not circular.
 */
export function scoreCase(c: CorpusCase, out: ScoredInput): CaseScore {
  const specific = out.diagnoses.filter((d) => d.code !== 'unknown');
  const base = {
    id: c.id,
    confuser: c.confuser === true,
    expectedCode: c.code,
    expectedConfidence: c.confidence,
    confidenceMatch: false,
  };

  // Verdict oracle (DW-02): compare the target node's verdict to the asserted reality.
  let verdict: Pick<CaseScore, 'verdictExpected' | 'verdictActual' | 'verdictMatch'> = {};
  if (c.verdict !== undefined) {
    const target = out.nodes.find((n) => n.interactive) ?? out.nodes[0];
    const actual = target?.actionability.verdict;
    verdict = {
      verdictExpected: c.verdict,
      verdictActual: actual,
      verdictMatch: actual === c.verdict,
    };
  }

  if (c.code === 'unknown') {
    // The correct behaviour is to STAY unsure: emit no specific cause (and never the near-miss).
    const fooled = specific[0];
    if (fooled) {
      return {
        ...base,
        ...verdict,
        outcome: 'false-positive',
        emittedCode: fooled.code,
        emittedConfidence: fooled.confidence,
      };
    }
    return { ...base, ...verdict, outcome: 'correct-unsure' };
  }

  // A specific cause is expected.
  const hit = out.diagnoses.find((d) => d.code === c.code);
  if (hit) {
    return {
      ...base,
      ...verdict,
      outcome: 'hit',
      emittedCode: hit.code,
      emittedConfidence: hit.confidence,
      confidenceMatch: hit.confidence === c.confidence,
    };
  }
  if (specific.length === 0) {
    // The engine reported nothing specific while a real cause existed — the headline failure mode.
    return { ...base, ...verdict, outcome: 'silent-miss' };
  }
  return {
    ...base,
    ...verdict,
    outcome: 'mislabel',
    emittedCode: specific[0]!.code,
    emittedConfidence: specific[0]!.confidence,
  };
}

export interface Metrics {
  total: number;
  specificCases: number;
  unsureCases: number;
  hits: number;
  silentMisses: number;
  mislabels: number;
  correctUnsure: number;
  falsePositives: number;
  /** hits / specificCases */
  recall: number;
  /** silentMisses / specificCases — the headline honesty metric */
  silentMissRate: number;
  /** (hits with a matching confidence band) / hits */
  confidenceAccuracy: number;
  confirmedCorrect: number;
  confirmedWrong: number;
  /** confirmedCorrect / (confirmedCorrect + confirmedWrong) — the ≥0.95 target band */
  confirmedPrecision: number;
  verdictOracleCases: number;
  verdictMatches: number;
  /** verdictMatches / verdictOracleCases — DW-02, the ONLY reporting-first hard floor (must be 1) */
  verdictAccuracy: number;
}

const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den);

/** Aggregate case scores into the harness's headline metrics. */
export function aggregate(scores: CaseScore[]): Metrics {
  const specific = scores.filter((s) => s.expectedCode !== 'unknown');
  const unsure = scores.filter((s) => s.expectedCode === 'unknown');
  const hits = specific.filter((s) => s.outcome === 'hit');
  const silentMisses = specific.filter((s) => s.outcome === 'silent-miss');
  const mislabels = specific.filter((s) => s.outcome === 'mislabel');
  const correctUnsure = unsure.filter((s) => s.outcome === 'correct-unsure');
  const falsePositives = unsure.filter((s) => s.outcome === 'false-positive');

  // Confirmed-band precision: of every case where the engine emitted a CONFIRMED specific code,
  // how many were the correct label. A confident hit is correct; a confident mislabel or a
  // confident false-positive (fell for a near-miss) is wrong.
  const confirmedCorrect = hits.filter((s) => s.emittedConfidence === 'confirmed').length;
  const confirmedWrong = scores.filter(
    (s) =>
      (s.outcome === 'mislabel' || s.outcome === 'false-positive') &&
      s.emittedConfidence === 'confirmed',
  ).length;

  const verdictOracle = scores.filter((s) => s.verdictMatch !== undefined);
  const verdictMatches = verdictOracle.filter((s) => s.verdictMatch).length;

  return {
    total: scores.length,
    specificCases: specific.length,
    unsureCases: unsure.length,
    hits: hits.length,
    silentMisses: silentMisses.length,
    mislabels: mislabels.length,
    correctUnsure: correctUnsure.length,
    falsePositives: falsePositives.length,
    recall: ratio(hits.length, specific.length),
    silentMissRate: ratio(silentMisses.length, specific.length),
    confidenceAccuracy: ratio(hits.filter((s) => s.confidenceMatch).length, hits.length),
    confirmedCorrect,
    confirmedWrong,
    confirmedPrecision: ratio(confirmedCorrect, confirmedCorrect + confirmedWrong),
    verdictOracleCases: verdictOracle.length,
    verdictMatches,
    verdictAccuracy: ratio(verdictMatches, verdictOracle.length),
  };
}
