// The pure root-cause engine (#48). ONE shared artifact every diagnosis surface consumes,
// so codes and confidence stay identical across the side-car, aggregator, and MCP. It reads
// ONLY the existing Delta / stats / actionability — it adds no new membership filter and
// geometry never filters (DW-02: Playwright's verdict is authoritative and untouched here).
//
// The core rule is AGREE-OR-FLAG (DW-03): a NOT-actionable node earns a specific cause code
// only from the branch where the two engines already agree it is blocked (`agreed===true`).
// When they disagree (`agreed===false`) the node is `geom-disagreement` WITH DIRECTION —
// never a code that contradicts Playwright's verdict.
//
// Within the agreed branch, PLAYWRIGHT'S NAMED CAUSE WINS: verdict-agreement is not
// cause-agreement (a disabled AND covered button has both engines saying NOT-actionable, but
// Playwright's authoritative cause is `disabled`, not `covered`). So we prefer the cause
// Playwright named (→ confirmed), fall back to the geometry-visible cause only as a
// `suspected` hypothesis when Playwright did not name a specific one.

import type { DeltaNode, Delta, DiagnosedDelta, Diagnosis } from './types';
import { assessConfidence, type Confidence } from './confidence';
import type { RootCauseCode } from './taxonomy';

// A background-churn flag fires only when dropped churn is both substantial and dominant,
// so a couple of incidental drops next to a real change do not cry wolf.
const CHURN_MIN = 3;

/** The cause Playwright's authoritative error string names, or null if it is not specific. */
function codeFromPlaywrightError(error: string | undefined): RootCauseCode | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes('disabled') || e.includes('not enabled')) return 'disabled';
  if (e.includes('read-only') || e.includes('readonly') || e.includes('not editable'))
    return 'read-only';
  if (e.includes('unstable') || e.includes('not stable') || e.includes('animat'))
    return 'unstable-animating';
  if (e.includes('intercept') || e.includes('cover')) return 'covered-by-overlay';
  if (e.includes('off-screen') || e.includes('viewport') || e.includes('outside'))
    return 'off-screen';
  if (e.includes('not-visible') || e.includes('not visible') || e.includes('hidden'))
    return 'not-visible';
  if (e.includes('pointer-events') || e.includes('pointer events')) return 'pointer-events-none';
  return null;
}

/**
 * The geometry-visible cause for an agreed NOT-actionable node. The check ORDER mirrors
 * `geometryVerdict` (offscreen → covered → not-visible → pointer-events) so the emitted code
 * matches the geometry reason, and the covered check uses `coveredBy` alone (as the verdict
 * does) rather than also requiring `!hitSelf`.
 */
function codeFromGeometry(node: DeltaNode): RootCauseCode {
  const g = node.geometry;
  if (!g) return 'unknown';
  if (g.offscreen || !g.inViewport) return 'off-screen';
  if (g.coveredBy) return 'covered-by-overlay';
  if (g.display === 'none' || g.visibility === 'hidden' || g.visibility === 'collapse')
    return 'not-visible';
  if (parseFloat(g.opacity) === 0) return 'not-visible';
  if (g.pointerEvents === 'none') return 'pointer-events-none';
  return 'unknown';
}

/** Diagnose an agreed NOT-actionable node — Playwright's named cause wins over geometry's. */
function blockingDiagnosis(node: DeltaNode): Diagnosis {
  const a = node.actionability;
  const pwErr = a.playwright?.error;
  const pwCode = codeFromPlaywrightError(pwErr);
  const geomCode = codeFromGeometry(node);

  let code: RootCauseCode;
  let confidence: Confidence;
  let detail: string;

  if (pwCode) {
    // Playwright authoritatively named the cause → it wins. Confirmed either way; note
    // whether geometry independently agreed on the SAME cause.
    code = pwCode;
    const sameCause = geomCode === pwCode;
    confidence = assessConfidence({ source: sameCause ? 'geometry+playwright' : 'playwright' });
    detail = `Playwright NOT-actionable${pwErr ? ` (${pwErr})` : ''}; ${
      sameCause ? 'geometry agrees' : `geometry read ${geomCode}`
    }`;
  } else if (geomCode !== 'unknown') {
    // Only the geometry read named a specific cause; Playwright agrees it is blocked but did
    // not corroborate WHICH — a hypothesis, not confirmed.
    code = geomCode;
    confidence = assessConfidence({ source: 'geometry' });
    detail = `Playwright NOT-actionable${a.reason ? ` (${a.reason})` : ''}; geometry read ${geomCode} (suspected)`;
  } else {
    code = 'unknown';
    confidence = 'unknown';
    detail = `Playwright NOT-actionable${a.reason ? ` (${a.reason})` : ''}; cause not attributable`;
  }

  return { code, confidence, scope: 'node', ref: node.ref, detail };
}

/** A geometry↔Playwright disagreement, carrying the direction both ways. */
function geomDisagreement(node: DeltaNode): Diagnosis {
  const a = node.actionability;
  const reason = a.reason ? ` (${a.reason})` : '';
  return {
    code: 'geom-disagreement',
    // Conflicting by definition; Playwright is authoritative, geometry dissents → suspected.
    confidence: assessConfidence({ source: 'playwright', conflicting: true }),
    scope: 'node',
    ref: node.ref,
    detail: `Playwright ${a.verdict}${reason}; geometry read ${a.geometryVerdict}`,
  };
}

/** Diagnose one changed node, or null when there is nothing to explain. */
function diagnoseNode(node: DeltaNode): Diagnosis | null {
  const a = node.actionability;

  if (a.verdict === 'NOT-actionable') {
    // Both engines agree it is blocked → attribute the cause (Playwright's wins). Otherwise
    // geometry dissented (e.g. a covered input Playwright can still fill) → flag it, no code.
    return a.agreed ? blockingDiagnosis(node) : geomDisagreement(node);
  }

  if (a.verdict === 'ACTIONABLE' && !a.agreed) {
    // Playwright says actionable, geometry dissented (e.g. [geom:NOT-actionable]). Surface
    // the disagreement; NEVER emit a blocking code that would contradict the verdict.
    return geomDisagreement(node);
  }

  // Actionable + agreed, or n/a (removed / non-interactive) → nothing to explain.
  return null;
}

/** Delta/stats-level diagnoses (settle, empty-miss, background churn). */
function diagnoseDelta(delta: Delta): Diagnosis[] {
  const out: Diagnosis[] = [];
  const { stats, nodes } = delta;

  if (nodes.length === 0 && stats.hitMaxWait) {
    // Empty AND the cap was hit: a true no-op OR a missed effect — genuinely ambiguous, so
    // the honest confidence is unknown (not a confident no-op).
    out.push({
      code: 'suspected-miss-empty',
      confidence: 'unknown',
      scope: 'delta',
      detail: 'no nodes captured before the settle cap — a no-op or a missed effect',
    });
  } else if (stats.hitMaxWait) {
    out.push({
      code: 'settle-timeout',
      confidence: assessConfidence({ source: 'timing' }),
      scope: 'delta',
      detail: 'settle resolved by hitting the maxWait cap, not by going quiet',
    });
  }

  if (stats.lateStructural) {
    // Gap-E (#49): a structural mutation landed after settle resolved. The late wave was
    // observed but not captured, so the delta may be under-reporting a second render wave.
    out.push({
      code: 'late-wave-suspected',
      confidence: assessConfidence({ source: 'timing' }),
      scope: 'delta',
      detail: 'a structural mutation landed after settle — a late render wave was not captured',
    });
  }

  if (stats.droppedBackground >= CHURN_MIN && stats.droppedBackground >= nodes.length) {
    out.push({
      code: 'background-churn',
      confidence: assessConfidence({ source: 'timing' }),
      scope: 'delta',
      detail: `${stats.droppedBackground} background changes dropped — churn may be masking the change`,
    });
  }

  return out;
}

/**
 * Diagnose a delta: attach root-cause hypotheses without changing the delta itself. Pure —
 * no I/O, no Playwright calls, no mutation. The verdict is read, never overridden (DW-02).
 */
export function diagnose(delta: Delta): DiagnosedDelta {
  const diagnoses: Diagnosis[] = [];
  for (const node of delta.nodes) {
    const d = diagnoseNode(node);
    if (d) diagnoses.push(d);
  }
  diagnoses.push(...diagnoseDelta(delta));
  return { ...delta, diagnoses };
}
