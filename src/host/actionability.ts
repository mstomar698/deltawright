import type { Frame, Locator, Page } from '@playwright/test';
import type { Actionability, GeometryRead, RawNode, Verdict } from './types';

/**
 * Reconcile the injected geometry read with Playwright's authoritative judgment.
 *
 * The probe is ROLE-AWARE (#17): the verdict matches the action an agent would use on
 * the node — `click({ trial: true })` for buttons/links (Playwright's full engine incl.
 * the pointer hit-test), `isVisible() + isEditable()` for text inputs (fill has no
 * hit-test, so a covered input is fillable), and `isVisible() + isEnabled()` for
 * selects. If the geometry read (pointer-model) and Playwright disagree, PLAYWRIGHT
 * WINS — and we record the disagreement, the gap Deltawright exists to surface.
 *
 * The role-aware probe (`probeActionability`) and the geometry helpers below are
 * factored out so the preflight matcher (#53) reuses the EXACT same authoritative path
 * on a bare locator — the boolean can never diverge between the two surfaces (DW-02).
 */

const DEFAULT_TRIAL_TIMEOUT_MS = 1200;

/** Verdict implied by a geometry read alone (null geometry → n/a). */
export function verdictFromGeometry(g: GeometryRead | null): Verdict {
  if (!g) return 'n/a';
  if (g.offscreen || !g.inViewport) return 'NOT-actionable';
  if (g.coveredBy) return 'NOT-actionable';
  if (g.display === 'none') return 'NOT-actionable';
  if (g.visibility === 'hidden' || g.visibility === 'collapse') return 'NOT-actionable';
  if (parseFloat(g.opacity) === 0) return 'NOT-actionable';
  if (g.pointerEvents === 'none') return 'NOT-actionable';
  return 'ACTIONABLE';
}

/** Verdict implied by the injected geometry read alone. */
export function geometryVerdict(node: RawNode): Verdict {
  return verdictFromGeometry(node.geometry);
}

/** Human reason from a geometry read (more specific than Playwright's message). */
export function reasonFromGeometry(g: GeometryRead | null): string | null {
  if (!g) return null;
  if (g.offscreen || !g.inViewport) return 'off-screen';
  if (g.coveredBy) return `covered-by ${g.coveredBy}`;
  if (g.display === 'none') return 'display:none';
  if (g.visibility === 'hidden' || g.visibility === 'collapse') return `visibility:${g.visibility}`;
  if (parseFloat(g.opacity) === 0) return 'opacity:0';
  if (g.pointerEvents === 'none') return 'pointer-events:none';
  return null;
}

function geometryReason(node: RawNode): string | null {
  return reasonFromGeometry(node.geometry);
}

/** Map a verbose Playwright actionability error to a short reason. */
function parsePlaywrightReason(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('intercepts pointer events')) return 'covered (intercepted)';
  if (m.includes('outside of the viewport')) return 'off-screen';
  if (m.includes('not visible')) return 'not-visible';
  if (m.includes('not enabled')) return 'disabled';
  if (m.includes('not stable')) return 'unstable (animating)';
  if (m.includes('not editable')) return 'not-editable';
  return 'not-actionable';
}

export interface AnnotateOptions {
  trialTimeoutMs?: number;
}

export type PrimaryAction = 'click' | 'fill' | 'select';

/**
 * The action an agent would use on a node with this role — its verdict is probed
 * accordingly, so ACTIONABLE matches what that specific real action does (#17). A text
 * input is `fill`ed (no pointer hit-test — a covered input is still fillable, a
 * read-only one is not); a `<select>` is `selectOption`ed; everything else is clicked.
 */
export function primaryActionForRole(role: string | null): PrimaryAction {
  if (role === 'textbox') return 'fill';
  if (role === 'combobox') return 'select';
  return 'click';
}

/**
 * The role-aware, AUTHORITATIVE Playwright probe on a locator — the single source of the
 * actionability boolean, shared by `annotateActionability` (delta reconciliation) and the
 * preflight matcher (#53). `notVisibleReason` supplies a more specific geometry-derived
 * reason for the non-hit-tested (fill/select) not-visible case when the caller has one.
 */
export async function probeActionability(
  locator: Locator,
  action: PrimaryAction,
  timeout: number,
  notVisibleReason?: string | null,
): Promise<{ actionable: boolean; error?: string }> {
  if (action === 'fill') {
    // fill = visible + editable (enabled + not readonly); it does NOT hit-test, so a
    // covered input is still fillable while a read-only/disabled one is not.
    const visible = await locator.isVisible();
    if (!visible) return { actionable: false, error: notVisibleReason ?? 'not-visible' };
    if (await locator.isEditable()) return { actionable: true };
    return { actionable: false, error: (await locator.isEnabled()) ? 'read-only' : 'disabled' };
  }
  if (action === 'select') {
    const visible = await locator.isVisible();
    return visible && (await locator.isEnabled())
      ? { actionable: true }
      : { actionable: false, error: visible ? 'disabled' : (notVisibleReason ?? 'not-visible') };
  }
  // click / check → the authoritative trial click (includes the pointer hit-test).
  try {
    await locator.click({ trial: true, timeout });
    return { actionable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { actionable: false, error: parsePlaywrightReason(message) };
  }
}

/**
 * Reconcile a probe result + geometry read into the final Actionability. Playwright wins;
 * for a click the (more specific) geometry reason is preferred, for fill/select the probe's
 * own reason is the accurate one (geometry is a pointer-model read). Shared so the delta and
 * the preflight matcher render the verdict/reason/agreed IDENTICALLY.
 */
export function reconcile(
  playwright: { actionable: boolean; error?: string },
  action: PrimaryAction,
  geometryVerdictValue: Verdict,
  geomReason: string | null,
): Actionability {
  const verdict: Verdict = playwright.actionable ? 'ACTIONABLE' : 'NOT-actionable';
  const reason = playwright.actionable
    ? null
    : action === 'click'
      ? (geomReason ?? playwright.error ?? 'not-actionable')
      : (playwright.error ?? 'not-actionable');
  // A geometry read that is n/a (unavailable) can't disagree — treat as agreed.
  const agreed = geometryVerdictValue === 'n/a' ? true : geometryVerdictValue === verdict;
  return { verdict, reason, geometryVerdict: geometryVerdictValue, playwright, agreed };
}

/**
 * Produce the reconciled actionability verdict for one changed node. Removed nodes
 * (no live geometry) are `n/a`. Everything else is probed with its role-appropriate
 * action check (see primaryActionForRole).
 */
export async function annotateActionability(
  target: Page | Frame,
  node: RawNode,
  opts: AnnotateOptions = {},
): Promise<Actionability> {
  const gVerdict = geometryVerdict(node);

  if (!node.geometry) {
    return {
      verdict: 'n/a',
      reason: 'removed',
      geometryVerdict: 'n/a',
      playwright: null,
      agreed: true,
    };
  }

  const timeout = opts.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  const locator = target.locator(`[data-dw-ref="${node.ref}"]`);
  const action = primaryActionForRole(node.role);
  const playwright = await probeActionability(locator, action, timeout, geometryReason(node));
  return reconcile(playwright, action, gVerdict, geometryReason(node));
}
