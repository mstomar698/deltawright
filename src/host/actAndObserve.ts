import type { Page } from '@playwright/test';
import { ensureInjected } from './inject';
import { annotateActionability } from './actionability';
import type { CollectResult, Delta, DeltaNode, SettleOptions, SettleResult } from './types';

/**
 * The v0.1 core primitive. Perform ONE action and return a compact structured
 * delta of what changed, where it is, and whether it is actionable — with no
 * before/after full snapshot.
 *
 * Flow: ensure the observer is injected -> arm it -> run the action through
 * Playwright (inheriting its auto-wait + actionability) -> wait for settle ->
 * collect the coalesced, geometry-annotated changed nodes -> reconcile each
 * node's actionability against Playwright's authoritative judgment.
 */

export type Action = (page: Page) => Promise<unknown>;

export interface ActAndObserveOptions extends Partial<SettleOptions> {
  /** Human label for the action, used in the serialized header ("after <label>:"). */
  label?: string;
  /** Timeout for each per-node Playwright trial-action probe. */
  trialTimeoutMs?: number;
}

export const DEFAULT_SETTLE: SettleOptions = {
  quietMs: 120,
  maxWaitMs: 2000,
  animMaxMs: 1000,
};

export async function actAndObserve(
  page: Page,
  action: Action,
  opts: ActAndObserveOptions = {}
): Promise<Delta> {
  const settle: SettleOptions = {
    quietMs: opts.quietMs ?? DEFAULT_SETTLE.quietMs,
    maxWaitMs: opts.maxWaitMs ?? DEFAULT_SETTLE.maxWaitMs,
    animMaxMs: opts.animMaxMs ?? DEFAULT_SETTLE.animMaxMs,
  };

  await ensureInjected(page);
  await page.evaluate(() => window.__deltawright!.arm());

  // Perform the action through Playwright so we inherit its auto-wait +
  // actionability on the action target itself.
  await action(page);

  const settleResult = await page.evaluate<SettleResult, SettleOptions>(
    (o) => window.__deltawright!.waitForSettle(o),
    settle
  );
  const collected = await page.evaluate<CollectResult, SettleOptions>(
    (o) => window.__deltawright!.collect(o),
    settle
  );

  // Reconcile each changed node's actionability with Playwright. Serial to keep
  // the trial probes (which scroll-into-view) deterministic.
  const nodes: DeltaNode[] = [];
  for (const raw of collected.nodes) {
    const actionability = await annotateActionability(page, raw, {
      trialTimeoutMs: opts.trialTimeoutMs,
    });
    nodes.push({ ...raw, actionability });
  }

  return {
    action: opts.label ?? 'action',
    nodes,
    stats: {
      rawRecords: collected.rawRecords,
      settleMs: settleResult.settleMs,
      hitMaxWait: settleResult.hitMaxWait,
      animationsAwaited: collected.animationsAwaited,
    },
  };
}
