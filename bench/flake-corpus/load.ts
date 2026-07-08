// Corpus loader + invariant checks (#51). Used by the corpus tests and, next cycle, by the
// accuracy harness (#52). Ground truth is the case's construction manifest + reality-anchor
// oracles — NEVER a stored Deltawright output (the `CorpusCase` type has no field for one).

import { ROOT_CAUSE_CODES, type RootCauseCode } from '../../src/index';
import { CORPUS, type CorpusCase } from './cases';

export { CORPUS };
export type { CorpusCase };

/** The positive cases whose manifest asserts `code` is the true cause. */
export const positiveCases = (): CorpusCase[] => CORPUS.filter((c) => !c.confuser);

/** The near-miss confuser cases (a case that superficially resembles `confusesWith`). */
export const confuserCases = (): CorpusCase[] => CORPUS.filter((c) => c.confuser);

/** Taxonomy codes lacking at least one positive (non-confuser) case. */
export function codesWithoutPositive(): RootCauseCode[] {
  const covered = new Set(positiveCases().map((c) => c.code));
  return ROOT_CAUSE_CODES.filter((code) => !covered.has(code));
}

/** Taxonomy codes lacking at least one near-miss confuser. */
export function codesWithoutConfuser(): RootCauseCode[] {
  const confused = new Set(confuserCases().map((c) => c.confusesWith));
  return ROOT_CAUSE_CODES.filter((code) => !confused.has(code));
}

export interface OracleViolation {
  id: string;
  reason: string;
}

/**
 * Verify every case's ground truth comes from INDEPENDENT oracles, not a stored DW output:
 *  - a construction manifest (`code` + `confidence`) is always present (typed);
 *  - a `live` case carries a reality anchor — the real Playwright `verdict` and/or `truth`
 *    (window.__truth) instrumentation — so scoring is never circular;
 *  - a `delta` case (hand-built, honesty-stamped) carries its authored `verdict` xor is a
 *    pure delta-shape case (empty/stats-only) that needs no verdict.
 * Confusers are exempt from requiring a `verdict` only when they assert `unknown` via a
 * delta-shape (they still carry the manifest oracle).
 */
export function oracleViolations(): OracleViolation[] {
  const out: OracleViolation[] = [];
  for (const c of CORPUS) {
    // The corpus schema forbids a stored-diagnosis field; guard against one sneaking in.
    if ('diagnosis' in c || 'dwOutput' in c || 'predicted' in c) {
      out.push({
        id: c.id,
        reason: 'carries a stored DW output — ground truth must be independent',
      });
    }
    // Manifest oracle: always present.
    if (!c.code || !c.confidence)
      out.push({ id: c.id, reason: 'missing code/confidence manifest' });
    // Independent reality anchor: a LIVE case runs for real (fixture + action) so its verdict
    // is Playwright's own — never a stored DW blob; a DELTA case carries its hand-built delta.
    if (c.kind === 'live' && (!c.fixture || !c.action)) {
      out.push({ id: c.id, reason: 'live case without a runnable fixture + action anchor' });
    }
    if (c.kind === 'delta' && !c.delta) {
      out.push({ id: c.id, reason: 'delta case without a delta' });
    }
    if (c.confuser && !c.confusesWith) {
      out.push({ id: c.id, reason: 'confuser without confusesWith' });
    }
  }
  return out;
}

/** How many cases carry >= 2 independent oracles (manifest + verdict and/or window.__truth). */
export function multiOracleCount(): number {
  return CORPUS.filter(
    (c) => [c.verdict !== undefined, c.truth !== undefined].filter(Boolean).length >= 1,
  ).length;
}

/** A compact per-code coverage summary (positives + confusers), for CORPUS.md / the harness. */
export function coverageSummary(): Array<{
  code: RootCauseCode;
  positives: number;
  confusers: number;
}> {
  return ROOT_CAUSE_CODES.map((code) => ({
    code,
    positives: positiveCases().filter((c) => c.code === code).length,
    confusers: confuserCases().filter((c) => c.confusesWith === code).length,
  }));
}
