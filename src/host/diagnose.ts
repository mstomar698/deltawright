// The pure root-cause engine (#48). ONE shared artifact every diagnosis surface consumes,
// so codes and confidence stay identical across the side-car, aggregator, and MCP. It reads
// ONLY the existing Delta / stats / actionability — it adds no new membership filter and
// geometry never filters (DW-02: Playwright's verdict is authoritative and untouched here).
//
// The core rule is AGREE-OR-FLAG (DW-03): a NOT-actionable node earns a specific blocking
// code ONLY when the geometry read and Playwright AGREE it is blocked (so the code names a
// cause both engines see). When they disagree (`agreed===false`) the node is reported as
// `geom-disagreement` WITH DIRECTION — never a code that contradicts Playwright's verdict.
// Disabled / read-only / animating causes are Playwright-only (geometry reads them as
// actionable), so they surface as geom-disagreement carrying Playwright's reason.

import type { DeltaNode, Delta, DiagnosedDelta, Diagnosis } from './types';
import { assessConfidence } from './confidence';
import type { RootCauseCode } from './taxonomy';

// A background-churn flag fires only when dropped churn is both substantial and dominant,
// so a couple of incidental drops next to a real change do not cry wolf.
const CHURN_MIN = 3;

/** Map an agreed NOT-actionable node to its geometry-visible blocking code. */
function classifyBlocking(node: DeltaNode): RootCauseCode {
  const g = node.geometry;
  // agreed + NOT-actionable means geometryVerdict is NOT-actionable, so exactly one of
  // these geometry causes fired (see geometryVerdict). `unknown` is a defensive fallback.
  if (!g) return 'unknown';
  if (g.offscreen || !g.inViewport) return 'off-screen';
  if (g.display === 'none' || g.visibility === 'hidden' || g.visibility === 'collapse')
    return 'not-visible';
  if (parseFloat(g.opacity) === 0) return 'not-visible';
  if (g.pointerEvents === 'none') return 'pointer-events-none';
  if (g.coveredBy && !g.hitSelf) return 'covered-by-overlay';
  return 'unknown';
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
    if (a.agreed) {
      const code = classifyBlocking(node);
      return {
        code,
        // Both engines agree it is blocked → confirmed; only the un-mappable fallback is unsure.
        confidence:
          code === 'unknown' ? 'unknown' : assessConfidence({ source: 'geometry+playwright' }),
        scope: 'node',
        ref: node.ref,
        detail:
          code === 'unknown'
            ? `Playwright NOT-actionable${a.reason ? ` (${a.reason})` : ''}; cause not attributable`
            : `Playwright NOT-actionable${a.reason ? ` (${a.reason})` : ''}; geometry agrees`,
      };
    }
    // NOT-actionable but geometry disagreed (e.g. a covered input Playwright can still fill,
    // or a disabled control geometry reads as actionable) → flag the disagreement, no code.
    return geomDisagreement(node);
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
