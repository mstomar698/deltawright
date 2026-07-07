import type { Delta, DeltaNode } from '../src/index';

// Information-parity view of a delta: what-changed only (role/name/ref), with the
// geometry + actionability verdict stripped, so its token cost is comparable to an
// a11y diff (which carries neither).
export function minimalDeltaText(delta: Delta): string {
  const KIND: Record<DeltaNode['kind'], string> = {
    added: '+',
    removed: '-',
    attrChanged: '~',
    textChanged: '~',
  };
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));
  const childrenOf = new Map<string | null, DeltaNode[]>();
  for (const n of delta.nodes) {
    const p = n.parentRef && byRef.has(n.parentRef) ? n.parentRef : null;
    (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(n);
  }
  const label = (n: DeltaNode) => {
    const b = n.role ?? n.tag;
    return n.name ? `${b} "${n.name}"` : b;
  };
  const lines: string[] = [];
  const walk = (p: string | null, d: number) => {
    for (const n of childrenOf.get(p) ?? []) {
      lines.push('  '.repeat(d) + `${KIND[n.kind]} ${label(n)} [${n.ref}]`);
      walk(n.ref, d + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}
