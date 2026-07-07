import type { Frame, Page } from '@playwright/test';
import type { Actionability, RawNode, Verdict } from './types';

/**
 * Reconcile the injected geometry read with Playwright's authoritative judgment.
 *
 * The probe is ROLE-AWARE (#17): the verdict matches the action an agent would use on
 * the node — `click({ trial: true })` for buttons/links (Playwright's full engine incl.
 * the pointer hit-test), `isVisible() + isEditable()` for text inputs (fill has no
 * hit-test, so a covered input is fillable), and `isVisible() + isEnabled()` for
 * selects. If the geometry read (pointer-model) and Playwright disagree, PLAYWRIGHT
 * WINS — and we record the disagreement, the gap Deltawright exists to surface.
 */

const DEFAULT_TRIAL_TIMEOUT_MS = 1200;

/** Verdict implied by the injected geometry read alone. */
export function geometryVerdict(node: RawNode): Verdict {
  const g = node.geometry;
  if (!g) return 'n/a';
  if (g.offscreen || !g.inViewport) return 'NOT-actionable';
  if (g.coveredBy) return 'NOT-actionable';
  if (g.display === 'none') return 'NOT-actionable';
  if (g.visibility === 'hidden' || g.visibility === 'collapse') return 'NOT-actionable';
  if (parseFloat(g.opacity) === 0) return 'NOT-actionable';
  if (g.pointerEvents === 'none') return 'NOT-actionable';
  return 'ACTIONABLE';
}

/** Human reason from the geometry read (more specific than Playwright's message). */
function geometryReason(node: RawNode): string | null {
  const g = node.geometry;
  if (!g) return null;
  if (g.offscreen || !g.inViewport) return 'off-screen';
  if (g.coveredBy) return `covered-by ${g.coveredBy}`;
  if (g.display === 'none') return 'display:none';
  if (g.visibility === 'hidden' || g.visibility === 'collapse') return `visibility:${g.visibility}`;
  if (parseFloat(g.opacity) === 0) return 'opacity:0';
  if (g.pointerEvents === 'none') return 'pointer-events:none';
  return null;
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

/**
 * The action an agent would use on this node — its verdict is probed accordingly, so
 * ACTIONABLE matches what that specific real action does (#17). A text input is
 * `fill`ed (no pointer hit-test — a covered input is still fillable, a read-only one
 * is not); a `<select>` is `selectOption`ed; everything else is clicked.
 */
function primaryAction(node: RawNode): 'click' | 'fill' | 'select' {
  if (node.role === 'textbox') return 'fill';
  if (node.role === 'combobox') return 'select';
  return 'click';
}

/**
 * Produce the reconciled actionability verdict for one changed node. Removed nodes
 * (no live geometry) are `n/a`. Everything else is probed with its role-appropriate
 * action check (see primaryAction).
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
  const action = primaryAction(node);

  let playwright: { actionable: boolean; error?: string };
  if (action === 'fill') {
    // fill = visible + editable (enabled + not readonly); it does NOT hit-test, so a
    // covered input is still fillable while a read-only/disabled one is not.
    const visible = await locator.isVisible();
    if (!visible) {
      playwright = { actionable: false, error: geometryReason(node) ?? 'not-visible' };
    } else if (await locator.isEditable()) {
      playwright = { actionable: true };
    } else {
      playwright = {
        actionable: false,
        error: (await locator.isEnabled()) ? 'read-only' : 'disabled',
      };
    }
  } else if (action === 'select') {
    const visible = await locator.isVisible();
    playwright =
      visible && (await locator.isEnabled())
        ? { actionable: true }
        : {
            actionable: false,
            error: visible ? 'disabled' : (geometryReason(node) ?? 'not-visible'),
          };
  } else {
    // click / check → the authoritative trial click (includes the pointer hit-test).
    try {
      await locator.click({ trial: true, timeout });
      playwright = { actionable: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      playwright = { actionable: false, error: parsePlaywrightReason(message) };
    }
  }

  // Playwright wins. For click, prefer the (more specific) geometry reason; for
  // fill/select, the probe's own reason is the accurate one (geometry is pointer-model).
  const verdict: Verdict = playwright.actionable ? 'ACTIONABLE' : 'NOT-actionable';
  const reason = playwright.actionable
    ? null
    : action === 'click'
      ? (geometryReason(node) ?? playwright.error ?? 'not-actionable')
      : (playwright.error ?? 'not-actionable');
  const agreed = gVerdict === verdict;

  return { verdict, reason, geometryVerdict: gVerdict, playwright, agreed };
}
