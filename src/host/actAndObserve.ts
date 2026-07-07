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
  /**
   * Max concurrent actionability trial-probes. The reconciliation is O(nodes) and a
   * NOT-actionable node pays the full trialTimeoutMs, so serial reconciliation is
   * slow on many-node deltas. Running probes concurrently turns that sum into ~max.
   * Each node still gets Playwright's full authoritative trial (verdict unchanged).
   */
  reconcileConcurrency?: number;
}

export const DEFAULT_SETTLE: SettleOptions = {
  quietMs: 120,
  maxWaitMs: 2000,
  animMaxMs: 1000,
};

export const DEFAULT_RECONCILE_CONCURRENCY = 12;

/** Map with bounded concurrency, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function actAndObserve(
  page: Page,
  action: Action,
  opts: ActAndObserveOptions = {},
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
    settle,
  );
  const collected = await page.evaluate<CollectResult, SettleOptions>(
    (o) => window.__deltawright!.collect(o),
    settle,
  );

  // Reconcile each changed node's actionability with Playwright, bounded-concurrent
  // so a delta with many NOT-actionable nodes doesn't pay N * trialTimeoutMs serially.
  // Every node still receives its own full authoritative trial (verdict unchanged);
  // only the wall-time collapses from sum toward max.
  const nodes: DeltaNode[] = await mapWithConcurrency(
    collected.nodes,
    opts.reconcileConcurrency ?? DEFAULT_RECONCILE_CONCURRENCY,
    (raw): Promise<DeltaNode> =>
      annotateActionability(page, raw, { trialTimeoutMs: opts.trialTimeoutMs }).then(
        (actionability) => ({ ...raw, actionability }),
      ),
  );

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
