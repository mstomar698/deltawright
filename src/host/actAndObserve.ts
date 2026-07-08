import type { Frame, Page } from '@playwright/test';
import { ensureInjected } from './inject';
import { annotateActionability } from './actionability';
import { diffChangedRegion, type ChangedRegion } from './screenshot-diff';
import type {
  BaselineOptions,
  CollectResult,
  Delta,
  DeltaNode,
  DeltawrightApi,
  SettleOptions,
  SettleResult,
} from './types';

// The injected script installs its API on window.__deltawright. Inside evaluate
// callbacks we reach it through this cast rather than a global Window augmentation,
// so the host stays self-contained (its .d.ts needs no injected-module types) and the
// published package never augments a consumer's global Window. (The alias is a type,
// so it is legal to reference inside the serialized page callbacks below.)
type DwWindow = Window & { __deltawright?: DeltawrightApi };

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
  /**
   * Causal attribution (#15): sample a short pre-action window to learn which
   * (element, channel) pairs are already churning, and exclude that background churn
   * from the delta. On by default; set `baseline: false` to disable. `baselineMs`
   * caps the sample; it early-exits after `baselineEarlyExitMs` on a quiet page, so
   * quiet pages pay little.
   */
  baseline?: boolean;
  baselineMs?: number;
  baselineEarlyExitMs?: number;
  /**
   * Anchor-aware background rescue (#30, opt-in): capture the action's trusted-event
   * origin (target + click point) so the pre-arm baseline's background-insertion drop
   * becomes per-root — the action's OWN instance of a background-looking signature (a
   * confirmation reusing a toast class, rendered at the click) is KEPT instead of
   * dropped. KEEP-ONLY: it can only rescue, never cause a drop, so enabling it strictly
   * reduces false-drops. Off by default; harmless without `baseline`.
   */
  inWindowRecurrence?: boolean;
  /**
   * Gap-E late-wave flag (#49, opt-in). After settle resolves, watch this many ms for a
   * late structural render wave (a two-wave render whose second wave lands after settle).
   * FLAG-NOT-FIX: the late wave is DETECTED (a separate observer sets `stats.lateStructural`,
   * grounding `late-wave-suspected`) but never captured into the delta (declined-as-unsafe in
   * #30). Default 0 = off = the settle path and delta are byte-unchanged.
   */
  lateWatchMs?: number;
  /**
   * Same-origin iframe traversal (#34, opt-in): also observe child frames and merge
   * their changes into the delta, with geometry offset to page-global coordinates and
   * refs prefixed (`f1e2`). Cross-origin/uninjectable frames are skipped. Off by default.
   */
  frames?: boolean;
  /**
   * DOM-less fallback (#20): when the DOM delta is empty (e.g. a `<canvas>`/WebGL draw
   * that mutates no DOM), screenshot before/after and report the changed pixel region
   * as a synthetic node. Off by default (adds a pre-action screenshot).
   */
  screenshotFallback?: boolean;
  pixelThreshold?: number;
  minPixels?: number;
}

export const DEFAULT_SETTLE: SettleOptions = {
  quietMs: 120,
  maxWaitMs: 2000,
  animMaxMs: 1000,
};

export const DEFAULT_RECONCILE_CONCURRENCY = 12;

export const DEFAULT_BASELINE: BaselineOptions = { baselineMs: 150, earlyExitMs: 60 };

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

/** A synthetic delta node for a screenshot-diff region (no backing DOM element). */
function pixelRegionNode(region: ChangedRegion): DeltaNode {
  return {
    ref: 'px1',
    kind: 'added',
    tag: 'canvas-region',
    role: null,
    name: `pixel region changed (${region.changedPixels}px)`,
    interactive: false,
    parentRef: null,
    geometry: {
      rect: region.rect,
      inViewport: true,
      display: '',
      visibility: '',
      opacity: '',
      pointerEvents: '',
      hitSelf: true,
      coveredBy: null,
      offscreen: false,
    },
    actionability: {
      verdict: 'n/a',
      reason: 'pixel-region (screenshot-diff; no DOM element)',
      geometryVerdict: 'n/a',
      playwright: null,
      agreed: true,
    },
  };
}

interface ArmedFrame {
  frame: Frame;
  tag: string;
  offset: { x: number; y: number };
}

/** Inject + baseline + arm each same-origin child frame before the action (#34). */
async function armChildFrames(
  page: Page,
  enabled: boolean,
  baseline: BaselineOptions | null,
  inWindowRecurrence: boolean,
): Promise<ArmedFrame[]> {
  if (!enabled) return [];
  const mainFrame = page.mainFrame();
  const children = page.frames().filter((f) => f !== mainFrame);
  const armed: ArmedFrame[] = [];
  for (let i = 0; i < children.length; i++) {
    const frame = children[i]!;
    try {
      await ensureInjected(frame);
      if (baseline) {
        await frame.evaluate(
          (o) => (window as unknown as DwWindow).__deltawright!.sampleBaseline(o),
          baseline,
        );
      }
      await frame.evaluate(
        (iwr) => (window as unknown as DwWindow).__deltawright!.arm(iwr),
        inWindowRecurrence,
      );
      let offset = { x: 0, y: 0 };
      try {
        const box = await (await frame.frameElement()).boundingBox();
        if (box) offset = { x: box.x, y: box.y };
      } catch {
        // cross-origin frameElement may throw — leave the offset at 0.
      }
      armed.push({ frame, tag: `f${i + 1}`, offset });
    } catch {
      // can't inject (cross-origin CSP / detached) — skip this frame.
    }
  }
  return armed;
}

/** Offset a child-frame node to page-global coordinates and namespace its refs. */
function offsetFrameNode(node: DeltaNode, c: ArmedFrame): DeltaNode {
  const geometry = node.geometry
    ? {
        ...node.geometry,
        rect: {
          ...node.geometry.rect,
          x: node.geometry.rect.x + c.offset.x,
          y: node.geometry.rect.y + c.offset.y,
        },
      }
    : node.geometry;
  return {
    ...node,
    ref: c.tag + node.ref,
    parentRef: node.parentRef ? c.tag + node.parentRef : node.parentRef,
    geometry,
  };
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
    lateWatchMs: opts.lateWatchMs ?? 0,
  };

  await ensureInjected(page);

  // DOM-less fallback (#20): capture the pre-action pixels so we can diff them if the
  // DOM reports no change.
  const beforeShot = opts.screenshotFallback ? await page.screenshot() : null;

  // Causal attribution (#15): learn the background footprint before arming.
  const baseline: BaselineOptions | null =
    opts.baseline === false
      ? null
      : {
          baselineMs: opts.baselineMs ?? DEFAULT_BASELINE.baselineMs,
          earlyExitMs: opts.baselineEarlyExitMs ?? DEFAULT_BASELINE.earlyExitMs,
        };
  if (baseline) {
    await page.evaluate<{ sampledMs: number; footprintSize: number }, BaselineOptions>(
      (o) => (window as unknown as DwWindow).__deltawright!.sampleBaseline(o),
      baseline,
    );
  }

  await page.evaluate(
    (iwr) => (window as unknown as DwWindow).__deltawright!.arm(iwr),
    opts.inWindowRecurrence === true,
  );

  // Same-origin iframe traversal (#34, opt-in): arm child frames too, before the action.
  const childFrames = await armChildFrames(
    page,
    opts.frames === true,
    baseline,
    opts.inWindowRecurrence === true,
  );

  // Perform the action through Playwright so we inherit its auto-wait +
  // actionability on the action target itself.
  await action(page);

  const settleResult = await page.evaluate<SettleResult, SettleOptions>(
    (o) => (window as unknown as DwWindow).__deltawright!.waitForSettle(o),
    settle,
  );
  const collected = await page.evaluate<CollectResult, SettleOptions>(
    (o) => (window as unknown as DwWindow).__deltawright!.collect(o),
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

  // #34: settle + collect + reconcile each armed child frame; offset + prefix, append.
  for (const c of childFrames) {
    try {
      await c.frame.evaluate<SettleResult, SettleOptions>(
        (o) => (window as unknown as DwWindow).__deltawright!.waitForSettle(o),
        settle,
      );
      const cc = await c.frame.evaluate<CollectResult, SettleOptions>(
        (o) => (window as unknown as DwWindow).__deltawright!.collect(o),
        settle,
      );
      const cn = await mapWithConcurrency(
        cc.nodes,
        opts.reconcileConcurrency ?? DEFAULT_RECONCILE_CONCURRENCY,
        (raw): Promise<DeltaNode> =>
          annotateActionability(c.frame, raw, { trialTimeoutMs: opts.trialTimeoutMs }).then(
            (actionability) => offsetFrameNode({ ...raw, actionability }, c),
          ),
      );
      nodes.push(...cn);
    } catch {
      // a frame that navigated/detached mid-action — skip it.
    }
  }

  // DOM-less fallback (#20): if nothing mutated the DOM but pixels may have changed
  // (canvas/WebGL/cross-origin), diff the screenshots and report the changed region.
  if (beforeShot && nodes.length === 0) {
    const region = diffChangedRegion(beforeShot, await page.screenshot(), {
      channelThreshold: opts.pixelThreshold,
      minPixels: opts.minPixels,
    });
    if (region) nodes.push(pixelRegionNode(region));
  }

  return {
    action: opts.label ?? 'action',
    nodes,
    stats: {
      rawRecords: collected.rawRecords,
      settleMs: settleResult.settleMs,
      hitMaxWait: settleResult.hitMaxWait,
      animationsAwaited: collected.animationsAwaited,
      droppedBackground: collected.droppedBackground,
      // Only present when the gap-E watch ran (lateWatchMs > 0), so the default stats object
      // is byte-unchanged.
      ...(settleResult.lateStructural !== undefined
        ? { lateStructural: settleResult.lateStructural }
        : {}),
    },
  };
}
