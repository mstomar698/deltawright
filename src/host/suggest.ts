import type { Delta, DeltaNode } from './types';

// New-test authoring aid (#57). A PURE function of a Delta — no Playwright, no I/O, never writes or
// modifies a test file — that suggests candidate selectors + assertions for the changed nodes, ranked
// getByRole > getByText > (testid) > css. It reuses the ONE actionability verdict already on the delta
// (only ACTIONABLE nodes get a `toBeActionable()` suggestion), introducing no second role/name mapping.
//
// HONESTY (load-bearing): every suggestion is a CANDIDATE to verify, not a durable/unique selector.
//  - `role`/`name` are the observer's heuristic reads (implicit-role map + aria-label→placeholder→text),
//    NOT Playwright's accessible-name/role algorithm, so `getByRole(role, { name })` may resolve
//    differently — warned.
//  - a `name` may be an aria-label (not visible text), so `getByText(name)` can miss — warned.
//  - a test-id attribute is NOT captured in the delta, so NO `getByTestId` is ever fabricated — warned.
//  - `suggest()` sees one delta in isolation, not the page, so it does NOT verify uniqueness or
//    stability across renders (the durable-selector problem is a separate investigation) — warned.
//  - the ephemeral `data-dw-ref` (e.g. `e1`) is NEVER offered as a selector — it is stripped on the
//    next action — and its ephemerality is warned.

export type SelectorTier = 'role' | 'text' | 'testid' | 'css';

export interface SelectorSuggestion {
  /** The changed node's ephemeral ref (for correlation only — NOT a selector). */
  ref: string;
  tier: SelectorTier;
  /** A ready-to-paste Playwright locator expression, e.g. `page.getByRole('button', { name: 'Save' })`. */
  code: string;
}

export interface AssertionSuggestion {
  ref: string;
  /** A ready-to-paste assertion, e.g. `await expect(page.getByRole('button', { name: 'Save' })).toBeActionable();`. */
  code: string;
}

export interface SuggestResult {
  assertions: AssertionSuggestion[];
  selectors: SelectorSuggestion[];
  /** Honesty caveats — every suggestion is a candidate to verify (see the module header). */
  warnings: string[];
}

/** Escape a string for a single-quoted JS literal (incl. line breaks — an aria-label / placeholder
 *  keeps its internal newlines, which would otherwise make the emitted code a syntax error). */
function q(s: string): string {
  return (
    "'" +
    s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') +
    "'"
  );
}

const TIER_RANK: Record<SelectorTier, number> = { role: 0, text: 1, testid: 2, css: 3 };

/** Candidate selectors for one node, best (role) → worst (css). `testid` is never emitted (not observed). */
function selectorsForNode(node: DeltaNode): SelectorSuggestion[] {
  const out: SelectorSuggestion[] = [];
  const { ref, role, name, tag } = node;

  // role tier (highest confidence): getByRole(role) + the name option when we have one.
  if (role) {
    const code = name
      ? `page.getByRole(${q(role)}, { name: ${q(name)} })`
      : `page.getByRole(${q(role)})`;
    out.push({ ref, tier: 'role', code });
  }
  // text tier: getByText(name) — only when there is a name (may be an aria-label, warned globally).
  if (name) {
    out.push({ ref, tier: 'text', code: `page.getByText(${q(name)})` });
  }
  // testid tier: intentionally EMPTY — the delta carries no test-id attribute, so fabricating a
  // getByTestId would be a lie. (Warned globally.)
  // css tier (lowest): the tag ALONE. The delta's `role` is the observer's RESOLVED role, which for
  // a native element (<button>, <a>, <input>, …) is implicit with NO `role=` attribute — so a
  // `tag[role="…"]` selector would match nothing. No class is persisted either, so the honest coarse
  // fallback is just the tag. (Warned coarse.)
  out.push({ ref, tier: 'css', code: `page.locator(${q(tag)})` });

  return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

/**
 * Suggest selectors + assertions for a delta's changed nodes. Pure — reads only the delta, writes
 * nothing, and never contradicts the actionability verdict already on each node.
 */
export function suggest(delta: Delta): SuggestResult {
  const selectors: SelectorSuggestion[] = [];
  const assertions: AssertionSuggestion[] = [];

  // Removed nodes have no live element to select/assert on; skip them.
  for (const node of delta.nodes) {
    if (node.kind === 'removed') continue;
    const sels = selectorsForNode(node);
    selectors.push(...sels);

    // toBeActionable() only for nodes Playwright confirmed ACTIONABLE — attached to the top (best)
    // selector. A NOT-actionable / n/a node gets selectors but NO actionability assertion.
    if (node.actionability.verdict === 'ACTIONABLE' && sels.length > 0) {
      assertions.push({
        ref: node.ref,
        code: `await expect(${sels[0]!.code}).toBeActionable();`,
      });
    }
  }

  const warnings = [
    'Every suggestion is a CANDIDATE to verify, not a durable or unique selector.',
    'role/name come from Deltawright’s heuristic read, not Playwright’s accessible-name/role algorithm — getByRole(role, { name }) may resolve to a different node; verify each.',
    'a `name` may be an aria-label rather than visible text, so getByText(name) can miss — prefer getByRole when a role is present.',
    'no getByTestId is suggested: a test-id attribute is not captured in the delta.',
    'suggest() sees one delta in isolation, not the page — it does NOT verify a selector is unique or stable across renders (the durable-selector problem is a separate investigation).',
    'the ephemeral `data-dw-ref` (e.g. e1) is NEVER a selector — it is stripped on the next action.',
  ];

  return { assertions, selectors, warnings };
}
