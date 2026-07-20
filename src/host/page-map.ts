import type { Page } from '@playwright/test';
import { ensureInjected, InjectionBlockedError } from './inject';
import {
  verdictFromGeometry,
  reasonFromGeometry,
  probeActionability,
  primaryActionForRole,
  reconcile,
} from './actionability';
import type {
  Delta,
  DeltawrightApi,
  PageMapLayer,
  RawPageMap,
  RawPageMapNode,
  ScanOptions,
  Verdict,
} from './types';

// The injected script installs its API on window.__deltawright; reach it through this cast inside
// evaluate callbacks (same pattern as actAndObserve) so the host stays self-contained.
type DwWindow = Window & { __deltawright?: DeltawrightApi };

/**
 * R2 flagship — a spatial + semantic "marked page map".
 *
 * `pageMap` reads a bounded set of SALIENT nodes (interactive + landmark/heading) in one in-page
 * pass and fuses the fields no existing structured page model carries — deterministic occlusion
 * (`coveredBy` / apparent z-layer), actionability, and (with a supplied delta) recency — onto each
 * node's exact geometry. It LEADS with those; role/name are borrowed annotations. It is the picture
 * an author or agent reads like a screenshot: what's where, what covers what, what you can act on,
 * and what just changed — deterministic, offline, token-cheap, and strongest exactly where the a11y
 * tree degrades (legacy / poor-a11y apps) and `boundingBox` can't tell you what's on top.
 *
 * Honesty (DW-02/03): by default the `actionable` verdict is GEOMETRY-DERIVED (a pointer-model read,
 * labeled as such). Pass `reconcile: true` to additionally run Playwright's AUTHORITATIVE actionability
 * probe on interactive nodes — Playwright then wins any disagreement, and the disagreement is surfaced
 * (`geomDisagreesWithPlaywright`), never hidden. Occlusion is a center-point hit-test — it names only
 * what was actually hit-tested, never more.
 */
export interface PageMapNode extends RawPageMapNode {
  /** Geometry-derived actionability verdict — ALWAYS present. A pointer-model read, NOT authoritative
   *  unless `reconciled` is true. */
  geomActionable: Verdict;
  /** Geometry-derived reason for a NOT-actionable geometry verdict, e.g. "covered-by div.dw-glass". */
  actionabilityReason: string | null;
  /** Whether Playwright's authoritative probe ran on this node (opt-in `reconcile`). */
  reconciled: boolean;
  /** The verdict to trust: Playwright-authoritative when `reconciled`, else === `geomActionable`. */
  actionable: Verdict;
  /** When reconciled: did the geometry read and Playwright disagree? (Always false when not reconciled.) */
  geomDisagreesWithPlaywright: boolean;
  /** Fused change-recency from a supplied delta (null when none supplied / node pre-existed). */
  recency: 'added' | 'removed' | 'changed' | null;
}

export interface PageMap {
  url: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  nodes: PageMapNode[];
  layers: PageMapLayer[];
  stats: {
    scanned: number;
    interactiveCount: number;
    occludedCount: number;
    offscreenCount: number;
    capped: boolean;
  };
  /** True when ANY node was reconciled with Playwright. Verdicts are geometry-derived unless true. */
  reconciled: boolean;
  /** Honesty flags — present only when set. */
  partial?: { injectionBlocked?: boolean };
}

export interface PageMapOptions {
  /** Cap on salient nodes read (interactive prioritized). Default 150. */
  maxNodes?: number;
  /** Include landmark + heading roles, not just interactive nodes. Default true. */
  includeLandmarks?: boolean;
  /** NxN zone grid resolution (3 gives named zones like "top-right"). Default 3. */
  zoneGrid?: number;
  /**
   * Reconcile each INTERACTIVE node's actionability against Playwright's authoritative probe (opt-in).
   * This is O(interactive nodes) trial-actions — the not-actionable ones each pay `trialTimeoutMs` —
   * so it is off by default; the default map is fast, offline, and geometry-derived. When on,
   * Playwright's verdict wins and any geometry disagreement is surfaced, never hidden (DW-02).
   */
  reconcile?: boolean;
  /** Max concurrent reconciliation probes (default 12). */
  reconcileConcurrency?: number;
  /** Per-node trial timeout for reconciliation (default 1200ms). */
  trialTimeoutMs?: number;
  /**
   * Fuse change-recency from a prior `actAndObserve` delta: any scanned node still carrying that
   * delta's `data-dw-ref` is annotated added/removed/changed. Compose `pageMap` right after an action
   * to get "the picture, with what just changed marked."
   */
  delta?: Delta;
}

export interface RenderPageMapOptions {
  /** Show precise rects (`@zone (x,y wxh)`). When false, only the coarse zone is shown. Default true. */
  precise?: boolean;
}

const DEFAULT_MAX_NODES = 150;
const DEFAULT_ZONE_GRID = 3;
const DEFAULT_RECONCILE_CONCURRENCY = 12;
const DEFAULT_TRIAL_TIMEOUT_MS = 1200;

/** Map with bounded concurrency, preserving input order (mirrors actAndObserve's helper). */
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
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}

/** Map a delta node's change kind to a page-map recency label. */
function recencyForKind(kind: string): PageMapNode['recency'] {
  if (kind === 'added') return 'added';
  if (kind === 'removed') return 'removed';
  return 'changed'; // attrChanged | textChanged
}

/**
 * Build the spatial + semantic page map. See {@link PageMapNode} for the honesty contract.
 */
export async function pageMap(page: Page, opts: PageMapOptions = {}): Promise<PageMap> {
  const scanOpts: ScanOptions = {
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
    includeLandmarks: opts.includeLandmarks ?? true,
    zoneGrid: opts.zoneGrid ?? DEFAULT_ZONE_GRID,
  };

  // Degrade honestly if the observer can't be injected (strict CSP): return an empty map flagged
  // injectionBlocked rather than throwing — the caller sees the honest reason, not a silent no-op.
  try {
    await ensureInjected(page);
  } catch (err) {
    if (!(err instanceof InjectionBlockedError)) throw err;
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    return {
      url: page.url(),
      viewport: { width: vp.width, height: vp.height, scrollX: 0, scrollY: 0 },
      nodes: [],
      layers: [],
      stats: {
        scanned: 0,
        interactiveCount: 0,
        occludedCount: 0,
        offscreenCount: 0,
        capped: false,
      },
      reconciled: false,
      partial: { injectionBlocked: true },
    };
  }

  const raw = await page.evaluate<RawPageMap, ScanOptions>(
    (o) => (window as unknown as DwWindow).__deltawright!.scan(o),
    scanOpts,
  );

  // Recency lookup: match a scanned node's carried delta-ref to the supplied delta's node kind.
  const kindByRef = new Map<string, string>();
  if (opts.delta) for (const n of opts.delta.nodes) kindByRef.set(n.ref, n.kind);

  const reconcileOn = opts.reconcile === true;
  const timeout = opts.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;

  const nodes: PageMapNode[] = await mapWithConcurrency(
    raw.nodes,
    reconcileOn
      ? (opts.reconcileConcurrency ?? DEFAULT_RECONCILE_CONCURRENCY)
      : raw.nodes.length || 1,
    async (rn): Promise<PageMapNode> => {
      const geomActionable = verdictFromGeometry(rn.geometry);
      const geomReason = reasonFromGeometry(rn.geometry);
      const recency =
        rn.deltaRef && kindByRef.has(rn.deltaRef)
          ? recencyForKind(kindByRef.get(rn.deltaRef)!)
          : null;

      // Default: verdict is the geometry read (fast, offline, labeled as geometry-derived).
      if (!reconcileOn || !rn.interactive) {
        return {
          ...rn,
          geomActionable,
          actionabilityReason: geomReason,
          reconciled: false,
          actionable: geomActionable,
          geomDisagreesWithPlaywright: false,
          recency,
        };
      }

      // Opt-in: Playwright's AUTHORITATIVE probe wins; surface any disagreement (never hide it).
      const locator = page.locator(`[data-dw-map-ref="${rn.ref}"]`);
      const action = primaryActionForRole(rn.role);
      const pw = await probeActionability(locator, action, timeout, geomReason);
      const rec = reconcile(pw, action, geomActionable, geomReason);
      return {
        ...rn,
        geomActionable,
        actionabilityReason: rec.reason ?? geomReason,
        reconciled: true,
        actionable: rec.verdict,
        geomDisagreesWithPlaywright: !rec.agreed,
        recency,
      };
    },
  );

  return {
    url: raw.url,
    viewport: raw.viewport,
    nodes,
    layers: raw.layers,
    stats: raw.stats,
    reconciled: reconcileOn && nodes.some((n) => n.reconciled),
    ...(raw.partial ? { partial: raw.partial } : {}),
  };
}

// --- Serializer ----------------------------------------------------------

function labelOf(n: PageMapNode): string {
  const base = n.role ?? (n.interactive ? 'control' : 'node');
  return n.name ? `${base} "${n.name}"` : base;
}

function posTag(n: PageMapNode, precise: boolean): string {
  const g = n.geometry;
  if (g.offscreen) return 'offscreen — scroll to reach';
  if (!precise) return `@${n.zone}`;
  return `@${n.zone} (${g.rect.x},${g.rect.y} ${g.rect.width}x${g.rect.height})`;
}

// Geometry-only vocabulary — deliberately DISTINCT from Playwright's authoritative verdict words, so
// a single excerpted line is self-honest and can never be mistaken for Playwright's judgment (DW-02).
// "reachable"/"covered-by …" (a pointer-model read) vs the reconciled "ACTIONABLE"/"NOT-actionable".
function geomWord(v: Verdict): string {
  return v === 'ACTIONABLE' ? 'reachable' : 'not-reachable';
}

// The state column. INTERACTIVE nodes get an actionability state; NON-interactive nodes (headings,
// landmarks, dialog containers) get occlusion state only — calling a heading "ACTIONABLE" would be
// misleading. RECONCILED interactive nodes use Playwright's authoritative words; UNRECONCILED ones use
// the softer geometry vocabulary. Off-screen is already carried by posTag.
function stateTag(n: PageMapNode): string {
  if (n.geometry.offscreen) return ''; // posTag already says "offscreen — scroll to reach"
  if (n.interactive) {
    if (n.reconciled) {
      if (n.actionable === 'n/a') return '';
      if (n.actionable === 'ACTIONABLE') return 'ACTIONABLE';
      return `NOT-actionable (${n.actionabilityReason ?? 'unknown'})`;
    }
    // Geometry-derived: never borrow Playwright's ACTIONABLE/NOT-actionable words.
    if (n.geomActionable === 'n/a') return '';
    if (n.geomActionable === 'ACTIONABLE') return 'reachable';
    return n.actionabilityReason ?? 'not-reachable'; // e.g. "covered-by div.dw-glass"
  }
  if (n.geometry.coveredBy) return `covered-by ${n.geometry.coveredBy}`;
  return '';
}

function nodeLine(n: PageMapNode, precise: boolean): string {
  const parts: string[] = [`L${n.layer}`, labelOf(n), `[${n.ref}]`, posTag(n, precise)];
  const s = stateTag(n);
  if (s) parts.push(s);
  // Surface a geometry<->Playwright disagreement (only meaningful when reconciled). Playwright's
  // verdict already won; this shows what geometry alone thought — the signal DW exists to expose.
  // Rendered in the geometry vocabulary so it can't read as a competing authoritative verdict.
  if (n.geomDisagreesWithPlaywright && n.geomActionable !== 'n/a') {
    parts.push(`[geom:${geomWord(n.geomActionable)}]`);
  }
  if (n.recency) parts.push(`*${n.recency}*`);
  return parts.join(' ');
}

/**
 * Render a `PageMap` to compact, LLM-friendly text. LEADS with layer + occlusion + actionability +
 * recency (the fields nobody else exposes); role/name annotate. The header declares whether verdicts
 * are geometry-derived or Playwright-authoritative — so a reader never mistakes a pointer-model read
 * for Playwright's judgment (DW-02).
 */
export function renderPageMap(map: PageMap, opts: RenderPageMapOptions = {}): string {
  const precise = opts.precise !== false;
  const { viewport: vp } = map;
  const verdictSource = map.reconciled ? 'Playwright-authoritative' : 'geometry-derived';
  const lines: string[] = [
    `page-map @ ${vp.width}x${vp.height} (scroll ${vp.scrollX},${vp.scrollY}) — verdicts: ${verdictSource}`,
  ];

  if (map.partial?.injectionBlocked) {
    lines.push('  (observer injection blocked — nothing could be scanned; likely a strict CSP)');
    return lines.join('\n');
  }

  if (map.layers.length > 1) {
    lines.push(
      'layers: ' +
        map.layers
          .map(
            (l) =>
              `${l.layer} ${l.layer === 0 ? 'base' : `overlay${l.label ? ` "${l.label}"` : ''}`} (${l.count})`,
          )
          .join(' | '),
    );
  }

  for (const n of map.nodes) lines.push(' ' + nodeLine(n, precise));

  if (map.nodes.length === 0) lines.push('  (no salient nodes found)');

  const s = map.stats;
  const footerParts = [
    `scanned ${s.scanned}`,
    `interactive ${s.interactiveCount}`,
    `occluded ${s.occludedCount}`,
    `offscreen ${s.offscreenCount}`,
  ];
  if (s.capped) footerParts.push('capped (raise maxNodes)');
  lines.push(`(${footerParts.join(', ')})`);
  return lines.join('\n');
}
