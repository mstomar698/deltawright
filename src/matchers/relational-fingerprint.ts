import type { PageMapNode } from '../host/page-map';
import type { Rect } from '../host/types';

// The RELATIONAL geometric fingerprint (v1.2) — the invariant `centerShift` is not.
//
// `measureRetention`'s existing position signal is ONE absolute point: the candidate's center, in the
// observer's viewport coordinates. Its own doc comment already names the gap — "a page SCROLL between
// snapshots, or an offset child Frame, inflates the shift" — and the research sweep behind this module
// (`docs/research/geometric-identification/`) found the same failure at scale: absolute position is not
// the right invariant, position RELATIVE TO NEARBY ANCHORS is. X-PERT's relational alignment graph
// reaches 76% precision where an absolute-position comparator on the identical 14-site corpus manages
// 18% (`deep/relational-layout-models.md` §5); Similo's own tuned weighting demotes raw location to a
// fast-decaying, low-weight signal for the same reason (`deep/similo-family.md` §6).
//
// So: describe a candidate by how it sits relative to its K nearest identifiable salient neighbours,
// and ask on snapshot B how many of those relations still hold. A page that merely SCROLLED, or a
// responsive breakpoint that translated a whole block, preserves every relation while `centerShift`
// explodes. A candidate that was genuinely re-parented — or a selector that re-resolved onto a
// different, look-alike element — does not.
//
// HONESTY (load-bearing, DW-03): this is EVIDENCE, never a verdict. It cannot prove object identity
// any more than `centerShift` can; it is a second, differently-fragile witness reported ALONGSIDE
// `centerShift`, and it never overrides Playwright's uniqueness/identity result (DW-02). Its own
// specific limits, stated the way `centerShift` states its own:
//   • Anchor identity across the two snapshots is INFERRED from (role, name) and only accepted when
//     that key is UNIQUE on BOTH snapshots — DW's role/name is a lightweight in-page derivation, not
//     Playwright's ARIA algorithm, so an anchor can be silently dropped (never silently mismatched).
//   • It is invariant to whole-block translation, not to arbitrary reflow WITHIN the candidate's own
//     neighbourhood. A card whose internals re-lay-out scores low, correctly and by design.
//   • It sees only `pageMap()`'s SALIENT set (interactive + landmark/heading, `maxNodes`-capped). A
//     candidate or an anchor outside that set is reported unmeasured, never assumed preserved.
//   • Every relation is derived from the same `getBoundingClientRect()` read the delta uses, so it
//     inherits box-geometry-vs-painted-geometry error (padding, `overflow: hidden`) exactly as the
//     research cluster documents (`deep/invariance-evidence-table.md` §7, "NOIs").

/**
 * The direction of an anchor from the candidate, as GWALI's 4-bucket alphabet (North/South/East/West at
 * 45° boundaries; `deep/relational-layout-models.md` §2), read as a BEARING between the two CENTRES.
 *
 * A bearing, not an edge predicate — so a wide left-aligned input sitting directly ABOVE a small button
 * still reads `east`, because its centre is off to the right. That is not a defect to work around: the
 * "same row / same column" question is carried separately and more precisely by
 * {@link AnchorRelation.bandOverlapX}/`bandOverlapY`, and {@link relationHolds} compares the CONTINUOUS
 * angle (GWALI's 45° α) rather than this label, so a bucket that flips across a boundary on a 2° drift
 * never counts as a broken relation. Treat the bucket as legible shorthand, never as the comparison.
 *
 * `coincident` is DW's own addition: when two centres nearly coincide the angle is numerically
 * meaningless, so it is reported as its own bucket rather than as a spuriously precise direction.
 */
export type DirectionBucket = 'north' | 'south' | 'east' | 'west' | 'coincident';

/** One candidate→anchor relation. The tuple format is X-PERT/ReDeCheck's sibling-edge alphabet
 *  (direction · gap · per-axis band alignment · shared geometric container), reduced to the four
 *  components that survive the tolerances their SHIPPED CODE uses rather than their papers' equalities
 *  (`deep/relational-layout-models.md` §8.3). */
export interface AnchorRelation {
  /** The anchor's cross-snapshot identity key — see {@link identityKey}. */
  anchorKey: string;
  /** Centre-to-centre angle of the anchor from the candidate, degrees, 0 = due east, 90 = due north. */
  angle: number;
  /** {@link DirectionBucket} derived from `angle`. Reported for legibility; the COMPARISON uses the
   *  continuous `angle`, which is what avoids ReDeCheck's documented 22% coincidental-flip FP rate. */
  direction: DirectionBucket;
  /** CSS px between the two rects' facing edges (0 when they overlap on both axes) — GWALI's
   *  nearest-point MBR distance. */
  gap: number;
  /** Shared HORIZONTAL extent as a fraction of the narrower rect (0..1) — "these two sit in the same
   *  column". */
  bandOverlapX: number;
  /** Shared VERTICAL extent as a fraction of the shorter rect (0..1) — "these two sit in the same
   *  row". */
  bandOverlapY: number;
  /** Do candidate and anchor share the same INNERMOST GEOMETRIC container? Geometric, not DOM —
   *  X-PERT and ReDeCheck both use the smallest containing box precisely because it is immune to
   *  wrapper-div churn (`deep/relational-layout-models.md` §8.2). */
  sameContainer: boolean;
}

/** Why a relational agreement is (or is not) available. Closed set — a caller branches on this, never
 *  on prose. */
export type RelationalStatus =
  | 'measured' // a snapshot-A fingerprint was built and re-scored on snapshot B
  | 'disabled' // opted out via `relational: false`
  | 'frame-root' // `root` is a child Frame; `pageMap()` reads the main document only
  | 'page-map-blocked' // `pageMap()` could not scan (observer injection blocked — e.g. a strict CSP)
  | 'not-re-resolved' // the selector did not re-resolve to exactly one element — nothing to compare
  | 'candidate-unmapped' // the candidate was outside `pageMap()`'s salient set on A or on B
  | 'candidate-unmeasurable' // the candidate was in the salient set but had no usable box (hidden /
  // zero-layout), so its relations are degenerate — the relational twin of `centerShift`'s null
  | 'no-anchors'; // no salient neighbour carried an identity key usable on both snapshots

/** A candidate's snapshot-A relational fingerprint: its relations to the K nearest usable anchors. */
export interface RelationalFingerprint {
  relations: AnchorRelation[];
}

/** The outcome of re-scoring a snapshot-A fingerprint against snapshot B. */
export interface RelationalComparison {
  /** Fraction of snapshot-A anchor relations still holding on B (0..1). An anchor that VANISHED, or
   *  whose identity key stopped being unique, counts as NOT preserved — losing your neighbourhood is
   *  a context change, not a missing measurement. */
  agreement: number;
  /** Denominator: how many snapshot-A anchor relations were re-scored. */
  anchors: number;
  /** Numerator: how many of them held within tolerance. */
  preserved: number;
}

// --- Tolerances -------------------------------------------------------------------------------------
// Sourced from the deep-read briefs where a source exists; explicitly marked where one does not. The
// briefs' own §9 is blunt that the literature's constants "are unexplained constants and the papers do
// not even state them" — so an UNCALIBRATED mark here means exactly that: chosen, not measured.

/** Anchors per candidate. GWALI scores k-NN *neighbourhoods* rather than a complete graph, and that
 *  scoping is what lifts its precision to 91% vs X-PERT's 55% on identical pages
 *  (`deep/relational-layout-models.md` §5) — but GWALI sizes k ∝ |V| and never publishes the constant.
 *  // UNCALIBRATED — chosen, not measured. */
export const DEFAULT_ANCHOR_COUNT = 6;

/** A direction relation counts as preserved while the centre-to-centre angle moved less than this.
 *  GWALI's validated α: it ignores direction changes under 45°, and that filter is load-bearing for its
 *  91%/100% precision/recall (`deep/relational-layout-models.md` §3, §5). */
export const DIRECTION_ANGLE_TOLERANCE_DEG = 45;

/** Below this centre separation the angle is numerically meaningless (a wrapper concentric with its
 *  child), so the relation is bucketed `coincident` instead. Matches the ~3 px significance floor
 *  Chromium's own Layout Instability spec uses to decide a box "meaningfully moved"
 *  (`deep/invariance-evidence-table.md` §6). */
export const DIRECTION_MIN_CENTRE_DISTANCE_PX = 3;

/** Absolute floor on a tolerated gap change. X-PERT's shipped `diffThreshold`: it reports a direction
 *  flip only when the inter-box gap ALSO moved by more than 5 px
 *  (`deep/relational-layout-models.md` §3). */
export const GAP_ABSOLUTE_TOLERANCE_PX = 5;

/** Relative arm of the gap tolerance. The invariance brief's §8 is explicit that flat unnormalised px
 *  cutoffs are the wrong shape ("Browserbite's 40/15 px is falsified by its own 70-px cited example;
 *  Similo's 100-px linear cutoff was replaced under every tuned configuration"), so the gap test is
 *  `max(absolute, relative)` — but no source publishes the relative arm.
 *  // UNCALIBRATED — chosen, not measured. */
export const GAP_RELATIVE_TOLERANCE = 0.5;

/** A band overlap at or above this fraction reads as "shares the row/column". The comparison is on the
 *  resulting BOOLEAN, not the fraction, mirroring how X-PERT/ReDeCheck carry alignment as a flag; the
 *  fraction itself has no published threshold.
 *  // UNCALIBRATED — chosen, not measured. */
export const BAND_OVERLAP_THRESHOLD = 0.5;

/** Rects with either dimension at or below this are dropped as anchors. Both X-PERT ("boxes with any
 *  dimension ≤ 5 px") and ReDeCheck ("elements under 5×5 px") filter at exactly this
 *  (`deep/relational-layout-models.md` §2). */
export const MIN_ANCHOR_DIMENSION_PX = 5;

/** Agreement at or above this earns the `relational-context-preserved` flag.
 *  // UNCALIBRATED — chosen, not measured. */
export const RELATIONAL_PRESERVED_MIN = 0.8;

/** Agreement at or below this earns the `relational-context-broken` flag.
 *  // UNCALIBRATED — chosen, not measured. */
export const RELATIONAL_BROKEN_MAX = 0.4;

// --- Rect math --------------------------------------------------------------------------------------

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const midX = (r: Rect) => r.x + r.width / 2;
const midY = (r: Rect) => r.y + r.height / 2;

/** Shared extent of two 1-D intervals as a fraction of the SHORTER one (0..1). 0 when either is empty
 *  — an unmeasurable band is never reported as a full one. */
function bandOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const shorter = Math.min(aEnd - aStart, bEnd - bStart);
  if (shorter <= 0) return 0;
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / shorter;
}

/** Nearest-point distance between two axis-aligned rects (0 when they overlap on both axes) — the
 *  MBR distance GWALI uses to build its k-NN neighbourhoods. */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - right(b), b.x - right(a));
  const dy = Math.max(0, a.y - bottom(b), b.y - bottom(a));
  return Math.hypot(dx, dy);
}

/** Smallest signed difference between two bearings, in degrees, always 0..180. */
function angleDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function bucketFor(angle: number): DirectionBucket {
  if (angle >= -45 && angle < 45) return 'east';
  if (angle >= 45 && angle < 135) return 'north';
  if (angle >= -135 && angle < -45) return 'south';
  return 'west';
}

// --- Node selection ---------------------------------------------------------------------------------

/**
 * A salient node's cross-snapshot identity key, or null when it has none.
 *
 * (role, name) — the two attributes that survive every weighting in the Similo family (Kluge's tuned
 * weights: name 2.85–2.90, visible text 2.50–2.95, versus absolute XPath 0.05–1.05;
 * `deep/similo-family.md` §6). DW's role/name is its own lightweight in-page derivation, NOT
 * Playwright's ARIA name computation, so this key is deliberately used only where it is UNIQUE — see
 * {@link keyedNodes}.
 */
/** Separator inside an identity key. A control character, so it can never occur inside a role or a
 *  name and two different (role, name) pairs can never collide into one key. */
export const IDENTITY_KEY_SEPARATOR = '\u0000';

export function identityKey(node: Pick<PageMapNode, 'role' | 'name'>): string | null {
  const role = node.role?.trim();
  const name = node.name?.trim();
  if (!role || !name) return null;
  return `${role}${IDENTITY_KEY_SEPARATOR}${name}`;
}

/** Anchors must be big enough to have meaningful geometry — the 5×5 px filter both X-PERT and
 *  ReDeCheck apply. This also drops `display: none` nodes, whose rect is 0×0. */
function isAnchorSized(rect: Rect): boolean {
  return rect.width > MIN_ANCHOR_DIMENSION_PX && rect.height > MIN_ANCHOR_DIMENSION_PX;
}

/**
 * Does this node have a box worth reasoning about relationally?
 *
 * The CANDIDATE has to clear the same 5×5 px floor its anchors do. A hidden or zero-layout node still
 * appears in `pageMap()`'s salient set with a 0×0 rect, and every relation computed from that rect is
 * degenerate — the bearings collapse onto one point and the band overlaps are all 0, which reads as a
 * confident "context destroyed" when the truth is "position unmeasurable". That is precisely the case
 * `centerShift` already refuses to score (it returns null and the verdict is `inconclusive`), and the
 * relational witness must refuse it the same way rather than invent a 0.
 */
export function hasMeasurableBox(node: Pick<PageMapNode, 'geometry'>): boolean {
  return isAnchorSized(node.geometry.rect);
}

/**
 * Index the salient nodes that carry an identity key that is UNIQUE within this snapshot. A key held by
 * two nodes is dropped from the index entirely rather than resolved arbitrarily: picking one would be
 * exactly VON Similo's documented "selects a random element from the visual overlap" failure
 * (`deep/similo-family.md` §4), which is how a relational score turns into a confident false heal.
 */
function keyedNodes(nodes: readonly PageMapNode[]): Map<string, PageMapNode> {
  const byKey = new Map<string, PageMapNode>();
  const duplicated = new Set<string>();
  for (const n of nodes) {
    if (!isAnchorSized(n.geometry.rect)) continue;
    const key = identityKey(n);
    if (!key) continue;
    if (byKey.has(key)) duplicated.add(key);
    else byKey.set(key, n);
  }
  for (const key of duplicated) byKey.delete(key);
  return byKey;
}

/**
 * The innermost salient node that geometrically CONTAINS each node, by `ref`.
 *
 * Containment is X-PERT's non-strict rectangle test; the container is the smallest-area one, which is
 * how both X-PERT (area-ascending scan) and ReDeCheck (R-tree) define the "geometric parent" — chosen
 * over the DOM parent because it is immune to wrapper-div churn. Ties are broken by requiring the
 * container's area to be STRICTLY greater, so two equal boxes never contain each other and the map is
 * always acyclic. Nodes with no container map to null (top level).
 */
function containerIndex(nodes: readonly PageMapNode[]): Map<string, string | null> {
  const sized = nodes.filter((n) => isAnchorSized(n.geometry.rect));
  const out = new Map<string, string | null>();
  for (const n of nodes) {
    const r = n.geometry.rect;
    const area = r.width * r.height;
    let best: PageMapNode | null = null;
    let bestArea = Infinity;
    for (const c of sized) {
      if (c.ref === n.ref) continue;
      const cr = c.geometry.rect;
      const cArea = cr.width * cr.height;
      if (cArea <= area || cArea >= bestArea) continue;
      if (cr.x <= r.x && cr.y <= r.y && right(cr) >= right(r) && bottom(cr) >= bottom(r)) {
        best = c;
        bestArea = cArea;
      }
    }
    out.set(n.ref, best ? best.ref : null);
  }
  return out;
}

/** One snapshot's salient set, pre-indexed. Built ONCE per `pageMap()` read and shared by every
 *  candidate re-checked against it — {@link containerIndex} is O(n²) in the salient set, so building it
 *  per candidate would multiply that by the number of selectors under test for no benefit. */
export interface RelationalSnapshot {
  /** Nodes carrying an identity key that is UNIQUE in this snapshot, by key. */
  keyed: Map<string, PageMapNode>;
  /** Innermost geometric container per node `ref` (null = top level). */
  containers: Map<string, string | null>;
}

/** Index one snapshot's salient nodes for fingerprinting. */
export function indexSnapshot(nodes: readonly PageMapNode[]): RelationalSnapshot {
  return { keyed: keyedNodes(nodes), containers: containerIndex(nodes) };
}

// --- Fingerprint ------------------------------------------------------------------------------------

/** One candidate→anchor relation from two rects plus the pre-computed container answer. */
function relationTo(
  key: string,
  candidate: Rect,
  anchor: Rect,
  sameContainer: boolean,
): AnchorRelation {
  const dx = midX(anchor) - midX(candidate);
  const dy = midY(anchor) - midY(candidate);
  const centreDistance = Math.hypot(dx, dy);
  // Screen coordinates grow downward, so negate dy to read as a conventional bearing.
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return {
    anchorKey: key,
    angle,
    direction: centreDistance < DIRECTION_MIN_CENTRE_DISTANCE_PX ? 'coincident' : bucketFor(angle),
    gap: rectGap(candidate, anchor),
    bandOverlapX: bandOverlap(candidate.x, right(candidate), anchor.x, right(anchor)),
    bandOverlapY: bandOverlap(candidate.y, bottom(candidate), anchor.y, bottom(anchor)),
    sameContainer,
  };
}

/** Every relation from `candidate` to the keyed nodes of one snapshot, nearest first. */
function allRelations(candidate: PageMapNode, snapshot: RelationalSnapshot): AnchorRelation[] {
  const { keyed, containers } = snapshot;
  const candidateContainer = containers.get(candidate.ref) ?? null;
  const out: AnchorRelation[] = [];
  for (const [key, anchor] of keyed) {
    if (anchor.ref === candidate.ref) continue;
    const anchorContainer = containers.get(anchor.ref) ?? null;
    out.push(
      relationTo(
        key,
        candidate.geometry.rect,
        anchor.geometry.rect,
        candidateContainer === anchorContainer,
      ),
    );
  }
  // Nearest first (MBR gap, then centre distance, then key) — a total order, so the chosen anchor set
  // is deterministic for a given snapshot rather than dependent on Map insertion order.
  const cr = candidate.geometry.rect;
  const centreOf = (key: string) => {
    const a = keyed.get(key)!.geometry.rect;
    return Math.hypot(midX(a) - midX(cr), midY(a) - midY(cr));
  };
  return out.sort(
    (a, b) =>
      a.gap - b.gap ||
      centreOf(a.anchorKey) - centreOf(b.anchorKey) ||
      (a.anchorKey < b.anchorKey ? -1 : 1),
  );
}

/** Snapshot A: the candidate's relations to its `k` nearest identifiable salient neighbours. */
export function fingerprintFor(
  candidate: PageMapNode,
  snapshot: RelationalSnapshot,
  k: number,
): RelationalFingerprint {
  return { relations: allRelations(candidate, snapshot).slice(0, Math.max(0, k)) };
}

/** Does one snapshot-A relation still hold on snapshot B, within the documented tolerances? All four
 *  components must agree — the edge-label-set semantics X-PERT and GWALI both diff on. */
export function relationHolds(a: AnchorRelation, b: AnchorRelation): boolean {
  if (a.direction === 'coincident' || b.direction === 'coincident') {
    // An angle between near-concentric centres is noise; the only honest test is that BOTH sides are
    // still concentric.
    if (a.direction !== b.direction) return false;
  } else if (angleDelta(a.angle, b.angle) >= DIRECTION_ANGLE_TOLERANCE_DEG) {
    return false;
  }
  const gapTolerance = Math.max(
    GAP_ABSOLUTE_TOLERANCE_PX,
    GAP_RELATIVE_TOLERANCE * Math.max(a.gap, b.gap),
  );
  if (Math.abs(a.gap - b.gap) > gapTolerance) return false;
  if (a.bandOverlapX >= BAND_OVERLAP_THRESHOLD !== b.bandOverlapX >= BAND_OVERLAP_THRESHOLD) {
    return false;
  }
  if (a.bandOverlapY >= BAND_OVERLAP_THRESHOLD !== b.bandOverlapY >= BAND_OVERLAP_THRESHOLD) {
    return false;
  }
  return a.sameContainer === b.sameContainer;
}

/**
 * Snapshot B: re-score a snapshot-A fingerprint against the candidate's CURRENT neighbourhood.
 *
 * The denominator is snapshot A's anchor count, not the number of anchors that happened to survive: an
 * anchor that vanished (or whose identity key stopped being unique) counts as NOT preserved, because
 * losing your neighbourhood is a real context change and scoring it as "unmeasured" would quietly turn
 * a demolished page into a perfect score.
 */
export function compareFingerprint(
  fingerprint: RelationalFingerprint,
  candidate: PageMapNode,
  snapshot: RelationalSnapshot,
): RelationalComparison {
  const anchors = fingerprint.relations.length;
  if (anchors === 0) return { agreement: 0, anchors: 0, preserved: 0 };
  const { keyed, containers } = snapshot;
  const candidateContainer = containers.get(candidate.ref) ?? null;
  let preserved = 0;
  for (const before of fingerprint.relations) {
    const anchor = keyed.get(before.anchorKey);
    if (!anchor || anchor.ref === candidate.ref) continue; // gone, ambiguous, or now the candidate
    const after = relationTo(
      before.anchorKey,
      candidate.geometry.rect,
      anchor.geometry.rect,
      candidateContainer === (containers.get(anchor.ref) ?? null),
    );
    if (relationHolds(before, after)) preserved++;
  }
  return { agreement: preserved / anchors, anchors, preserved };
}
