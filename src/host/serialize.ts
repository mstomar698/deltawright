// Pin the encoding explicitly (cl100k_base): the package's default export changed
// its BPE across a major bump, which would silently move token counts. cl100k is an
// OpenAI proxy — the deployment tokenizer (Claude) differs — so treat absolute
// counts as approximate and RATIOS (delta vs snapshot/diff) as the robust signal.
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import type { Delta, DeltaNode, DiagnosedDelta } from './types';

export interface SerializeOptions {
  /**
   * Append an opt-in root-cause diagnostics section (from `diagnose()`). Default off —
   * with diagnostics off the output is BYTE-IDENTICAL to the pre-v0.6 serializer, so the
   * default `@playwright/test` path is unchanged.
   */
  diagnostics?: boolean;
}

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

  // #8: additive a11y-state annotations. `state:` shows the VALUE direction of a toggled state
  // attribute (aria-expanded false→true = "the menu is now open") that `changed:` names alone can't;
  // `live:` marks a change announced by a live region. Both absent → this line is byte-unchanged.
  if (node.stateChanges?.length) {
    // ∅ = attribute absent; "" = a present native boolean (disabled/open/…) whose value is the empty
    // string — quoted so it can't read as a truncated/blank value.
    const dir = (v: string | null) => (v === null ? '∅' : v === '' ? '""' : v);
    parts.push(
      `state:${node.stateChanges.map((s) => `${s.attr}=${dir(s.old)}→${dir(s.new)}`).join(',')}`,
    );
  }
  if (node.ariaLive) parts.push(`live:${node.ariaLive}`);

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
export function serialize(delta: Delta, opts: SerializeOptions = {}): string {
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
        : '  (no DOM changes detected)',
    );
  }

  // Opt-in only: with diagnostics off the lines above are the entire (unchanged) output.
  if (opts.diagnostics) {
    const diagnoses = (delta as DiagnosedDelta).diagnoses;
    if (diagnoses?.length) {
      lines.push('diagnostics:');
      for (const d of diagnoses) {
        const who = d.scope === 'node' && d.ref ? `[${d.ref}]` : '[*]';
        lines.push(`  ${who} ${d.code} (${d.confidence}) — ${d.detail}`);
      }
    }
  }
  return lines.join('\n');
}

/** Token count of a string, cl100k_base (gpt-tokenizer) — a reproducible PROXY. */
export function tokenCount(text: string): number {
  return encode(text).length;
}

/** Serialize + measure in one call. */
export function render(
  delta: Delta,
  opts: SerializeOptions = {},
): { text: string; tokens: number } {
  const text = serialize(delta, opts);
  return { text, tokens: tokenCount(text) };
}
