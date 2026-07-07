import { encode } from 'gpt-tokenizer';
import type { Delta, DeltaNode } from './types';

// Renders a Delta to the compact, LLM-friendly text format from §3 of the design
// doc: added (+) / removed (-) / changed (~), each with position and an
// ACTIONABLE / NOT-actionable(reason) verdict, nested by DOM containment.

const KIND_PREFIX: Record<DeltaNode['kind'], string> = {
  added: '+',
  removed: '-',
  attrChanged: '~',
  textChanged: '~',
};

function label(node: DeltaNode): string {
  const base = node.role ?? node.tag;
  return node.name ? `${base} "${node.name}"` : base;
}

function geomTag(node: DeltaNode): string {
  const g = node.geometry;
  if (!g) return '';
  return `@ (${g.rect.x},${g.rect.y} ${g.rect.width}x${g.rect.height})`;
}

function verdictTag(node: DeltaNode): string {
  const a = node.actionability;
  if (a.verdict === 'n/a') return '';
  if (a.verdict === 'ACTIONABLE') return 'ACTIONABLE';
  return `NOT-actionable (${a.reason ?? 'unknown'})`;
}

function nodeLine(node: DeltaNode): string {
  const parts: string[] = [KIND_PREFIX[node.kind], label(node), `[${node.ref}]`];

  if (node.kind === 'removed') {
    parts.push('removed');
    return parts.join(' ');
  }

  const g = geomTag(node);
  if (g) parts.push(g);

  if (node.kind === 'attrChanged' && node.changedAttrs?.length) {
    parts.push(`changed:${node.changedAttrs.join(',')}`);
  }
  if (node.kind === 'textChanged') parts.push('text-changed');

  // Reachability hint for added container nodes an agent won't directly click.
  if (node.geometry?.hitSelf && !node.interactive && node.kind === 'added') {
    parts.push('topmost');
  }

  const v = verdictTag(node);
  if (v) parts.push(v);

  // Surface a geometry<->Playwright disagreement — the signal Deltawright exists
  // to expose. Playwright's verdict already won; this shows what geometry thought.
  const a = node.actionability;
  if (!a.agreed && a.geometryVerdict !== 'n/a') {
    parts.push(`[geom:${a.geometryVerdict}]`);
  }
  return parts.join(' ');
}

/** Render the delta as compact indented text. */
export function serialize(delta: Delta): string {
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));
  const childrenOf = new Map<string | null, DeltaNode[]>();
  for (const n of delta.nodes) {
    const parent = n.parentRef && byRef.has(n.parentRef) ? n.parentRef : null;
    const bucket = childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!;
    bucket.push(n);
  }

  const lines: string[] = [`after ${delta.action}:`];
  const walk = (parent: string | null, depth: number) => {
    for (const n of childrenOf.get(parent) ?? []) {
      lines.push('  '.repeat(depth + 1) + nodeLine(n));
      walk(n.ref, depth + 1);
    }
  };
  walk(null, 0);

  // Never present an empty delta as a confident "nothing changed". If settle hit
  // the maxWait cap with no mutations, that is a SUSPECTED MISS, not a no-op.
  if (delta.nodes.length === 0) {
    lines.push(
      delta.stats.hitMaxWait
        ? '  (no changes captured before maxWait cap — SUSPECTED MISS; raise maxWaitMs)'
        : '  (no DOM changes detected)'
    );
  }
  return lines.join('\n');
}

/** Token count of a string, cl100k_base (gpt-tokenizer) — a reproducible PROXY. */
export function tokenCount(text: string): number {
  return encode(text).length;
}

/** Serialize + measure in one call. */
export function render(delta: Delta): { text: string; tokens: number } {
  const text = serialize(delta);
  return { text, tokens: tokenCount(text) };
}
