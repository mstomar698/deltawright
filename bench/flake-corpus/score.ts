// Pure scoring for the accuracy harness (#52). Separated from the browser-driving CLI
// (`bench/run-accuracy.ts`) so the scoring rules are deterministic and unit-testable without
// Playwright. Ground truth is the corpus construction manifest (`code` + `confidence`) plus the
// reality-anchor `verdict`; NEVER a stored Deltawright output. All numbers are CORPUS-RELATIVE.
//
// Scoring is per-CASE against its labeled cause `c.code`: a case is a `hit` when the engine emits
// `c.code` somewhere in the delta's diagnoses. Confidence-band PRECISION, by contrast, is scored
// per-emitted-CONFIRMED-diagnosis (F2 review fix), so a confident code that does NOT match the
// label — even one co-emitted alongside a correct one on a `hit` case — counts against precision
// and cannot hide. Two known seed-corpus scoping limitations remain (F3/F4), harmless on today's
// single-target-per-fixture corpus and tightened with the real-app corpus (#25/#41):
//   F3 — `hit` matches `c.code` ANYWHERE in the delta, not necessarily on the intended target node.
//   F4 — the verdict oracle's target is chosen positionally (first interactive node), not by ref.

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
  /** live (real Playwright run) vs delta (hand-authored) — splits the verdict oracle (F1). */
  kind: 'live' | 'delta';
  confuser: boolean;
  expectedCode: RootCauseCode;
  expectedConfidence: Confidence;
  outcome: Outcome;
  /** The code the outcome scored against (the hit, or the wrong specific code). */
  emittedCode?: RootCauseCode;
  emittedConfidence?: Confidence;
  /** Only meaningful on `hit`: did the emitted confidence band match the label's? */
  confidenceMatch: boolean;
  /** Specific codes emitted OTHER than the scored one — surfaced, never hidden (F2). */
  extraSpecificCodes: Array<{ code: RootCauseCode; confidence: Confidence }>;
  /** Per-case confirmed-band tallies (F2): confirmed diagnoses matching / not matching the label. */
  confirmedCorrect: number;
  confirmedWrong: number;
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

  // Confirmed-band tally is per-emitted-diagnosis (F2): every confirmed specific code either
  // matches the labeled cause (correct) or does not (a confident spurious/near-miss label = wrong),
  // regardless of the case's overall outcome — so a confident-wrong co-emission on a `hit` case is
  // still counted.
  let confirmedCorrect = 0;
  let confirmedWrong = 0;
  for (const d of specific) {
    if (d.confidence !== 'confirmed') continue;
    if (d.code === c.code) confirmedCorrect++;
    else confirmedWrong++;
  }

  const base = {
    id: c.id,
    kind: c.kind,
    confuser: c.confuser === true,
    expectedCode: c.code,
    expectedConfidence: c.confidence,
    confidenceMatch: false,
    confirmedCorrect,
    confirmedWrong,
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

  const extrasExcept = (shown?: RootCauseCode) =>
    specific
      .filter((d) => d.code !== shown)
      .map((d) => ({ code: d.code, confidence: d.confidence }));

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
        extraSpecificCodes: extrasExcept(fooled.code),
      };
    }
    return { ...base, ...verdict, outcome: 'correct-unsure', extraSpecificCodes: [] };
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
      extraSpecificCodes: extrasExcept(c.code),
    };
  }
  if (specific.length === 0) {
    // The engine reported nothing specific while a real cause existed — the headline failure mode.
    return { ...base, ...verdict, outcome: 'silent-miss', extraSpecificCodes: [] };
  }
  return {
    ...base,
    ...verdict,
    outcome: 'mislabel',
    emittedCode: specific[0]!.code,
    emittedConfidence: specific[0]!.confidence,
    extraSpecificCodes: extrasExcept(specific[0]!.code),
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
  // Verdict-vs-reality is split by case kind (F1): only LIVE cases exercise Playwright's real
  // verdict, so they are the true DW-02 anchor and the ONLY reporting-first hard floor. Delta
  // cases re-check a hand-authored constant `diagnose()` never touches — self-consistency, not
  // reality — so they are reported separately and NEVER gate.
  liveVerdictOracleCases: number;
  liveVerdictMatches: number;
  /** verdictMatches / oracleCases over LIVE cases — DW-02, must be 1 (and oracleCases must be >0) */
  liveVerdictAccuracy: number;
  deltaVerdictOracleCases: number;
  deltaVerdictMatches: number;
  /** over DELTA cases — authored self-consistency only; informational, never gated */
  deltaVerdictAccuracy: number;
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

  // Confirmed-band precision: summed per-emitted-confirmed-diagnosis (F2), so a confident code
  // that isn't the labeled cause — even co-emitted on an otherwise-correct case — lowers precision.
  const confirmedCorrect = scores.reduce((n, s) => n + s.confirmedCorrect, 0);
  const confirmedWrong = scores.reduce((n, s) => n + s.confirmedWrong, 0);

  const liveVerdict = scores.filter((s) => s.kind === 'live' && s.verdictMatch !== undefined);
  const deltaVerdict = scores.filter((s) => s.kind === 'delta' && s.verdictMatch !== undefined);
  const liveMatches = liveVerdict.filter((s) => s.verdictMatch).length;
  const deltaMatches = deltaVerdict.filter((s) => s.verdictMatch).length;

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
    liveVerdictOracleCases: liveVerdict.length,
    liveVerdictMatches: liveMatches,
    liveVerdictAccuracy: ratio(liveMatches, liveVerdict.length),
    deltaVerdictOracleCases: deltaVerdict.length,
    deltaVerdictMatches: deltaMatches,
    deltaVerdictAccuracy: ratio(deltaMatches, deltaVerdict.length),
  };
}

/**
 * The reporting-first gate (F1/F5): the run FAILS only on a real DW-02 reality regression — the
 * LIVE verdict accuracy must be 100% AND there must be at least one live oracle case (so the gate
 * can never pass vacuously if the corpus's `verdict` fields disappear). Precision/silent-miss are
 * reported, not gated, until #71's remaining signals land.
 */
export function gateFailure(m: Metrics): string | null {
  if (m.liveVerdictOracleCases === 0)
    return 'no live verdict-oracle cases — the DW-02 gate would pass vacuously';
  if (m.liveVerdictAccuracy !== 1)
    return `live verdict-vs-reality is ${(m.liveVerdictAccuracy * 100).toFixed(1)}% (not 100%) — a DW-02 regression`;
  return null;
}
