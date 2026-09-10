import type { PageMapNode } from '../host/page-map';
import type { Rect } from '../host/types';

// The RELATIONAL geometric fingerprint (v1.2) — a second, differently-fragile position witness.
//
// `measureRetention`'s existing position signal is ONE absolute point: the candidate's center, in the
// observer's viewport coordinates. Its own doc comment already names the gap — "a page SCROLL between
// snapshots, or an offset child Frame, inflates the shift" — and the research sweep behind this module
// (`docs/research/geometric-identification/`) found the same failure at scale: absolute position is a
// far weaker key than position RELATIVE TO NEARBY ANCHORS. On one 14-site corpus, X-PERT's
// relative-layout detector scores 60 TP / 23 FP — 72% precision — where CrossCheck+, built on absolute
// position/size features, manages 18% (86 TP / 389 FP) (`deep/relational-layout-models.md` §5; X-PERT's
// often-quoted 76% is the whole tool across ALL XBI classes, not the relational detector alone). Similo
// likewise puts raw `location` in its low-weight group (hand weight 0.5, against 1.5 for name and
// visible text — `deep/similo-family.md` §2).
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
//     research cluster documents (`deep/relational-layout-models.md` §7: 83 "non-observable issue"
//     reports from boxes padded by invisible CSS padding and protrusions clipped by overflow:hidden).

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
  | 'candidate-unmeasurable' // the candidate was in the salient set but its box did not clear
  // MIN_ANCHOR_DIMENSION_PX on one of the snapshots (hidden, zero-layout, or genuinely tiny), so its
  // relations are degenerate — the relational twin of `centerShift`'s null
  | 'no-anchors'; // no salient neighbour carried an identity key usable on both snapshots

/** A candidate's snapshot-A relational fingerprint: its relations to the K nearest usable anchors. */
export interface RelationalFingerprint {
  relations: AnchorRelation[];
}

/** The outcome of re-scoring a snapshot-A fingerprint against snapshot B. */
export interface RelationalComparison {
  /** Fraction of snapshot-A anchor relations still holding on B (0..1), or null when the fingerprint
   *  had no anchors to score. An anchor that VANISHED, or whose identity key stopped being unique,
   *  counts as NOT preserved — losing your neighbourhood is a context change, not a missing
   *  measurement. Having had no anchors in the first place is the opposite, and reports null rather
   *  than a 0 that would read as "context destroyed". */
  agreement: number | null;
  /** Denominator: how many snapshot-A anchor relations were re-scored. */
  anchors: number;
  /** Numerator: how many of them held within tolerance. */
  preserved: number;
}

// --- Tolerances -------------------------------------------------------------------------------------
// Sourced from the deep-read briefs where a source exists; explicitly marked where one does not. The
// briefs' own §9 is blunt that the literature's constants "are unexplained constants and the papers do
// not even state them" — so an UNCALIBRATED mark here means exactly that: chosen, not measured.

/** Anchors per candidate. GWALI scores k-NN *neighbourhoods* rather than the complete graph, and
 *  reaches 91% precision against X-PERT-structure's 55% on the identical 54-site corpus
 *  (`deep/relational-layout-models.md` §5). Neighbourhood scoping is one of three changes GWALI makes
 *  at once — it also adds the 45° angular filter and a text-alignment exemption — so the lift is not
 *  attributable to k alone. GWALI sizes k ∝ |V| and never publishes the constant.
 *  // UNCALIBRATED — chosen, not measured. */
export const DEFAULT_ANCHOR_COUNT = 6;

/**
 * A direction relation counts as preserved while the centre-to-centre angle moved less than this.
 * GWALI's α, validated end-to-end at 91% precision / 100% recall over 54 apps
 * (`deep/relational-layout-models.md` §3, §5).
 *
 * THE SAME BRIEFS RETRACT HALF OF THAT, and the retraction applies here in full. A flat degree cutoff
 * is GWALI's own named false-positive cause #2 — "large text-shrink cases can legitimately exceed it
 * without a real IPF" — and `deep/invariance-evidence-table.md` §5 rec 4 concludes the constant "must
 * be normalised by the elements' separation distance, not left as a flat degree cutoff", while §9
 * records that there is "no reported sensitivity analysis of the α=45° constant across a wider corpus".
 * DW ships the flat form knowingly: normalising by separation is itself an unmeasured design, and a
 * borrowed constant with a published validation beats an invented one. Expect the same false positives
 * GWALI reports — a neighbour that changes size a lot can swing the bearing past 45° with no real
 * layout break.
 */
export const DIRECTION_ANGLE_TOLERANCE_DEG = 45;

/**
 * Below this centre separation the angle is numerically meaningless (a wrapper concentric with its
 * child), so the relation is bucketed `coincident` instead.
 *
 * The CONCEPT is borrowed — "a small fixed-px floor before any comparison runs", which
 * `deep/invariance-evidence-table.md` §5 rec 1 recommends and Chromium's Layout Instability spec ships
 * (Chrome's "pixels to significance" = 3 px). The NUMBER is not transferable and is not claimed to be:
 * CLS floors ONE box's displacement between two frames, whereas this floors the SEPARATION between two
 * different boxes' centres. No source measures the latter.
 * // UNCALIBRATED — chosen, not measured.
 */
export const DIRECTION_MIN_CENTRE_DISTANCE_PX = 3;

/**
 * Absolute floor on a tolerated gap change. The number is X-PERT's shipped `diffThreshold`
 * (`deep/relational-layout-models.md` §3).
 *
 * ITS ROLE HERE IS NOT X-PERT'S. X-PERT uses the 5 px as an ADDITIONAL requirement before flagging a
 * direction flip — it never flags on a gap change alone. {@link relationHolds} makes it an INDEPENDENT
 * necessary condition, so a gap change past tolerance breaks the relation even with the direction
 * unchanged. That makes DW strictly more sensitive than the source it borrows the constant from; the
 * error direction is toward reporting a broken relation, never toward a false "preserved".
 */
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
 *  dimension ≤ 5 px") and ReDeCheck ("elements under 5×5 px") filter at this size
 *  (`deep/relational-layout-models.md` §2); their boundaries differ by a pixel (≤ 5 vs < 5) and this
 *  takes X-PERT's, dropping a rect whose width or height is exactly 5. */
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

/** Separator inside an identity key. A control character, so it can never occur inside a role or a
 *  name and two different (role, name) pairs can never collide into one key. */
export const IDENTITY_KEY_SEPARATOR = '\u0000';

/**
 * A salient node's cross-snapshot identity key, or null when it has none.
 *
 * The KEY IS DW'S OWN — (role, name), the two fields `pageMap()` already derives. It is not Similo's
 * feature vector: Similo has no role attribute at all, and its `name` is the HTML `name=` attribute
 * compared for equality (`deep/similo-family.md` §2). What the Similo family does support is the
 * PRINCIPLE — the name-like and text-like attributes are the ones that hold their weight under every
 * tuning (Kluge's optimised weights: name 2.85–2.90 and visible text 2.50–2.95, against absolute XPath
 * 0.05–1.05; §6) — and that principle is why this key is built from role+name rather than from
 * position, size or DOM path.
 *
 * DW's role/name is a lightweight in-page derivation, NOT Playwright's ARIA name computation, so it is
 * deliberately used only where it is UNIQUE — see {@link keyedNodes}.
 */
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
 * Max per-edge disagreement (CSS px) still counted as "the same box". `pageMap()` rounds each rect
 * component with `Math.round` while Playwright's `boundingBox()` does not, so an identical element can
 * legitimately differ by half a pixel per edge; 1px covers that with a margin, and a wrong element is
 * off by far more than this in practice.
 * // UNCALIBRATED — chosen, not measured.
 */
export const SAME_BOX_TOLERANCE_PX = 2;

/**
 * Is `rect` (from `pageMap()`) the same box as `box` (from Playwright's `boundingBox()`)?
 *
 * This is an IDENTITY CROSS-CHECK, not a geometry comparison, and it exists because
 * `data-dw-map-ref` is not a safe cross-snapshot identity token on its own. The injected `scan`
 * assigns refs POSITIONALLY (`m1..mN`, in document order) and clears its previous stamps with
 * `document.querySelectorAll('[data-dw-map-ref]')` — which cannot reach a DETACHED subtree. So an
 * element that is out of the document while the snapshot-B scan runs and back in before its
 * attribute is read still carries its snapshot-A ref, and that ref now names a DIFFERENT element.
 * Trusting it produces a confidently wrong relational verdict in either direction: a fabricated
 * "context broken" on an unchanged page, or a fabricated "context preserved" that would feed the
 * `moved` durability bonus. Re-mounting subtrees (a tab panel, a modal, a virtualised row) make that
 * routine in exactly the SPAs this API is for; a concurrent `pageMap()` call re-stamping mid-flight
 * does the same thing.
 *
 * So the stamp is treated as a HINT and confirmed against geometry the caller already read for the
 * same locator. A mismatch degrades to `candidate-unmapped` — the fingerprint declines to score
 * rather than score the wrong element. Residual risk, stated plainly: a stale ref that happens to
 * name a node of the same size at the same place is indistinguishable from the real one, and would
 * pass. That is a far smaller target than "any re-mounted subtree".
 */
export function sameBox(
  rect: Rect,
  box: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(rect.x - box.x) <= SAME_BOX_TOLERANCE_PX &&
    Math.abs(rect.y - box.y) <= SAME_BOX_TOLERANCE_PX &&
    Math.abs(rect.width - box.width) <= SAME_BOX_TOLERANCE_PX &&
    Math.abs(rect.height - box.height) <= SAME_BOX_TOLERANCE_PX
  );
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
 * exactly the failure Kluge & Stocco's threat T4 records against VON Similo — every node in an overlap
 * group scores the same, so it "selects a random element from the visual overlap"
 * (`deep/similo-family.md` §4). That is how a relational score turns into a confident false heal.
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
  // `pageMap()` returns its nodes in DOCUMENT order, so a node's index is its document position and an
  // ancestor always precedes its descendant. That is the tie-break for two EQUAL rects, standing in for
  // X-PERT's "tie-break by XPath prefix" (we have no XPath). It matters: without it, an element that
  // exactly fills its wrapper would skip that wrapper and take the grandparent as its container, while
  // a sibling one pixel smaller took the wrapper — so a 1px layout change would flip the container
  // label and break every relation that node participates in at once. Coincidental flips of exactly
  // that kind cost ReDeCheck 22% of its small-range reports to false positives
  // (`deep/relational-layout-models.md` §7).
  const order = new Map(nodes.map((n, i) => [n.ref, i] as const));
  const out = new Map<string, string | null>();
  for (const n of nodes) {
    const r = n.geometry.rect;
    const area = r.width * r.height;
    const rank = order.get(n.ref) ?? -1;
    let best: PageMapNode | null = null;
    let bestArea = Infinity;
    let bestRank = -1;
    for (const c of sized) {
      if (c.ref === n.ref) continue;
      const cr = c.geometry.rect;
      const cArea = cr.width * cr.height;
      const cRank = order.get(c.ref) ?? -1;
      // Strictly larger, or exactly equal AND earlier in the document (the ancestor of the two). Never
      // true both ways round for one pair, so the container map stays acyclic.
      if (cArea < area || (cArea === area && cRank >= rank)) continue;
      if (!(cr.x <= r.x && cr.y <= r.y && right(cr) >= right(r) && bottom(cr) >= bottom(r)))
        continue;
      // Innermost wins: smallest area, and among equal areas the one DEEPEST in the document.
      if (cArea < bestArea || (cArea === bestArea && cRank > bestRank)) {
        best = c;
        bestArea = cArea;
        bestRank = cRank;
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

/**
 * Does one snapshot-A relation still hold on snapshot B, within the documented tolerances?
 *
 * All four components must agree. That conjunction is STRICTER than either source it draws on: GWALI
 * diffs edges as a graded symmetric difference (Σ|δ| over the label sets) and X-PERT gates each
 * justification flag behind an error ratio, so neither collapses an edge to a single boolean. DW does,
 * which trades away their gradation for a number a caller can act on. The error direction is toward
 * declaring a relation broken, never toward a false "preserved".
 */
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
  // Nothing was measurable, so nothing is reported — the same refusal {@link hasMeasurableBox} makes.
  if (anchors === 0) return { agreement: null, anchors: 0, preserved: 0 };
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
