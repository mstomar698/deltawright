// A stable, geometry-tolerant fingerprint of a Delta, for reproducible regression
// assertions (e.g. the GWT-fixture demo). It hashes the delta's STRUCTURE + semantics —
// kind, role/tag, normalized name, interactive flag, actionability verdict, the
// geometry<->Playwright disagreement (geometryVerdict + agreed), a coarse size bucket,
// viewport/coverage flags, and the parent->child tree — while DROPPING everything that
// jitters across runs: the raw data-dw-ref ids (only tree EDGES are kept), raw pixel
// rects, computed-style strings, reason/error text, timing stats, and MutationObserver
// record order (siblings are sorted by a stable key).
//
// ATTRIBUTE IDENTITY (Wave-1 #3): an attrChanged node folds the SET of changed attribute
// NAMES — filtered to a stable state allowlist (aria-pressed/expanded/selected/checked/…,
// disabled, checked, open, readonly, hidden, class) and sorted — into the fingerprint. So an
// action that starts toggling a DIFFERENT state attribute (class -> aria-pressed) is now
// distinguished even when the tree + verdict are unchanged. LIMIT (honesty): only attribute
// NAMES are captured upstream (values are dropped at collect), so this catches WHICH state
// attribute changed, not its old->new value; non-allowlisted / volatile attrs (style,
// framework-generated tokens) are dropped so they can't jitter the hash.
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

/**
 * Stable STATE attributes folded into the fingerprint (Wave-1 #3). Only attribute NAMES reach the
 * checksum (values are dropped at capture), so this records WHICH state attribute changed, not its
 * value. Restricted to widget/interaction STATE so a volatile attr (`style`, framework-generated
 * tokens) can't jitter the hash; `class` is kept by NAME only (that class changed), never by its
 * churny token values. Background attr churn is already dropped upstream (observer bgAttr filter).
 */
const STATE_ATTR_ALLOWLIST = new Set<string>([
  'class',
  'disabled',
  'checked',
  'selected',
  'open',
  'hidden',
  'readonly',
  'contenteditable',
  'aria-pressed',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-current',
  'aria-disabled',
  'aria-invalid',
  'aria-hidden',
  'aria-busy',
  'aria-required',
]);

/** An attrChanged node's changed-attr NAMES, lower-cased, filtered to the state allowlist, de-duped
 *  and sorted — so record order and non-state attrs never jitter the fingerprint. Guarded on kind so
 *  the field is empty for non-attrChanged nodes locally (the collector already only sets
 *  `changedAttrs` on attrChanged nodes; this makes that invariant hold at the checksum too). */
function normAttrs(node: DeltaNode): string[] {
  if (node.kind !== 'attrChanged') return [];
  const attrs = node.changedAttrs;
  if (!attrs || attrs.length === 0) return [];
  const kept = new Set<string>();
  for (const a of attrs) {
    const name = a.toLowerCase();
    if (STATE_ATTR_ALLOWLIST.has(name)) kept.add(name);
  }
  return [...kept].sort();
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
  /** Sorted, allowlisted changed-attribute NAMES (Wave-1 #3) — empty for non-attrChanged nodes. */
  ca: string[];
  children: NormNode[];
}

/** Stable sibling sort key — makes the fingerprint independent of MutationObserver
 *  record order (same precedent as bench/structural-diff.ts multiset keying). */
function sortKey(n: NormNode): string {
  return [n.k, n.t, n.r, n.n, n.v, n.box, n.ca.join(',')].join('|');
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
    ca: normAttrs(node),
    children,
  };
}

/** Canonical JSON with a FIXED key order and no whitespace (JSON.stringify key order is
 *  insertion order, which we control here). */
function canonical(n: NormNode): string {
  const kids = n.children.map(canonical).join(',');
  const ca = n.ca.map((a) => JSON.stringify(a)).join(',');
  return (
    `{"k":${JSON.stringify(n.k)},"t":${JSON.stringify(n.t)},"r":${JSON.stringify(n.r)},` +
    `"n":${JSON.stringify(n.n)},"i":${n.i},"v":${JSON.stringify(n.v)},"gv":${JSON.stringify(n.gv)},` +
    `"ag":${n.ag},"box":${JSON.stringify(n.box)},"inv":${JSON.stringify(n.inv)},` +
    `"off":${JSON.stringify(n.off)},"cov":${JSON.stringify(n.cov)},"ca":[${ca}],"children":[${kids}]}`
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
