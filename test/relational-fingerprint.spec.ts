import { test, expect } from '@playwright/test';
import type { PageMapNode } from '../src/host/page-map';
import type { Rect } from '../src/host/types';
import {
  BAND_OVERLAP_THRESHOLD,
  DEFAULT_ANCHOR_COUNT,
  DIRECTION_ANGLE_TOLERANCE_DEG,
  GAP_ABSOLUTE_TOLERANCE_PX,
  MIN_ANCHOR_DIMENSION_PX,
  compareFingerprint,
  containerIndex,
  fingerprintFor,
  identityKey,
  keyedNodes,
  relationHolds,
} from '../src/matchers/relational-fingerprint';

/** Build an identity key the way the module does, so these tests pin the SEMANTICS (role+name) and
 *  never the private encoding of the separator. */
const key = (role: string, name: string) => identityKey({ role, name })!;

// v1.2 — the PURE half of the relational fingerprint: rect math, anchor identity, geometric
// containment, and the tolerance semantics. No page, no Playwright surface. The live two-snapshot
// behaviour (scroll / responsive breakpoint / reflow / false-heal) is exercised against real pages in
// `relational-retention.spec.ts`; this file pins the algebra those tests depend on.

/** Minimal salient-node stub — only the fields the fingerprint actually reads. */
function node(ref: string, role: string | null, name: string | null, rect: Rect): PageMapNode {
  return {
    ref,
    deltaRef: null,
    role,
    name,
    interactive: true,
    geometry: {
      rect,
      inViewport: true,
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
      hitSelf: true,
      coveredBy: null,
      offscreen: false,
    },
    zone: 'center',
    layer: 0,
    geomActionable: 'ACTIONABLE',
    actionabilityReason: null,
    reconciled: false,
    actionable: 'ACTIONABLE',
    geomDisagreesWithPlaywright: false,
    recency: null,
  };
}

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** Translate every node's rect by (dx, dy) — the exact transform a page SCROLL applies. */
function translate(nodes: PageMapNode[], dx: number, dy: number): PageMapNode[] {
  return nodes.map((n) => ({
    ...n,
    geometry: {
      ...n.geometry,
      rect: {
        ...n.geometry.rect,
        x: n.geometry.rect.x + dx,
        y: n.geometry.rect.y + dy,
      },
    },
  }));
}

// A small, deterministic "form card": a heading above an input, with Save/Cancel side by side below.
function card(): PageMapNode[] {
  return [
    node('m1', 'region', 'Card', r(100, 100, 300, 200)), // the geometric container of the rest
    node('m2', 'heading', 'Account', r(110, 110, 200, 20)),
    node('m3', 'textbox', 'Email', r(110, 140, 280, 24)),
    node('m4', 'button', 'Save', r(110, 180, 60, 24)),
    node('m5', 'button', 'Cancel', r(190, 180, 60, 24)),
    node('m6', 'link', 'Help', r(600, 400, 40, 20)), // outside the card
  ];
}

const save = (nodes: PageMapNode[]) => nodes.find((n) => n.ref === 'm4')!;

test('identityKey needs BOTH a role and a name — anything less is unusable as an anchor', () => {
  expect(identityKey({ role: 'button', name: 'Save' })).toBeTruthy();
  // Distinct (role, name) pairs never collide into one key, however the separator is spelled.
  expect(key('button', 'Save x')).not.toBe(key('button Save', 'x'));
  expect(identityKey({ role: 'button', name: null })).toBeNull();
  expect(identityKey({ role: null, name: 'Save' })).toBeNull();
  expect(identityKey({ role: 'button', name: '   ' })).toBeNull();
});

test('a DUPLICATED identity key is dropped entirely, never resolved arbitrarily', () => {
  const nodes = [
    node('m1', 'button', 'Publish', r(0, 0, 60, 24)),
    node('m2', 'button', 'Publish', r(0, 40, 60, 24)),
    node('m3', 'button', 'Save', r(0, 80, 60, 24)),
  ];
  const keyed = keyedNodes(nodes);
  // Picking either "Publish" would be VON Similo's "random element from the overlap" failure.
  expect(keyed.has(key('button', 'Publish'))).toBe(false);
  expect(keyed.get(key('button', 'Save'))?.ref).toBe('m3');
});

test('anchors under the 5x5 px floor (incl. display:none 0x0 rects) are dropped', () => {
  const nodes = [
    node('m1', 'button', 'Tiny', r(0, 0, MIN_ANCHOR_DIMENSION_PX, 24)),
    node('m2', 'button', 'Hidden', r(0, 0, 0, 0)),
    node('m3', 'button', 'Real', r(0, 40, 60, 24)),
  ];
  const keyed = keyedNodes(nodes);
  expect([...keyed.keys()]).toEqual([key('button', 'Real')]);
});

test('the geometric container is the innermost containing box, and equal boxes never nest', () => {
  const containers = containerIndex(card());
  expect(containers.get('m4')).toBe('m1'); // Save sits inside the card
  expect(containers.get('m5')).toBe('m1');
  expect(containers.get('m1')).toBeNull(); // the card itself is top level here
  expect(containers.get('m6')).toBeNull(); // Help is outside the card

  // A wrapper with the EXACT same rect must not be reported as a container (that would make the
  // relation cyclic and the "same container" answer arbitrary).
  const twins = [
    node('m1', 'region', 'Wrapper', r(0, 0, 100, 100)),
    node('m2', 'region', 'Inner', r(0, 0, 100, 100)),
  ];
  const twinContainers = containerIndex(twins);
  expect(twinContainers.get('m1')).toBeNull();
  expect(twinContainers.get('m2')).toBeNull();
});

test('the fingerprint takes the K nearest anchors and never includes the candidate itself', () => {
  const nodes = card();
  const fp = fingerprintFor(save(nodes), nodes, DEFAULT_ANCHOR_COUNT);
  const keys = fp.relations.map((rel) => rel.anchorKey);
  expect(keys).not.toContain(key('button', 'Save'));
  // Only 5 other nodes exist, so K=6 is not binding here; nearest-first ordering is.
  expect(keys).toEqual([
    key('region', 'Card'), // Save is INSIDE it → gap 0
    key('textbox', 'Email'), // 16px above
    key('button', 'Cancel'), // 20px to the right
    key('heading', 'Account'), // 50px above
    key('link', 'Help'), // far outside the card
  ]);
  expect(fingerprintFor(save(nodes), nodes, 2).relations).toHaveLength(2);
});

test('the tuple reads the way the layout looks: direction bucket, gap, per-axis band, container', () => {
  const nodes = card();
  const fp = fingerprintFor(save(nodes), nodes, DEFAULT_ANCHOR_COUNT);
  const byKey = new Map(fp.relations.map((rel) => [rel.anchorKey, rel]));

  const cancel = byKey.get(key('button', 'Cancel'))!;
  expect(cancel.direction).toBe('east'); // same row, to the right
  expect(cancel.gap).toBe(20); // 190 - (110 + 60)
  expect(cancel.bandOverlapY).toBe(1); // identical vertical extent → same row
  expect(cancel.bandOverlapX).toBe(0); // no shared horizontal extent
  expect(cancel.sameContainer).toBe(true); // both inside the card

  const email = byKey.get(key('textbox', 'Email'))!;
  expect(email.gap).toBe(16); // 180 - (140 + 24)
  expect(email.bandOverlapX).toBe(1); // Save's 60px column sits wholly inside the input's
  expect(email.bandOverlapY).toBe(0); // different rows
  expect(email.sameContainer).toBe(true);
  // `direction` is a BEARING between centres, not an edge predicate: the input's box sits above Save,
  // but it is 280px wide and left-aligned with a 60px button, so its CENTRE is off to the right and the
  // bearing reads 20° — `east`. This is exactly why alignment is carried separately (bandOverlapX = 1
  // says "same column") and why relationHolds compares the continuous angle, not this label.
  expect(email.direction).toBe('east');
  expect(email.angle).toBeCloseTo(20, 0);

  const help = byKey.get(key('link', 'Help'))!;
  expect(help.sameContainer).toBe(false); // Help is outside the card
});

test('a PURE TRANSLATION (what a page scroll is) preserves every single relation', () => {
  const before = card();
  const fp = fingerprintFor(save(before), before, DEFAULT_ANCHOR_COUNT);
  const after = translate(before, 0, -600);
  const cmp = compareFingerprint(fp, save(after), after);
  expect(cmp.anchors).toBe(5);
  expect(cmp.preserved).toBe(5);
  expect(cmp.agreement).toBe(1);
});

test('a VANISHED anchor counts as broken, not as unmeasured — the denominator is snapshot A', () => {
  const before = card();
  const fp = fingerprintFor(save(before), before, DEFAULT_ANCHOR_COUNT);
  const after = card().filter((n) => n.ref !== 'm5' && n.ref !== 'm3'); // Cancel + Email removed
  const cmp = compareFingerprint(fp, save(after), after);
  expect(cmp.anchors).toBe(5);
  expect(cmp.preserved).toBe(3);
  expect(cmp.agreement).toBeCloseTo(3 / 5, 10);
});

test('an anchor whose key stopped being UNIQUE is not silently matched to a look-alike', () => {
  const before = card();
  const fp = fingerprintFor(save(before), before, DEFAULT_ANCHOR_COUNT);
  // A second "Cancel" appears somewhere else: the key is now ambiguous, so that relation is dropped
  // rather than scored against whichever node happened to be indexed first.
  const after = [...card(), node('m7', 'button', 'Cancel', r(800, 600, 60, 24))];
  const cmp = compareFingerprint(fp, save(after), after);
  expect(cmp.preserved).toBe(4);
  expect(cmp.agreement).toBeCloseTo(4 / 5, 10);
});

test('a candidate torn out of its context scores near zero even with the SAME absolute position', () => {
  const before = card();
  const fp = fingerprintFor(save(before), before, DEFAULT_ANCHOR_COUNT);
  // Same rect for Save (centerShift would read 0 — a perfect "retained"), entirely new neighbourhood.
  const after = [
    node('m1', 'region', 'Billing', r(100, 100, 300, 200)),
    node('m2', 'heading', 'Invoices', r(110, 110, 200, 20)),
    node('m3', 'textbox', 'Card number', r(110, 140, 280, 24)),
    node('m4', 'button', 'Save', r(110, 180, 60, 24)),
    node('m5', 'button', 'Pay', r(190, 180, 60, 24)),
  ];
  const cmp = compareFingerprint(fp, save(after), after);
  expect(cmp.agreement).toBe(0); // every snapshot-A anchor key is gone
});

test('relationHolds: the four tolerances behave as documented', () => {
  const base = {
    anchorKey: key('button', 'Cancel'),
    angle: 0,
    direction: 'east' as const,
    gap: 20,
    bandOverlapX: 0,
    bandOverlapY: 1,
    sameContainer: true,
  };
  expect(relationHolds(base, { ...base })).toBe(true);

  // Direction: compared on the CONTINUOUS angle, so a sub-45° drift holds even across a bucket edge.
  expect(relationHolds(base, { ...base, angle: 44, direction: 'east' })).toBe(true);
  expect(relationHolds(base, { ...base, angle: 46, direction: 'north' })).toBe(false);

  // Gap: max(5px, 50% of the LARGER gap). 20 -> 30 stays inside the relative arm (tol 15); 20 -> 50
  // does not (tol 25, change 30).
  expect(relationHolds(base, { ...base, gap: 30 })).toBe(true);
  expect(relationHolds(base, { ...base, gap: 50 })).toBe(false);
  // …and the absolute arm still covers a small change on a zero gap.
  expect(relationHolds({ ...base, gap: 0 }, { ...base, gap: GAP_ABSOLUTE_TOLERANCE_PX })).toBe(
    true,
  );
  expect(relationHolds({ ...base, gap: 0 }, { ...base, gap: GAP_ABSOLUTE_TOLERANCE_PX + 1 })).toBe(
    false,
  );

  // Band overlap: the BOOLEAN must agree, so drift inside one side of the threshold is fine.
  expect(relationHolds(base, { ...base, bandOverlapY: BAND_OVERLAP_THRESHOLD })).toBe(true);
  expect(relationHolds(base, { ...base, bandOverlapY: BAND_OVERLAP_THRESHOLD - 0.01 })).toBe(false);

  // Container: a re-parent breaks the relation outright.
  expect(relationHolds(base, { ...base, sameContainer: false })).toBe(false);
});

test('near-concentric centres are bucketed `coincident`, not given a spurious direction', () => {
  const nodes = [
    node('m1', 'region', 'Wrapper', r(100, 100, 200, 100)),
    node('m2', 'button', 'Save', r(101, 101, 198, 98)), // same centre, 1px inset
    node('m3', 'button', 'Cancel', r(500, 100, 60, 24)),
  ];
  const fp = fingerprintFor(nodes[1]!, nodes, DEFAULT_ANCHOR_COUNT);
  const wrapper = fp.relations.find((rel) => rel.anchorKey === key('region', 'Wrapper'))!;
  expect(wrapper.direction).toBe('coincident');

  // A coincident relation only holds against another coincident one — the angle is noise either way.
  const other = fp.relations.find((rel) => rel.anchorKey === key('button', 'Cancel'))!;
  expect(other.direction).not.toBe('coincident');
  expect(relationHolds(wrapper, { ...wrapper, direction: 'east' })).toBe(false);
  expect(relationHolds(wrapper, { ...wrapper, angle: 180 })).toBe(true);
});

test('the tolerance constants stay traceable to the briefs that justify them', () => {
  // GWALI's validated α (deep/relational-layout-models.md §3/§5) and X-PERT's shipped diffThreshold
  // (§3). A change here is a research-backed decision, not an incidental tweak.
  expect(DIRECTION_ANGLE_TOLERANCE_DEG).toBe(45);
  expect(GAP_ABSOLUTE_TOLERANCE_PX).toBe(5);
  expect(MIN_ANCHOR_DIMENSION_PX).toBe(5);
});

test('a candidate with no identifiable neighbour yields an empty fingerprint, not a fake score', () => {
  const nodes = [
    node('m1', 'button', 'Save', r(0, 0, 60, 24)),
    node('m2', null, null, r(0, 40, 60, 24)), // no role/name → unusable as an anchor
  ];
  const fp = fingerprintFor(nodes[0]!, nodes, DEFAULT_ANCHOR_COUNT);
  expect(fp.relations).toHaveLength(0);
  const cmp = compareFingerprint(fp, nodes[0]!, nodes);
  expect(cmp).toEqual({ agreement: 0, anchors: 0, preserved: 0 });
});
