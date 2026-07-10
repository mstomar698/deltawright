import type { Page } from '@playwright/test';
import { ensureInjected, InjectionBlockedError } from '../host/inject';
import type { Action } from '../host/actAndObserve';
// DEFAULT_SETTLE comes from the side-effect-free `types` leaf, NOT actAndObserve, so this lean subpath
// does not eagerly pull actAndObserve's screenshot-diff/pngjs subtree.
import {
  DEFAULT_SETTLE,
  type DeltawrightApi,
  type SettleOptions,
  type SettleResult,
} from '../host/types';

// Settle-as-a-wait (#58) — `deltawright/wait`. A locator-free OBSERVE/EXPLAIN completion SIGNAL for
// "after this action, did the DOM go structurally quiet, and did a second wave land late?" It arms the
// observer, runs the action, waits for STRUCTURAL quiescence, and reports the gap-E late-wave
// heuristic. It SKIPS the O(nodes) reconcile (no per-node Playwright probes / geometry) — that is the
// real cost it saves vs actAndObserve. It is NOT unconditionally faster wall-clock: the default
// late-watch adds a fixed window after quiescence (set `lateWatchMs: 0` to skip), and a no-mutation
// action still waits out `maxWaitMs`.
//
// NON-GOAL (named product non-goal): this is NOT a completion guarantee, a retry, or a flake
// suppressant. It OBSERVES and REPORTS a settle signal; it never promises the page is "ready" and
// never silences a flake. `hitMaxWait` and `suspectedEarly` are the honesty signals that the settle
// was inconclusive or possibly early — the caller decides what to do. The result type deliberately
// exposes NO `ready` / `safe` / `settled` boolean and there is no retry knob, so the API cannot be
// mistaken for a guarantee.
//
// `suspectedEarly` is a coarse, best-effort SUSPECTED hint: the late-watch is LIGHT-DOM only, so a
// late wave confined to an open shadow root is NOT flagged (even though `settleMs` does account for
// shadow activity), and it has no background-churn filter, so incidental background structural churn
// during the window can trip it. Treat it as "worth a second look", not a verdict.

const DEFAULT_LATE_WATCH_MS = 400;

type DwWindow = Window & { __deltawright?: DeltawrightApi };

export interface ObserveConsequencesOptions extends Partial<SettleOptions> {
  /**
   * The gap-E (#49) late-wave window, in ms. ON by default here (detecting a late wave is the point),
   * unlike actAndObserve where it is opt-in. A structural wave inside this window sets `suspectedEarly`.
   * It adds up to this much latency after quiescence; set 0 to skip it.
   */
  lateWatchMs?: number;
}

export interface ConsequenceObservation {
  /** ms from arm to structural quiescence (or the maxWait cap). A SIGNAL, not a readiness guarantee. */
  settleMs: number;
  /** true when settle resolved by hitting the cap, not by going quiet — treat the settle as INCONCLUSIVE. */
  hitMaxWait: boolean;
  /** gap-E: a structural wave landed AFTER quiescence, so the observed settle may have been EARLY. A
   *  COARSE hint — light-DOM only (misses open-shadow-root waves) and unfiltered (background structural
   *  churn can trip it). Worth a second look, not a verdict. */
  suspectedEarly: boolean;
  /** false when the observer could not be injected (strict CSP / non-Chromium) — NOTHING was observed. */
  observed: boolean;
  /** present when `observed` is false: the skip reason (skip-with-reason). */
  skippedReason?: string;
}

/**
 * Perform `action`, then observe when the DOM goes structurally quiet — a locator-free settle SIGNAL,
 * cheaper than `actAndObserve` (no reconcile). See the module header: this is observe/explain, NOT a
 * completion guarantee or flake suppressant.
 */
export async function observeConsequences(
  page: Page,
  action: Action,
  opts: ObserveConsequencesOptions = {},
): Promise<ConsequenceObservation> {
  const settle: SettleOptions = {
    quietMs: opts.quietMs ?? DEFAULT_SETTLE.quietMs,
    maxWaitMs: opts.maxWaitMs ?? DEFAULT_SETTLE.maxWaitMs,
    animMaxMs: opts.animMaxMs ?? DEFAULT_SETTLE.animMaxMs,
    lateWatchMs: opts.lateWatchMs ?? DEFAULT_LATE_WATCH_MS,
  };

  // Degrade under a strict CSP / non-Chromium (addScriptTag blocked): still run the action, but report
  // observed:false with a reason. Only an InjectionBlockedError degrades; other faults re-throw (DW-03).
  try {
    await ensureInjected(page);
  } catch (err) {
    if (!(err instanceof InjectionBlockedError)) throw err;
    await action(page);
    return {
      settleMs: 0,
      hitMaxWait: false,
      suspectedEarly: false,
      observed: false,
      skippedReason: 'observer injection blocked (strict CSP / non-Chromium) — settle not observed',
    };
  }

  await page.evaluate(() => (window as unknown as DwWindow).__deltawright!.arm(false));
  try {
    await action(page);
    const result = await page.evaluate<SettleResult, SettleOptions>(
      (o) => (window as unknown as DwWindow).__deltawright!.waitForSettle(o),
      settle,
    );
    // Wait out the late-watch window (if any) and read whether a late structural wave landed.
    const late = await page.evaluate(() =>
      (window as unknown as DwWindow).__deltawright!.lateResult(),
    );
    return {
      settleMs: result.settleMs,
      hitMaxWait: result.hitMaxWait,
      suspectedEarly: late.lateStructural,
      observed: true,
    };
  } finally {
    // We skipped collect() (which normally stops the observer), so ALWAYS disconnect it — even if the
    // action / an evaluate threw — so no MutationObserver is left running. Best-effort: a closed page
    // makes reset() throw; swallow that so it never masks the original error.
    await page
      .evaluate(() => (window as unknown as DwWindow).__deltawright!.reset())
      .catch(() => {});
  }
}
