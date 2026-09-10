import type { Page, Frame } from '@playwright/test';
import {
  verifySuggestions,
  locatorFor,
  type VerifiedSelectorSuggestion,
  type VerifiedSuggestResult,
  type VerifySuggestionsOptions,
} from './verify-suggest';
import type { AssertionSuggestion, SelectorTier } from '../host/suggest';
import { pageMap, type PageMap, type PageMapNode } from '../host/page-map';
import {
  DEFAULT_ANCHOR_COUNT,
  RELATIONAL_BROKEN_MAX,
  RELATIONAL_PRESERVED_MIN,
  compareFingerprint,
  fingerprintFor,
  hasMeasurableBox,
  indexSnapshot,
  sameBox,
  type RelationalFingerprint,
  type RelationalStatus,
} from './relational-fingerprint';
import type { Delta, DeltaNode, Rect } from '../host/types';

// R3 (Phase 3) — a DURABILITY recommender layered on `verifySuggestions`. verifySuggestions answers
// "does this candidate resolve UNIQUELY to the changed element on THIS page"; scoreSelectors adds
// "…and how likely is it to KEEP working" — a 0..100 durability ESTIMATE + brittleness flags + a
// delta-anchored geometry-relative fallback when nothing semantic verifies. It borrows Robula+'s
// generated-id/positional penalties and Similo's two-tier stability weighting as the scoring function.
//
// HONESTY (load-bearing, DW-03): durability is a SINGLE-PAGE ESTIMATE — a proxy for "how brittle does
// this selector look", NEVER a claim of stability across releases/renders. The only sound cross-render
// signal is a two-snapshot re-check, which is a deliberate follow-up (not fabricated here). Every
// caveat verifySuggestions carries is inherited. `bestDurable` is null (with a warning) rather than
// handing back a brittle selector as if it were durable. Playwright's uniqueness/identity verdict
// (from verifySuggestions) is authoritative and unchanged.

/** A band over the durability ESTIMATE (single page) — `durable` means "estimated low brittleness on
 *  THIS page", NOT a guarantee of stability across releases/re-renders. See `durability`. */
export type SelectorGrade = 'durable' | 'usable' | 'brittle' | 'broken';

export interface ScoredSelectorSuggestion extends VerifiedSelectorSuggestion {
  /** 0..100 durability ESTIMATE (single-page proxy — never "stable across releases"). */
  durability: number;
  /** Estimate band from `durability` (see {@link SelectorGrade}) — an estimate, not a guarantee. */
  grade: SelectorGrade;
  /** Brittleness/context flags: unstable-id · text-volatile · heuristic-role-unverified · tag-only ·
   *  ambiguous · wrong-element · no-match · geometry-relative · occluded · offscreen · not-actionable.
   *  {@link measureRetention} appends its own: retained · moved-after-rerender · lost-after-rerender ·
   *  ambiguous-after-rerender · position-unmeasured · unresolvable · relational-context-preserved ·
   *  relational-context-broken. */
  flags: string[];
  /** True when this candidate was SYNTHESIZED as a geometry-relative fallback (not from suggest()). */
  synthesized?: boolean;
  /** The RAW Playwright selector string behind `code` — present only on synthesized candidates (the
   *  semantic tiers rebuild their locator from the delta node). Used by {@link measureRetention} to
   *  re-resolve the same layout locator on a later snapshot. */
  rawSelector?: string;
}

export interface DurableSuggestResult {
  /** Re-ranked by (grade, durability, then verify/tier order). */
  selectors: ScoredSelectorSuggestion[];
  /** The highest-scoring candidate that is `verified` AND grade !== 'brittle', else null (+ a warning). */
  bestDurable: ScoredSelectorSuggestion | null;
  /** `toBeActionable()` assertions re-pointed onto each node's `bestDurable`; brittle/absent ones dropped. */
  assertions: AssertionSuggestion[];
  /** verifySuggestions' caveats + the durability-estimate caveats. */
  warnings: string[];
}

export interface ScoreSelectorsOptions extends VerifySuggestionsOptions {
  /** Synthesize a geometry-relative fallback for nodes where nothing semantic verifies. Default true. */
  geometryFallback?: boolean;
}

// --- brittleness detectors (Robula+ blacklist / Similo weighting, applied to the accessible NAME) ---

/** A clearly framework-GENERATED identifier (not a human-authored, stable string). Conservative on
 *  purpose — a human name with an incidental year ("Save 2024") must NOT trip it. */
function isGeneratedId(v: string): boolean {
  if (!v) return false;
  return (
    /gwt-uid-\d+/i.test(v) || // GWT
    /\bext-(comp|gen|element)-?\d+/i.test(v) || // ExtJS
    /_ng(content|host)?-?[a-z]?c?\d+/i.test(v) || // Angular _ngcontent-c14
    /^:r[0-9a-z]+:$/i.test(v) || // React useId ":r0:"
    /[-_][0-9a-f]{8,}\b/i.test(v) || // long hex hash suffix
    /\b[a-z]{2,}[-_]\d{4,}\b/i.test(v) // prefix-1234 (component-1012, item-10847, row-88231); 4+
    // digits keeps human names with a small numeric suffix (e.g. "plan-500", "step-100") off the list
  );
}

/** A volatile human name — digits/currency/date/very-long — where getByText/name is likely to drift. */
function isDynamicText(v: string): boolean {
  if (!v) return false;
  return (
    v.length > 40 ||
    /[$€£¥%]/.test(v) || // currency / percent
    /\b\d{1,2}[:/]\d{2}\b/.test(v) || // time / date
    /#\d+/.test(v) || // "#10847"
    /\b\d[\d.,]{2,}\b/.test(v) // a number ≥ 3 chars (1,234 · 12.50 · 100)
  );
}

const DURABLE_MIN = 70;
const USABLE_MIN = 40;

/** Score one verified candidate for durability. Pure — reads the candidate + its delta node. */
function scoreCandidate(
  cand: VerifiedSelectorSuggestion,
  node: DeltaNode | undefined,
  synthesized: boolean,
): { durability: number; grade: SelectorGrade; flags: string[] } {
  const flags: string[] = [];
  const name = node?.name ?? '';

  // (0) Tier base weight.
  let base: number;
  if (synthesized) {
    base = 15;
    flags.push('geometry-relative');
  } else if (cand.tier === 'role') {
    base = node?.name ? 100 : 75; // role+name is user-facing & refactor-durable; role-only is broad
  } else if (cand.tier === 'testid') {
    base = 90;
  } else if (cand.tier === 'text') {
    base = 70;
  } else {
    base = 35; // css: the bare tag (suggest emits no id/class) — structurally fragile
    flags.push('tag-only');
  }

  // (1) Uniqueness / identity — from verifySuggestions (Playwright-authoritative).
  switch (cand.status) {
    case 'verified':
      break;
    case 'unconfirmed':
      base *= 0.85;
      break;
    case 'ambiguous':
      base *= 0.3;
      flags.push('ambiguous');
      break;
    case 'unique-elsewhere':
      base *= 0.1;
      flags.push('wrong-element');
      break;
    case 'broken':
      return { durability: 0, grade: 'broken', flags: [...flags, 'no-match'] };
  }

  // (2) Name volatility — a role+name or text candidate whose NAME is generated/dynamic is brittle.
  if ((cand.tier === 'role' && node?.name) || cand.tier === 'text') {
    if (isGeneratedId(name)) {
      base *= 0.25;
      flags.push('unstable-id');
    } else if (cand.tier === 'text' && isDynamicText(name)) {
      base *= 0.5;
      flags.push('text-volatile');
    }
  }

  // (3) Heuristic-role discount — DW's role/name are not Playwright's ARIA algorithm, so an UNVERIFIED
  //     role candidate may resolve elsewhere.
  if (cand.tier === 'role' && cand.status !== 'verified') {
    base *= 0.7;
    flags.push('heuristic-role-unverified');
  }

  // (4) Geometry / actionability context (DW-native) — annotations, not score changes beyond the above.
  if (node?.geometry?.coveredBy) flags.push('occluded');
  if (node?.geometry?.offscreen) flags.push('offscreen');
  if (node && node.actionability.verdict === 'NOT-actionable') flags.push('not-actionable');

  const durability = Math.max(0, Math.min(100, Math.round(base)));
  const grade: SelectorGrade =
    durability >= DURABLE_MIN ? 'durable' : durability >= USABLE_MIN ? 'usable' : 'brittle';
  return { durability, grade, flags };
}

const GRADE_RANK: Record<SelectorGrade, number> = { durable: 0, usable: 1, brittle: 2, broken: 3 };

function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Escape a string for a double-quoted Playwright text-engine literal. */
function dq(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const DEFAULT_CONCURRENCY = 12;

/** Order-preserving bounded-concurrency map (mirrors verifySuggestions' fan-out). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * Score `verifySuggestions` candidates for durability, synthesize a delta-anchored geometry-relative
 * fallback when nothing semantic verifies, and honestly flag brittleness. Call RIGHT AFTER
 * `actAndObserve` (it needs the delta's live `data-dw-ref` markers, which the next action clears).
 * Durability is a single-page ESTIMATE — never a cross-release stability claim.
 */
export async function scoreSelectors(
  root: Page | Frame,
  delta: Delta,
  opts: ScoreSelectorsOptions = {},
): Promise<DurableSuggestResult> {
  const base: VerifiedSuggestResult = await verifySuggestions(root, delta, opts);
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));

  const scored: ScoredSelectorSuggestion[] = base.selectors.map((cand) => {
    const s = scoreCandidate(cand, byRef.get(cand.ref), false);
    return { ...cand, durability: s.durability, grade: s.grade, flags: s.flags };
  });

  // Geometry-relative fallback (opt-in, default on): for each node with NO verified candidate, anchor a
  // layout locator on the NEAREST node that DID verify uniquely and has a usable text name, then run
  // that synthesized locator back through the same verify path. Last-resort + honestly flagged.
  const warnings = [...base.warnings];
  if (opts.geometryFallback !== false) {
    const verifiedByRef = new Set(scored.filter((s) => s.verified).map((s) => s.ref));
    // Anchors: verified, named, on-screen, non-occluded nodes with geometry.
    const anchors = delta.nodes.filter(
      (n) =>
        verifiedByRef.has(n.ref) &&
        n.name &&
        n.geometry &&
        !n.geometry.offscreen &&
        !n.geometry.coveredBy,
    );
    // Targets: nodes with geometry and NO verified candidate (and not removed).
    const targets = delta.nodes.filter(
      (n) => n.kind !== 'removed' && n.geometry && !verifiedByRef.has(n.ref),
    );
    // Bounded-concurrent (honors the advertised `concurrency`) — each target is isolated: a detached
    // page/frame drops THAT target to a broken candidate, never aborting the whole scan.
    const synthesized = await mapWithConcurrency(
      targets,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      async (target): Promise<ScoredSelectorSuggestion | null> => {
        const tc = centerOf(target.geometry!.rect);
        let nearest: DeltaNode | null = null;
        let bestDist = Infinity;
        for (const a of anchors) {
          if (a.ref === target.ref) continue;
          const ac = centerOf(a.geometry!.rect);
          const d = (ac.x - tc.x) ** 2 + (ac.y - tc.y) ** 2;
          if (d < bestDist) {
            bestDist = d;
            nearest = a;
          }
        }
        if (!nearest || !nearest.name) return null;
        // Playwright layout engine: `<tag>:near(:text("anchor"))`. Re-verified below; if it does not
        // resolve uniquely to the target it is simply graded low (never presented as durable).
        const selector = `${target.tag}:near(:text(${dq(nearest.name)}))`;
        const code = `page.locator(${JSON.stringify(selector)})`;
        let matches = 0;
        let sameAsRef = 0;
        let refPresent = false;
        try {
          // ALL page round-trips guarded together (incl. the ref-presence probe), so a mid-scan
          // detach drops this one target rather than rejecting scoreSelectors.
          refPresent = (await root.locator(`[data-dw-ref="${target.ref}"]`).count()) > 0;
          const loc = root.locator(selector);
          matches = await loc.count();
          if (matches > 0 && refPresent) {
            sameAsRef = await loc.and(root.locator(`[data-dw-ref="${target.ref}"]`)).count();
          }
        } catch {
          // a detached page/frame or invalid layout selector — the init values (0/0/false) stand.
        }
        const unique = matches === 1;
        const verified = unique && refPresent && sameAsRef >= 1;
        const status = verified
          ? ('verified' as const)
          : matches > 1
            ? ('ambiguous' as const)
            : matches === 1
              ? refPresent
                ? ('unique-elsewhere' as const)
                : ('unconfirmed' as const)
              : ('broken' as const);
        const candidate: VerifiedSelectorSuggestion = {
          ref: target.ref,
          tier: 'css',
          code,
          matches,
          unique,
          verified,
          status,
        };
        const s = scoreCandidate(candidate, target, true);
        return {
          ...candidate,
          durability: s.durability,
          grade: s.grade,
          flags: s.flags,
          synthesized: true,
          rawSelector: selector,
        };
      },
    );
    for (const s of synthesized) if (s) scored.push(s);
  }

  // Re-rank by grade, then durability, then the verify/tier order that produced them (stable).
  const selectors = scored
    .map((v, i) => ({ v, i }))
    .sort(
      (a, b) =>
        GRADE_RANK[a.v.grade] - GRADE_RANK[b.v.grade] ||
        b.v.durability - a.v.durability ||
        a.i - b.i,
    )
    .map(({ v }) => v);

  // bestDurable = the top candidate that is verified AND not brittle. Never a brittle handoff.
  const bestDurable = selectors.find((s) => s.verified && s.grade !== 'brittle') ?? null;

  // Re-point assertions onto each node's bestDurable (verified + not brittle); drop the rest.
  const bestByRef = new Map<string, ScoredSelectorSuggestion>();
  for (const s of selectors)
    if (s.verified && s.grade !== 'brittle' && !bestByRef.has(s.ref)) bestByRef.set(s.ref, s);
  const assertions: AssertionSuggestion[] = [];
  let dropped = 0;
  for (const a of base.assertions) {
    // base.assertions were re-pointed onto verified selectors by verifySuggestions; keep only those
    // whose node also has a NON-brittle durable selector.
    const best = bestByRef.get(a.ref);
    if (best) assertions.push({ ref: a.ref, code: `await expect(${best.code}).toBeActionable();` });
    else dropped++;
  }

  warnings.push(
    'scoreSelectors: `durability` is a SINGLE-PAGE ESTIMATE (a brittleness proxy), NOT a guarantee of stability across releases or re-renders — the only sound cross-render signal is a two-snapshot re-check.',
  );
  if (base.selectors.length > 0 && !bestDurable) {
    warnings.push(
      'scoreSelectors: no verified candidate graded above `brittle` on this page — hand-author a durable handle (staying unsure) rather than shipping a brittle one.',
    );
  }
  if (dropped > 0) {
    warnings.push(
      `scoreSelectors: dropped ${dropped} suggested assertion(s) whose node has no non-brittle durable selector.`,
    );
  }

  return { selectors, bestDurable, assertions, warnings };
}

// --- measureRetention (R3 step 4) — the two-snapshot MEASURED cross-render signal --------------------
//
// scoreSelectors' `durability` is a single-page ESTIMATE — a brittleness proxy, explicitly NOT a claim
// of stability across renders (see the warning it emits). The only sound cross-render signal is to
// actually RE-CHECK a selector after the page changes: `measureRetention` re-resolves each snapshot-A
// selector on a SECOND snapshot (after a re-render you supply, or the current DOM) and reports whether
// it still resolves uniquely to a control in the same place.
//
// HONESTY (DW-03, load-bearing): the `data-dw-ref` identity marker does NOT survive a re-render (it is
// a transient delta stamp on the ORIGINAL node), so DW cannot prove OBJECT identity across snapshots.
// Identity is inferred from the selector's own semantics (a unique match — Playwright enforces role+
// name / text / the layout anchor) PLUS geometry proximity to the recorded rect. A unique match that
// jumped beyond `positionTolerance` is surfaced as `moved` (review it — possibly a different instance),
// never silently counted as retained. The measurement is a real signal for the OBSERVED transition —
// still NOT a guarantee of stability across future releases; the result says so.
//
// v1.2 adds a SECOND, differently-fragile position witness alongside `centerShift`: a RELATIONAL
// fingerprint (`relationalAgreement`). `centerShift` is one ABSOLUTE point, which its own doc comment
// already admits a page scroll inflates; `relationalAgreement` asks instead how much of the candidate's
// position RELATIVE TO ITS NEAREST SALIENT NEIGHBOURS survived. The two are reported side by side and
// neither replaces the other — a scroll or a responsive breakpoint moves the point while preserving the
// relations, and a selector re-resolving onto a look-alike elsewhere can do the exact reverse. See
// `relational-fingerprint.ts` for the algorithm, its citations and its own caveats.
//
// HONESTY (DW-02/03): the relational signal is EVIDENCE, never a verdict. It never changes `retention`,
// never overrides Playwright's uniqueness/identity result, and folds into `measuredDurability` ADDITIVELY
// and only in the `moved` band — where it can partially undo the `moved` penalty but never lift a
// candidate above the snapshot-A estimate it started from.

export interface MeasureRetentionOptions {
  /** A re-render to run BETWEEN the two snapshots (a data refresh, an SPA in-place re-render, a reload).
   *  Omit if you have already re-rendered — the CURRENT live DOM is taken as snapshot B. */
  reRender?: () => Promise<void>;
  /** Max center-shift (CSS px) for a uniquely re-resolved element to still count as the SAME control —
   *  normal reflow stays under it; a larger jump is surfaced as `moved` (possibly a different instance)
   *  rather than claimed retained. Default 250. */
  positionTolerance?: number;
  /** Bound on concurrent re-resolution round-trips (default 12). */
  concurrency?: number;
  /**
   * Also measure the RELATIONAL fingerprint (`relationalAgreement`) — position relative to the
   * candidate's nearest salient neighbours, the invariant `centerShift` is not. Default true.
   *
   * Cost when on: two extra `pageMap()` reads (one per snapshot) plus one attribute read per
   * re-resolved candidate. `pageMap()` is a single offline in-page pass — it is NOT reconciled and
   * runs no Playwright trial actions — but it does stamp `data-dw-map-ref` on the salient nodes it
   * scans (clearing its own prior stamps each time, and never touching the delta's `data-dw-ref`).
   * Set false for a byte-identical pre-v1.2 measurement on a page that must not be written to.
   */
  relational?: boolean;
  /** How many nearest salient neighbours anchor the fingerprint (default 6). See
   *  {@link DEFAULT_ANCHOR_COUNT} for why that number is uncalibrated. */
  relationalAnchors?: number;
}

/** Retention MEASURED across the observed re-render (snapshot A → B). */
export type RetentionVerdict =
  | 'retained' // resolves uniquely AND to a control within `positionTolerance` of snapshot A
  | 'moved' // resolves uniquely but the element jumped beyond tolerance (possibly a different instance)
  | 'ambiguous' // now resolves to >1 element — lost uniqueness across the re-render
  | 'lost' // now resolves to 0 elements
  | 'inconclusive'; // resolved uniquely but position was unmeasurable (no box — hidden/detached), or the
// selector could not be rebuilt — a unique match we will NOT dress up as a confirmed in-place retain

export interface SelectorRetention {
  ref: string;
  tier: SelectorTier;
  code: string;
  synthesized?: boolean;
  /** Retention verdict measured on snapshot B. */
  retention: RetentionVerdict;
  /** `locator.count()` on snapshot B. */
  matchesAfter: number;
  /** Center-shift (CSS px) from snapshot A's recorded rect — null unless it re-resolved uniquely with a
   *  measurable box. NOTE: snapshot-A rects are the observer's VIEWPORT coordinates while `boundingBox()`
   *  is main-frame-viewport coordinates, so this assumes a stable viewport — a page SCROLL between
   *  snapshots, or a `root` that is an offset child Frame, inflates the shift (mislabeling a retained
   *  element `moved`, never the reverse). Widen `positionTolerance` or keep the viewport stable. */
  centerShift: number | null;
  /**
   * Fraction (0..1) of the candidate's snapshot-A anchor relations that still hold on snapshot B —
   * the RELATIONAL counterpart to `centerShift`, null unless {@link relationalStatus} is `measured`.
   *
   * Read the two TOGETHER; neither replaces the other. A large `centerShift` with an agreement near 1
   * says the candidate travelled but its neighbourhood travelled with it (a page scroll, a responsive
   * breakpoint, a row inserted above it) — the exact case `centerShift` alone over-reports as `moved`.
   * A small `centerShift` with a low agreement says the opposite and is the more dangerous one: the
   * selector may have re-resolved onto a different element that merely sits in the same place.
   *
   * NOTE, in the same spirit as `centerShift`'s own caveat: anchor identity across the two snapshots is
   * INFERRED from DW's lightweight (role, name) derivation and used only where that key is unique on
   * both snapshots, so anchors are dropped rather than mismatched; only `pageMap()`'s salient set
   * (interactive + landmark/heading, `maxNodes`-capped) is visible; and the signal is invariant to
   * whole-block translation, NOT to reflow inside the candidate's own neighbourhood. It is evidence,
   * never a verdict — it never changes `retention`.
   */
  relationalAgreement: number | null;
  /** How many snapshot-A anchor relations `relationalAgreement` was computed over (0 when none). The
   *  denominator matters: an agreement of 1 over a single anchor is far weaker evidence than 1 over 6. */
  relationalAnchorsCompared: number;
  /** Why `relationalAgreement` is (or is not) available — a closed set, never prose. */
  relationalStatus: RelationalStatus;
  /** The single-page ESTIMATE from scoreSelectors (snapshot A). */
  estimatedDurability: number;
  /** Durability re-scored with the measured retention folded in. */
  measuredDurability: number;
  /** Estimate band recomputed from `measuredDurability`. */
  grade: SelectorGrade;
  flags: string[];
}

export interface RetentionResult {
  /** Per re-checked selector (the snapshot-A `verified` ones), re-ranked by measured grade/durability. */
  selectors: SelectorRetention[];
  /** Fraction of re-checked selectors that RETAINED (0..1; 0 when none were re-checked). */
  retentionRate: number;
  /** The top measured selector that RETAINED and is non-brittle, else null. */
  bestRetained: SelectorRetention | null;
  /** The honest framing of what was (and was not) measured. */
  warnings: string[];
}

function gradeFor(durability: number): SelectorGrade {
  if (durability <= 0) return 'broken';
  return durability >= DURABLE_MIN ? 'durable' : durability >= USABLE_MIN ? 'usable' : 'brittle';
}

const DEFAULT_POSITION_TOLERANCE = 250;

/**
 * Narrow a `Page | Frame` root to a `Page`, or null for a child Frame.
 *
 * `pageMap()` takes a `Page` and scans the MAIN document only, while a CHILD Frame's rects are in that
 * frame's own coordinate space — so anchoring a frame-hosted candidate against the top document's
 * salient nodes would compare two different coordinate systems and manufacture relations that were
 * never there. Rather than silently produce that, the relational pass reports `frame-root` and stands
 * down; `centerShift` (which carries its own frame caveat) still measures.
 *
 * A `Page` is discriminated on `context()`, which `Frame` does not have. A main frame passed as a
 * `Frame` is NOT a child frame — it shares the page's document and coordinate space exactly — so it is
 * resolved back to its `Page` and measured normally, rather than refused on a technicality about which
 * object type the caller happened to hand us.
 */
function asPage(root: Page | Frame): Page | null {
  if (typeof (root as Page).context === 'function') return root as Page;
  const frame = root as Frame;
  const page = frame.page();
  return page.mainFrame() === frame ? page : null;
}

/** Read one snapshot's salient map, degrading to null rather than failing the whole measurement. A
 *  relational read is ADDITIONAL evidence; it must never be able to break the retention check that
 *  worked before v1.2. */
async function readMapOrNull(page: Page): Promise<PageMap | null> {
  try {
    const map = await pageMap(page);
    return map.partial?.injectionBlocked ? null : map;
  } catch {
    return null; // a detached page, or an evaluate rejected mid-scan
  }
}

/**
 * Two-snapshot MEASURED cross-render check for the selectors {@link scoreSelectors} verified. Re-resolves
 * each snapshot-A `verified` selector on a SECOND snapshot — after the `reRender` you pass, or the
 * current DOM — and reports whether it still resolves UNIQUELY to a control in ~the same place
 * (`retained`), resolves but relocated (`moved`), lost uniqueness (`ambiguous`), or vanished (`lost`).
 *
 * Pass the SAME `delta` and `scored` result you got from `scoreSelectors` (they carry snapshot-A's
 * recorded rects + which selectors verified). Only the selectors that WORKED on snapshot A are
 * re-checked — retention is about whether a working selector keeps working.
 *
 * HONESTY: this is a measured signal for the ONE transition observed, not a cross-release guarantee, and
 * identity across the re-render is inferred (semantics + geometry), not proven — see the module header.
 */
export async function measureRetention(
  root: Page | Frame,
  delta: Delta,
  scored: DurableSuggestResult,
  opts: MeasureRetentionOptions = {},
): Promise<RetentionResult> {
  const tol = opts.positionTolerance ?? DEFAULT_POSITION_TOLERANCE;
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));
  // Only re-check what WORKED on snapshot A (a broken/ambiguous candidate has nothing to "retain").
  // Snapshot this list BEFORE the re-render — `scored`/`delta` are in-memory, unaffected by the DOM.
  const targets = scored.selectors.filter((s) => s.verified);

  // --- Relational fingerprint (v1.2), snapshot A -----------------------------------------------------
  // Read the salient map BEFORE the re-render, while the delta's `data-dw-ref` markers still tie each
  // candidate to a scanned node. Both this map's rects and the delta's come from the SAME injected
  // getBoundingClientRect() read, so the fingerprint is built in one coordinate space; it deliberately
  // uses the map's rect rather than the delta's for the candidate, so candidate and anchors are read at
  // the same instant.
  const relationalPage = opts.relational === false ? null : asPage(root);
  const anchorCount = opts.relationalAnchors ?? DEFAULT_ANCHOR_COUNT;
  const disabledStatus: RelationalStatus =
    opts.relational === false ? 'disabled' : asPage(root) ? 'measured' : 'frame-root';
  const mapA = relationalPage ? await readMapOrNull(relationalPage) : null;
  const snapshotA = mapA ? indexSnapshot(mapA.nodes) : null;
  // A `null` entry means "found in snapshot A's salient set, but with no usable box" — kept distinct
  // from an absent entry ("not in the salient set at all") so the two report different, honest statuses.
  const fingerprints = new Map<string, RelationalFingerprint | null>();
  if (mapA && snapshotA) {
    const byDeltaRef = new Map<string, PageMapNode>();
    for (const n of mapA.nodes) if (n.deltaRef) byDeltaRef.set(n.deltaRef, n);
    for (const c of targets) {
      if (fingerprints.has(c.ref)) continue;
      const node = byDeltaRef.get(c.ref);
      if (!node) continue;
      fingerprints.set(
        c.ref,
        hasMeasurableBox(node) ? fingerprintFor(node, snapshotA, anchorCount) : null,
      );
    }
  }

  // Snapshot B: run the caller's re-render (if any). A throw here is a real failure — propagate it.
  if (opts.reRender) await opts.reRender();

  // …then re-read the salient map, so every candidate below is scored against the SAME snapshot-B
  // neighbourhood (and against fresh `data-dw-map-ref` stamps, which is how each candidate finds itself
  // in it).
  const mapB = relationalPage && mapA ? await readMapOrNull(relationalPage) : null;
  const snapshotB = mapB ? indexSnapshot(mapB.nodes) : null;
  const mapBByRef = new Map<string, PageMapNode>(mapB ? mapB.nodes.map((n) => [n.ref, n]) : []);
  // A read that was asked for and did not land is reported as blocked, not silently as `disabled`.
  const readStatus: RelationalStatus =
    disabledStatus !== 'measured' ? disabledStatus : mapA && mapB ? 'measured' : 'page-map-blocked';

  const measured = await mapWithConcurrency(
    targets,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (c): Promise<SelectorRetention> => {
      const node = byRef.get(c.ref);
      // Rebuild the SAME locator on snapshot B: synthesized layout locators carry their raw selector;
      // the semantic tiers rebuild from the delta node (mirrors verifySuggestions).
      const loc =
        c.synthesized && c.rawSelector
          ? root.locator(c.rawSelector)
          : node
            ? locatorFor(root, c.tier, node)
            : null;

      const flags = [...c.flags];
      let matchesAfter = 0;
      let retention: RetentionVerdict;
      let centerShift: number | null = null;
      let mapRefAfter: string | null = null;
      let boxAfter: { x: number; y: number; width: number; height: number } | null = null;
      if (!loc) {
        // The candidate could not be rebuilt (a synthesized fallback with no rawSelector, or a tier with
        // no locator). Unique-match unknown — report honest `inconclusive`, never a silent `lost`.
        retention = 'inconclusive';
        flags.push('unresolvable');
      } else {
        let box: { x: number; y: number; width: number; height: number } | null = null;
        try {
          matchesAfter = await loc.count();
          if (matchesAfter === 1) box = await loc.boundingBox();
        } catch {
          matchesAfter = 0; // detached page/frame or an invalid rebuilt selector
        }
        boxAfter = box;
        // How the re-resolved element finds ITSELF in snapshot B's salient map: `pageMap()` stamped
        // `data-dw-map-ref` moments ago. Read in its OWN try — it is optional evidence, and a detach
        // racing this extra round-trip must not be able to turn a measured `retained` into `lost`.
        if (snapshotB && matchesAfter === 1) {
          try {
            mapRefAfter = await loc.getAttribute('data-dw-map-ref');
          } catch {
            mapRefAfter = null;
          }
        }
        if (matchesAfter === 0) {
          retention = 'lost';
          flags.push('lost-after-rerender');
        } else if (matchesAfter > 1) {
          retention = 'ambiguous';
          if (!flags.includes('ambiguous')) flags.push('ambiguous');
          flags.push('ambiguous-after-rerender');
        } else {
          const recorded = node?.geometry?.rect;
          if (recorded && box) {
            const dx = box.x + box.width / 2 - (recorded.x + recorded.width / 2);
            const dy = box.y + box.height / 2 - (recorded.y + recorded.height / 2);
            centerShift = Math.round(Math.hypot(dx, dy));
            retention = centerShift <= tol ? 'retained' : 'moved';
            flags.push(retention === 'retained' ? 'retained' : 'moved-after-rerender');
          } else {
            // Resolves uniquely but has no measurable box (hidden / zero-layout / detached between the
            // count and the box read) — we CANNOT confirm it is the same control in the same place, so we
            // refuse to count it as a clean retain. It is excluded from retentionRate and bestRetained.
            retention = 'inconclusive';
            flags.push('position-unmeasured');
          }
        }
      }

      // Snapshot B: re-score the snapshot-A fingerprint against the candidate's CURRENT neighbourhood.
      const fingerprint = fingerprints.get(c.ref);
      const afterNode = mapRefAfter ? mapBByRef.get(mapRefAfter) : undefined;
      let relationalAgreement: number | null = null;
      let relationalAnchorsCompared = 0;
      let relationalStatus: RelationalStatus = readStatus;
      if (relationalStatus === 'measured') {
        if (matchesAfter !== 1) {
          // Zero or many matches — there is no single element on snapshot B whose neighbourhood could
          // even be asked about. `retention` already says so; this must not read as a low score.
          relationalStatus = 'not-re-resolved';
        } else if (!fingerprints.has(c.ref) || !afterNode || !snapshotB) {
          relationalStatus = 'candidate-unmapped';
        } else if (!boxAfter || !fingerprint || !hasMeasurableBox(afterNode)) {
          // No usable box on one of the two snapshots — Playwright measured none at all, or the rect
          // did not clear the 5x5px floor (hidden, zero-layout, or genuinely tiny). Refusing to score
          // here is the same call `centerShift` makes when `boundingBox()` returns null: an
          // unmeasurable position must not masquerade as a measured 0.
          relationalStatus = 'candidate-unmeasurable';
        } else if (!sameBox(afterNode.geometry.rect, boxAfter)) {
          // The `data-dw-map-ref` stamp resolved to a node whose box is NOT the box Playwright just
          // measured for this same locator — so the stamp is stale and names a DIFFERENT element (see
          // {@link sameBox}). Decline to score rather than score the wrong neighbourhood.
          relationalStatus = 'candidate-unmapped';
        } else {
          const cmp = compareFingerprint(fingerprint, afterNode, snapshotB);
          if (cmp.agreement === null) {
            // No anchor carried an identity key usable on both snapshots. Nothing was measured, so
            // nothing is reported — never a 0, which would read as "its context was destroyed".
            relationalStatus = 'no-anchors';
          } else {
            relationalAgreement = cmp.agreement;
            relationalAnchorsCompared = cmp.anchors;
            if (cmp.agreement >= RELATIONAL_PRESERVED_MIN) {
              flags.push('relational-context-preserved');
            } else if (cmp.agreement <= RELATIONAL_BROKEN_MAX) {
              flags.push('relational-context-broken');
            }
          }
        }
      }

      const est = c.durability;
      let measuredDurability: number;
      switch (retention) {
        case 'retained':
          measuredDurability = Math.min(100, est + 10); // a modest confirmation nudge, never inflated
          break;
        case 'moved': {
          // ADDITIVE ONLY, and only here. `moved` means "unique, but the absolute centre jumped" — the
          // one verdict a relational reading is genuinely able to inform, because a preserved
          // neighbourhood is real evidence the jump was the page moving, not a different element. The
          // bonus can therefore recover part of the 30% `moved` penalty and NOTHING more: it is capped
          // at the snapshot-A estimate, so relational agreement can never manufacture durability the
          // single-page estimate never granted, and it never touches `retention` itself (DW-02/03).
          const penalised = Math.round(est * 0.7);
          const bonus =
            relationalAgreement === null ? 0 : Math.round(est * 0.3 * relationalAgreement);
          measuredDurability = Math.min(est, penalised + bonus);
          break;
        }
        case 'ambiguous':
          measuredDurability = Math.round(est * 0.3);
          break;
        case 'lost':
          measuredDurability = 0;
          break;
        case 'inconclusive':
          measuredDurability = est; // nothing measured → leave the snapshot-A estimate untouched
          break;
      }

      return {
        ref: c.ref,
        tier: c.tier,
        code: c.code,
        synthesized: c.synthesized,
        retention,
        matchesAfter,
        centerShift,
        relationalAgreement,
        relationalAnchorsCompared,
        relationalStatus,
        estimatedDurability: est,
        measuredDurability,
        grade: gradeFor(measuredDurability),
        flags,
      };
    },
  );

  const selectors = measured
    .map((v, i) => ({ v, i }))
    .sort(
      (a, b) =>
        GRADE_RANK[a.v.grade] - GRADE_RANK[b.v.grade] ||
        b.v.measuredDurability - a.v.measuredDurability ||
        a.i - b.i,
    )
    .map(({ v }) => v);

  // retentionRate is over CONCLUSIVE selectors only — an `inconclusive` (unique but unmeasurable) match
  // is neither a retain nor a failure, so counting it either way would misstate the rate.
  const conclusive = selectors.filter((s) => s.retention !== 'inconclusive');
  const retainedCount = conclusive.filter((s) => s.retention === 'retained').length;
  const retentionRate = conclusive.length > 0 ? retainedCount / conclusive.length : 0;
  const inconclusiveCount = selectors.length - conclusive.length;
  const bestRetained =
    selectors.find((s) => s.retention === 'retained' && s.grade !== 'brittle') ?? null;

  const warnings: string[] = [
    'measureRetention: `retention`/`measuredDurability` are MEASURED across the ONE re-render observed (snapshot A→B) — a real cross-render signal for THIS transition, NOT a guarantee of stability across future releases.',
    'measureRetention: the `data-dw-ref` identity marker does not survive a re-render, so object identity is INFERRED from a unique semantic/layout match + geometry proximity (not proven) — a unique match that moved beyond `positionTolerance` is reported `moved` for review, never silently counted as retained.',
    "measureRetention: `centerShift` compares the observer's snapshot-A viewport rect against Playwright's boundingBox() (main-frame-viewport coordinates), so it assumes a stable viewport — a page scroll between snapshots, or a `root` that is an offset child Frame, can inflate the shift and mislabel a retained element `moved` (never the reverse). Widen `positionTolerance` or keep the viewport stable.",
  ];
  if (readStatus === 'measured') {
    warnings.push(
      "measureRetention: `relationalAgreement` is a SECOND position witness reported ALONGSIDE `centerShift`, not a replacement — it measures how much of the candidate's position RELATIVE to its nearest salient neighbours survived, so a scroll or a responsive breakpoint that moves the whole block preserves it while `centerShift` inflates. It is EVIDENCE, never a verdict: it never changes `retention`, and folds into `measuredDurability` only additively, only in the `moved` band, and never above the snapshot-A estimate.",
    );
    warnings.push(
      "measureRetention: relational anchor identity is INFERRED from DW's lightweight (role, name) derivation and used ONLY where that key is unique on both snapshots — anchors are dropped, never mismatched, so a page of look-alike rows yields few anchors (see `relationalAnchorsCompared`) rather than a confident score. Only `pageMap()`'s salient set is visible (interactive + landmark/heading, `maxNodes`-capped), and the signal is invariant to whole-block translation, NOT to reflow within the candidate's own neighbourhood.",
    );
    if (mapA?.stats.capped || mapB?.stats.capped) {
      warnings.push(
        "measureRetention: the salient page map hit its default `maxNodes` cap on at least one snapshot, so an anchor may be absent for capping reasons rather than because the page changed — read `relationalAgreement` as a FLOOR on those candidates. The cap is `pageMap()`'s own default and is not currently exposed through `MeasureRetentionOptions`.",
      );
    }
    // The whole point of the signal is the candidate whose position looks fine and whose CONTEXT does
    // not — a selector that may have re-resolved onto a look-alike standing in the right place. That
    // never moves `retention` (DW-02/03), so if it were not said out loud here the caller reading
    // `retentionRate`/`bestRetained` would never see it at all.
    const brokenContext = measured.filter((m) => m.flags.includes('relational-context-broken'));
    if (brokenContext.length > 0) {
      warnings.push(
        `measureRetention: ${brokenContext.length} selector(s) re-resolved with a BROKEN relational context (\`relationalAgreement\` <= ${RELATIONAL_BROKEN_MAX}) — their neighbourhood is not the one they were fingerprinted in.`,
      );
    }
    // Deliberately a WIDER net than the `relational-context-broken` flag. A `retained` verdict rests
    // entirely on position, and position is exactly what a look-alike standing in the right place
    // reproduces — so for those candidates ANY agreement below the preserved bar is worth naming, not
    // just one under the broken bar. Otherwise a false heal scoring in the 0.4–0.8 gap between the two
    // thresholds produces no flag and no warning at all, and `retentionRate`/`bestRetained` count it
    // silently.
    const suspectRetains = measured.filter(
      (m) =>
        m.retention === 'retained' &&
        m.relationalAgreement !== null &&
        m.relationalAgreement < RELATIONAL_PRESERVED_MIN,
    );
    if (suspectRetains.length > 0) {
      warnings.push(
        `measureRetention: ${suspectRetains.length} selector(s) measured \`retained\` on position while their relational context did NOT hold (\`relationalAgreement\` < ${RELATIONAL_PRESERVED_MIN}) — review these first. A selector re-resolving onto a DIFFERENT element that happens to sit in the same place is precisely what \`centerShift\` cannot see, and because the relational reading never overrides Playwright's verdict (DW-02/03), \`retentionRate\` and \`bestRetained\` still count them as retained.`,
      );
    }
  } else if (readStatus === 'frame-root') {
    warnings.push(
      'measureRetention: `root` is a child Frame, so the relational fingerprint stood down (`relationalStatus: "frame-root"`) — `pageMap()` scans the main document, whose coordinate space is not the frame\'s. Only `centerShift` measured position here, with the frame caveat it already carries.',
    );
  } else if (readStatus === 'page-map-blocked') {
    warnings.push(
      'measureRetention: the salient page map could not be read on at least one snapshot (observer injection blocked, e.g. a strict CSP, or the page detached), so no relational fingerprint was measured (`relationalStatus: "page-map-blocked"`) — `centerShift` stands alone.',
    );
  }
  if (inconclusiveCount > 0) {
    warnings.push(
      `measureRetention: ${inconclusiveCount} selector(s) resolved uniquely but could not be position-measured (hidden/detached/unrebuildable) → \`inconclusive\`, excluded from retentionRate and bestRetained rather than counted as retained.`,
    );
  }
  if (!opts.reRender) {
    warnings.push(
      'measureRetention: no `reRender` supplied — the current live DOM was taken as snapshot B; ensure the re-render happened before this call.',
    );
  }
  if (targets.length === 0) {
    warnings.push(
      'measureRetention: no snapshot-A `verified` selector to re-check — nothing that worked, so there is nothing to retain.',
    );
  }

  return { selectors, retentionRate, bestRetained, warnings };
}
