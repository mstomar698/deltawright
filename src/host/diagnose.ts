// The pure root-cause engine (#48). ONE shared artifact every diagnosis surface consumes,
// so codes and confidence stay identical across the side-car, aggregator, and MCP. It reads
// ONLY the existing Delta / stats / actionability — it adds no new membership filter and
// geometry never filters (DW-02: Playwright's verdict is authoritative and untouched here).
//
// The core rule is AGREE-OR-FLAG (DW-03): a NOT-actionable node earns a specific cause code
// from the branch where the two engines agree it is blocked (`agreed===true`). When they
// disagree (`agreed===false`) the node is `geom-disagreement` WITH DIRECTION — never a code
// that contradicts Playwright's verdict.
//
// Within the agreed branch, PLAYWRIGHT'S NAMED CAUSE WINS: verdict-agreement is not
// cause-agreement (a disabled AND covered button has both engines saying NOT-actionable, but
// Playwright's authoritative cause is `disabled`, not `covered`). So we prefer the cause
// Playwright named (→ confirmed), fall back to the geometry-visible cause only as a
// `suspected` hypothesis when Playwright did not name a specific one.
//
// GEOMETRY-BLIND RECOVERY (#71, extends agree-or-flag): some causes only Playwright can
// observe — `disabled` / `read-only` / `unstable-animating`. Geometry has NO signal for them,
// so a NOT-actionable node with one of these causes reads geometry-ACTIONABLE and lands in the
// disagreed branch. That "disagreement" is structural blindness, not real counter-evidence, so
// we still recover the Playwright-named cause (confirmed — it IS the verdict's reason and never
// contradicts it). Crucially this recovery is limited to the geometry-BLIND set: a dissent on a
// geometry-VISIBLE cause (covered / off-screen / not-visible / pointer-events) is genuine
// counter-evidence and stays `geom-disagreement`.

import type { DeltaNode, Delta, DiagnosedDelta, Diagnosis } from './types';
import { assessConfidence, type Confidence } from './confidence';
import type { RootCauseCode } from './taxonomy';

// A background-churn flag fires only when dropped churn is both substantial and dominant,
// so a couple of incidental drops next to a real change do not cry wolf.
const CHURN_MIN = 3;

// Causes ONLY Playwright can observe. Geometry (rect / style / elementFromPoint) has no read
// for the enabled, editable, or stability state, so its "actionable" verdict on one of these
// is the ABSENCE of evidence about the cause, never evidence against it. Recovering these from
// the disagreed branch (#71) is what gives the disabled/read-only/animating class its recall.
const GEOMETRY_BLIND_CAUSES = new Set<RootCauseCode>([
  'disabled',
  'read-only',
  'unstable-animating',
]);

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

  // Playwright's "intercept" error is GENERIC: it fires for a real overlay AND when the target
  // itself doesn't receive the hit (pointer-events:none — where elementFromPoint returns the
  // element BEHIND, so `coveredBy` is set to an incidental node). When the target's own computed
  // pointer-events is none, THAT is the true cause, not "covered-by-overlay" (#71).
  const pwGenericIntercept =
    pwCode === 'covered-by-overlay' && node.geometry?.pointerEvents === 'none';

  if (pwGenericIntercept) {
    code = 'pointer-events-none';
    // A geometry-only specific cause Playwright confirmed only as "blocked" → suspected.
    confidence = assessConfidence({ source: 'geometry' });
    detail = `Playwright NOT-actionable${pwErr ? ` (${pwErr})` : ''}; geometry: the target's own pointer-events:none swallows the hit`;
  } else if (pwCode) {
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

/**
 * A Playwright-only blocking cause recovered from the DISAGREED branch (#71). Playwright's
 * verdict is NOT-actionable and its error names a cause geometry is structurally blind to;
 * geometry's dissenting "actionable" read is that blindness, not counter-evidence, so the cause
 * is `confirmed` (Playwright is authoritative and named it). It never contradicts the verdict —
 * it IS the verdict's reason. Geometry's read is kept in the detail for transparency.
 */
function blindCauseDiagnosis(node: DeltaNode, code: RootCauseCode): Diagnosis {
  const a = node.actionability;
  const err = a.playwright?.error;
  return {
    code,
    confidence: assessConfidence({ source: 'playwright' }),
    scope: 'node',
    ref: node.ref,
    detail: `Playwright NOT-actionable${err ? ` (${err})` : ''}; a Playwright-only cause geometry cannot observe (geometry read ${a.geometryVerdict})`,
  };
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
    // Both engines agree it is blocked → attribute the cause (Playwright's wins).
    if (a.agreed) return blockingDiagnosis(node);
    // Disagreed: geometry read it actionable. If Playwright named a cause geometry is
    // structurally BLIND to (disabled / read-only / unstable-animating), that is not a real
    // conflict — recover the Playwright-named cause (#71). For a geometry-VISIBLE cause the
    // dissent is genuine counter-evidence → flag the disagreement, no blocking code.
    const pwCode = codeFromPlaywrightError(a.playwright?.error);
    if (pwCode && GEOMETRY_BLIND_CAUSES.has(pwCode)) return blindCauseDiagnosis(node, pwCode);
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

  if (stats.detachedReRender) {
    // #71 fix #3: a freshly-added subtree was inserted and detached again within the window (a
    // re-render / list-virtualization swap). The reported delta shows only the replacement, so a
    // handle to the original is stale. SUSPECTED, not confirmed: an add-then-detach can also be a
    // benign transient (a spinner), and the observer read alone cannot tell them apart. Scope:
    // this catches the IN-WINDOW add-then-detach sub-case only (recurring BACKGROUND churn is
    // already excluded via bgInsert in coalesce); a keyed-list reorder, a detach inside a shadow
    // root / child frame, or a re-render AFTER collect are out of scope for this signal.
    out.push({
      code: 'detached-re-render',
      confidence: assessConfidence({ source: 'timing' }),
      scope: 'delta',
      detail:
        'a freshly-added node was detached within the settle window — a re-render/reconciliation swap; the reported delta shows the replacement and a handle to the original would be stale',
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
    if (node.tag === 'canvas-region') {
      // The screenshot-diff fallback (#20) produced a synthetic pixel region — no DOM element,
      // so it's a coarse where-did-pixels-change hint, not an actionability read (#71).
      diagnoses.push({
        code: 'pixel-region-fallback',
        confidence: 'suspected',
        scope: 'node',
        ref: node.ref,
        detail: 'no DOM delta; a screenshot-diff pixel region stood in',
      });
    }
    if (node.geometry?.stable === false) {
      // Gap-F (#50): a post-settle reposition moved the rect; the later rect was adopted.
      // Orthogonal to the actionability diagnosis, so it is a separate per-node note.
      diagnoses.push({
        code: 'stale-rect-suspected',
        confidence: assessConfidence({ source: 'geometry' }),
        scope: 'node',
        ref: node.ref,
        detail:
          'the annotated rect moved after settle (a post-settle reposition); later rect adopted',
      });
    }
  }
  diagnoses.push(...diagnoseDelta(delta));
  return { ...delta, diagnoses };
}
