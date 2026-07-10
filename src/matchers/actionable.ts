import type { Locator } from '@playwright/test';
import { ensureInjected, InjectionBlockedError } from '../host/inject';
import {
  primaryActionForRole,
  probeActionability,
  reasonFromGeometry,
  reconcile,
  verdictFromGeometry,
} from '../host/actionability';
import type { DeltawrightApi, GeometryRead, Verdict } from '../host/types';

// Preflight actionability matcher (#53). A GROUND-TRUTH wrapper, not a diagnosis feature: it emits
// Playwright's OWN role-aware verdict for a bare locator, with no prior actAndObserve. Geometry is
// read best-effort only for the `[geom:]` disagreement hint and NEVER flips the boolean (DW-02);
// under a strict CSP / non-Chromium (where the observer can't be injected) it degrades to a
// Playwright-only verdict. The probe is the SAME `probeActionability` the delta uses, so the two
// surfaces can never diverge.

type DwWindow = Window & { __deltawright?: DeltawrightApi };

const DEFAULT_TRIAL_TIMEOUT_MS = 1200;

export interface PreflightOptions {
  /** Timeout for the role-aware Playwright trial-action probe (ms). Default 1200. */
  trialTimeoutMs?: number;
  /**
   * Skip the geometry annotation entirely (never inject). The verdict is unaffected — it is always
   * Playwright's — so this only drops the `[geom:]` disagreement hint. Handy on a page you already
   * know is under a strict CSP, to avoid a doomed addScriptTag attempt.
   */
  geometry?: boolean;
}

export interface PreflightResult {
  /** Playwright's AUTHORITATIVE verdict for the role-appropriate action. Geometry never flips it. */
  verdict: Verdict;
  /** Human reason when NOT-actionable; null when actionable. */
  reason: string | null;
  /** What geometry alone concluded, or 'n/a' when geometry was unavailable (CSP / no injection). */
  geometryVerdict: Verdict;
  /** Did geometry and Playwright agree? Always true when geometry is n/a (nothing to disagree with). */
  agreed: boolean;
}

/**
 * Resolve the element's role for action selection. Uses `locator.evaluate` (CDP-backed, so it works
 * even under a CSP that would block injection). A missing/detached element yields null → the click
 * probe then authoritatively reports NOT-actionable.
 */
async function roleOfLocator(locator: Locator): Promise<string | null> {
  try {
    return await locator.evaluate((el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit') return 'button';
        return 'textbox';
      }
      const implicit: Record<string, string> = {
        button: 'button',
        a: 'link',
        select: 'combobox',
        textarea: 'textbox',
      };
      return implicit[tag] ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * Read one element's geometry via the injected probe, or null when unavailable — a strict CSP /
 * non-Chromium page where the observer can't be injected, or a locator that resolves to nothing.
 * Best-effort by design: a null here only drops the `[geom:]` hint, never the verdict.
 */
async function readGeometry(locator: Locator): Promise<GeometryRead | null> {
  try {
    await ensureInjected(locator.page());
  } catch (err) {
    // Degrade to a Playwright-only verdict ONLY on a genuine injection block (strict CSP). A
    // presence-probe / bundle-load / transient fault is a different problem (DW-03, mirroring
    // actAndObserve's degrade gate) — let it surface rather than masking it as 'geometry
    // unavailable' and silently reporting agreed=true.
    if (err instanceof InjectionBlockedError) return null;
    throw err;
  }
  try {
    return await locator.evaluate((el) =>
      (window as unknown as DwWindow).__deltawright!.probeGeometry(el),
    );
  } catch {
    // The element resolves to nothing (detached/missing) — there is no geometry to read; the
    // Playwright probe then authoritatively reports the verdict. Tolerant on purpose.
    return null;
  }
}

/**
 * Preflight actionability for a bare locator (#53) — no prior actAndObserve required. The verdict is
 * Playwright's own role-aware judgment (the SAME `probeActionability` the delta uses), so geometry
 * NEVER flips it (DW-02). Geometry is read best-effort for the `[geom:]` disagreement hint; if the
 * observer can't be injected (strict CSP / non-Chromium) it degrades to a Playwright-only verdict
 * (`geometryVerdict: 'n/a'`, `agreed: true`).
 */
export async function preflight(
  locator: Locator,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const timeout = opts.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  const role = await roleOfLocator(locator);
  const action = primaryActionForRole(role);
  const geom = opts.geometry === false ? null : await readGeometry(locator);
  const geomReason = reasonFromGeometry(geom);
  const playwright = await probeActionability(locator, action, timeout, geomReason);

  // Reuse the delta's reconciliation verbatim (Playwright wins; geometry only annotates), so the
  // matcher renders verdict/reason/agreed IDENTICALLY to a delta node — drop only the internal
  // `playwright` field PreflightResult does not expose.
  const a = reconcile(playwright, action, verdictFromGeometry(geom), geomReason);
  return {
    verdict: a.verdict,
    reason: a.reason,
    geometryVerdict: a.geometryVerdict,
    agreed: a.agreed,
  };
}

/**
 * The Playwright matcher: `expect(locator).toBeActionable()` passes IFF the role-aware Playwright
 * probe finds the locator actionable. Register with `expect.extend(dwMatchers)`. The failure message
 * carries the reason and, on a geometry↔Playwright disagreement, the `[geom:]` hint — surfaced
 * WITHOUT ever overriding Playwright's boolean.
 */
export async function toBeActionable(
  locator: Locator,
  opts?: PreflightOptions,
): Promise<{ pass: boolean; message: () => string }> {
  const r = await preflight(locator, opts);
  const pass = r.verdict === 'ACTIONABLE';
  const geomHint = !r.agreed && r.geometryVerdict !== 'n/a' ? ` [geom:${r.geometryVerdict}]` : '';
  const message = () =>
    pass
      ? `expected locator NOT to be actionable, but Playwright found it ACTIONABLE${geomHint}`
      : `expected locator to be actionable, but Playwright found it NOT-actionable (${r.reason ?? 'unknown'})${geomHint}`;
  return { pass, message };
}

/** The matcher bag for `expect.extend(dwMatchers)`. */
export const dwMatchers = { toBeActionable };
