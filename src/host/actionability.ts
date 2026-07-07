import type { Page } from '@playwright/test';
import type { Actionability, RawNode, Verdict } from './types';

/**
 * Reconcile the injected geometry read with Playwright's authoritative judgment.
 *
 * The authoritative probe is `locator.click({ trial: true })`: it runs Playwright's
 * FULL actionability engine (visible + stable + receives-events/not-obscured +
 * enabled, including scroll-into-view) but performs NO click, so it cannot consume
 * the target. If our geometry read and Playwright disagree, PLAYWRIGHT WINS — and we
 * record the disagreement, because that gap is exactly what Deltawright exists to
 * surface.
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
 * Produce the reconciled actionability verdict for one changed node. Removed nodes
 * (no live geometry) are `n/a`. Everything else is probed with a trial click.
 */
export async function annotateActionability(
  page: Page,
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
  const locator = page.locator(`[data-dw-ref="${node.ref}"]`);

  let playwright: { actionable: boolean; error?: string };
  try {
    await locator.click({ trial: true, timeout });
    playwright = { actionable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    playwright = { actionable: false, error: parsePlaywrightReason(message) };
  }

  // Playwright wins.
  const verdict: Verdict = playwright.actionable ? 'ACTIONABLE' : 'NOT-actionable';
  const reason = playwright.actionable
    ? null
    : (geometryReason(node) ?? playwright.error ?? 'not-actionable');
  const agreed = gVerdict === verdict;

  return { verdict, reason, geometryVerdict: gVerdict, playwright, agreed };
}
