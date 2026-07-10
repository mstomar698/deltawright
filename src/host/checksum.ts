// A stable, geometry-tolerant fingerprint of a Delta, for reproducible regression
// assertions (e.g. the GWT-fixture demo). It hashes the delta's STRUCTURE + semantics —
// kind, role/tag, normalized name, interactive flag, actionability verdict, the
// geometry<->Playwright disagreement (geometryVerdict + agreed), a coarse size bucket,
// viewport/coverage flags, and the parent->child tree — while DROPPING everything that
// jitters across runs: the raw data-dw-ref ids (only tree EDGES are kept), raw pixel
// rects, computed-style strings, reason/error text, timing stats, and MutationObserver
// record order (siblings are sorted by a stable key).
//
// KNOWN BLIND SPOT: an attrChanged node's `changedAttrs` is NOT hashed at all — the
// fingerprint records THAT a node's attributes changed (kind=attrChanged), not WHICH ones.
// So an action that starts toggling a different attribute (class -> aria-pressed) without
// altering the verdict or tree is NOT distinguished. Deliberate for now (keeps the coarse
// bucket coarse); folding the attr SET back in is a candidate refinement.
//
// IMPORTANT (honesty): a matching checksum proves output == the output we captured — it
// is a REGRESSION guard, nothing more. It says nothing about whether the fixture faithfully
// models a real app. Do not present a green checksum as evidence Deltawright "works" on any
// particular framework; that requires calibration against a real trace.
import { createHash } from 'node:crypto';
import type { Delta, DeltaNode } from './types';

/** Coarse size bucket — absorbs sub-pixel / DPR / font / centering jitter. */
function sizeBucket(node: DeltaNode): string {
  const g = node.geometry;
  if (!g) return 'none';
  const m = Math.max(g.rect.width, g.rect.height);
  if (m === 0) return 'none';
  if (m <= 32) return 'sm';
  if (m <= 200) return 'md';
  return 'lg';
}

/** Normalize a describe()-style label ("tag.class[role=..]"): keep framework `gwt-*`
 *  classes (load-bearing identity, e.g. the glass coverer), replace an obfuscated app
 *  class (letter + >=4 alnum, no hyphen — rebuilt every GWT compile) with the token `hash`. */
function normClass(label: string | null): string {
  if (!label) return '';
  return label.replace(/\.([A-Za-z][A-Za-z0-9]{4,})\b/g, (m, cls: string) =>
    cls.includes('-') ? m : '.hash',
  );
}

function normName(name: string | null): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}

interface NormNode {
  k: DeltaNode['kind'];
  t: string;
  r: string;
  n: string;
  i: 0 | 1;
  v: string;
  gv: string;
  ag: 0 | 1;
  box: string;
  inv: string;
  off: string;
  cov: string;
  children: NormNode[];
}

/** Stable sibling sort key — makes the fingerprint independent of MutationObserver
 *  record order (same precedent as bench/structural-diff.ts multiset keying). */
function sortKey(n: NormNode): string {
  return [n.k, n.t, n.r, n.n, n.v, n.box].join('|');
}

function normalizeNode(node: DeltaNode, childrenOf: Map<string | null, DeltaNode[]>): NormNode {
  const g = node.geometry;
  const a = node.actionability;
  const children = (childrenOf.get(node.ref) ?? [])
    .map((c) => normalizeNode(c, childrenOf))
    .sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  return {
    k: node.kind,
    t: node.tag,
    r: node.role ?? '',
    n: normName(node.name),
    i: node.interactive ? 1 : 0,
    v: a.verdict,
    gv: a.geometryVerdict,
    ag: a.agreed ? 1 : 0,
    box: sizeBucket(node),
    inv: g ? (g.inViewport ? '1' : '0') : '',
    off: g ? (g.offscreen ? '1' : '0') : '',
    cov: normClass(g?.coveredBy ?? null),
    children,
  };
}

/** Canonical JSON with a FIXED key order and no whitespace (JSON.stringify key order is
 *  insertion order, which we control here). */
function canonical(n: NormNode): string {
  const kids = n.children.map(canonical).join(',');
  return (
    `{"k":${JSON.stringify(n.k)},"t":${JSON.stringify(n.t)},"r":${JSON.stringify(n.r)},` +
    `"n":${JSON.stringify(n.n)},"i":${n.i},"v":${JSON.stringify(n.v)},"gv":${JSON.stringify(n.gv)},` +
    `"ag":${n.ag},"box":${JSON.stringify(n.box)},"inv":${JSON.stringify(n.inv)},` +
    `"off":${JSON.stringify(n.off)},"cov":${JSON.stringify(n.cov)},"children":[${kids}]}`
  );
}

/** The canonical normalized form of a delta (roots sorted), plus the one kept stat. */
export function normalizeDelta(delta: Delta): string {
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));
  const childrenOf = new Map<string | null, DeltaNode[]>();
  for (const n of delta.nodes) {
    const parent = n.parentRef && byRef.has(n.parentRef) ? n.parentRef : null;
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(n);
  }
  const roots = (childrenOf.get(null) ?? [])
    .map((r) => normalizeNode(r, childrenOf))
    .sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const mw = delta.stats.hitMaxWait ? 1 : 0;
  return `{"mw":${mw},"roots":[${roots.map(canonical).join(',')}]}`;
}

/** sha256 of the canonical normalized delta — a reproducible regression fingerprint. */
export function checksum(delta: Delta): string {
  return createHash('sha256').update(normalizeDelta(delta)).digest('hex');
}
