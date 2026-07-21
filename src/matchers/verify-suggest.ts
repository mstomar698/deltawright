import type { Page, Frame, Locator } from '@playwright/test';
import { suggest, type SelectorSuggestion, type AssertionSuggestion } from '../host/suggest';
import type { Delta, DeltaNode } from '../host/types';

// Durable-selector recommender (Wave-2 #6) — the PAGE-AWARE layer over the pure `suggest()` that #57
// explicitly punted. `suggest()` proposes selectors from one delta in isolation and cannot know if a
// candidate is unique or even resolves; this rounds each candidate through the LIVE page:
//   • `locator.count()` — how many elements it matches (0 = broken, >1 = ambiguous).
//   • same-element identity — does it resolve to the SAME element the delta captured? Cross-referenced
//     against `[data-dw-ref="<ref>"]` via Playwright's `.and()` combinator (page-authoritative).
// Verified-unique candidates are promoted to a paste-ready `bestVerified`; the rest are demoted with
// their match counts, never hidden. HONESTY (DW-03): if nothing resolves uniquely to the changed
// element, `bestVerified` is null and a warning says so — we stay unsure rather than hand back an
// ambiguous locator as if it were durable. A candidate that matches uniquely but whose delta ref is
// gone is `unconfirmed` (identity could not be checked), NOT asserted to be the wrong element.
//
// SCOPE (honest limit): "stability" here is single-page uniqueness + same-element identity. TRUE
// cross-render stability would need a stored selector history across deltas, which the codebase does
// not have — so it is out of reach without new plumbing and is not claimed. `suggest()` stays pure and
// UNCHANGED; this impure layer sits on top.

export type VerifyStatus =
  | 'verified' // matches exactly 1 element, and it IS the delta's element
  | 'ambiguous' // matches >1 elements
  | 'unique-elsewhere' // matches exactly 1, ref present, but a DIFFERENT element
  | 'unconfirmed' // matches exactly 1, but the delta's ref is gone → identity unverifiable
  | 'broken'; // matches 0 elements

export interface VerifiedSelectorSuggestion extends SelectorSuggestion {
  /** How many live elements the candidate resolves to (`locator.count()`). */
  matches: number;
  /** `matches === 1`. */
  unique: boolean;
  /** `matches === 1` AND that element is the delta node this candidate came from. */
  verified: boolean;
  /** verified · ambiguous · unique-elsewhere · unconfirmed · broken. */
  status: VerifyStatus;
}

export interface VerifiedSuggestResult {
  /** Re-ranked verified-first (then by status); ties keep `suggest()`'s tier order. */
  selectors: VerifiedSelectorSuggestion[];
  /**
   * `toBeActionable()` assertions RE-POINTED to each node's verified selector — only for nodes that
   * have one. An assertion whose node had no verified selector is dropped (a warning lists them), so
   * this never hands back an assertion built on a selector it just proved ambiguous/broken.
   */
  assertions: AssertionSuggestion[];
  /** `suggest()`'s honesty caveats plus DW-03 notes (nothing verified / refs absent / assertions dropped). */
  warnings: string[];
  /** The first verified-unique candidate (verified nodes first, then `suggest()`'s tier order), or null. */
  bestVerified: VerifiedSelectorSuggestion | null;
}

export interface VerifySuggestionsOptions {
  /** Bound on concurrent `count()` round-trips (default 12), mirroring the reconcile fan-out. */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 12;
const STATUS_RANK: Record<VerifyStatus, number> = {
  verified: 0,
  unconfirmed: 1, // single match, identity unknown — likelier useful than an ambiguous >1
  ambiguous: 2,
  'unique-elsewhere': 3,
  broken: 4,
};

/** Order-preserving bounded-concurrency map (count() is cheap, but a large delta yields many). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  });
  await Promise.all(workers);
  return out;
}

/** Rebuild the live Locator for a candidate from its delta node + tier (mirrors `selectorsForNode`). */
export function locatorFor(
  root: Page | Frame,
  tier: SelectorSuggestion['tier'],
  node: DeltaNode,
): Locator | null {
  switch (tier) {
    case 'role': {
      if (!node.role) return null;
      // role came from the observer and may not be a valid ARIA role; Playwright validates it when the
      // locator resolves (an unknown role throws → caught → 0 matches).
      const role = node.role as Parameters<Page['getByRole']>[0];
      return node.name ? root.getByRole(role, { name: node.name }) : root.getByRole(role);
    }
    case 'text':
      return node.name ? root.getByText(node.name) : null;
    case 'css':
      return root.locator(node.tag);
    case 'testid':
      return null; // suggest() never emits a testid today — nothing to resolve
  }
}

/**
 * Verify each `suggest(delta)` candidate against the live page and return them re-ranked verified-first.
 * Call this RIGHT AFTER `actAndObserve` — it matches candidates against the delta's `data-dw-ref`,
 * which the observer clears on the next action; if a node's ref is gone, its uniquely-matching
 * candidate is `unconfirmed` (identity unverifiable), not falsely asserted to be the wrong element.
 */
export async function verifySuggestions(
  root: Page | Frame,
  delta: Delta,
  opts: VerifySuggestionsOptions = {},
): Promise<VerifiedSuggestResult> {
  const base = suggest(delta);
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  // Probe ref-PRESENCE per node up front, INDEPENDENT of whether any candidate matches — so an
  // all-broken node with refs still on the page is never misreported as a "called too late" timing
  // problem, and a node whose ref is genuinely gone is marked unconfirmed rather than "wrong element".
  const distinctRefs = [...new Set(base.selectors.map((s) => s.ref))];
  const refCountEntries = await mapWithConcurrency(distinctRefs, concurrency, async (ref) => {
    try {
      return [ref, await root.locator(`[data-dw-ref="${ref}"]`).count()] as const;
    } catch {
      return [ref, 0] as const;
    }
  });
  const refCountByRef = new Map(refCountEntries);
  const anyRefPresent = refCountEntries.some(([, c]) => c > 0);

  const verified = await mapWithConcurrency(
    base.selectors,
    concurrency,
    async (s): Promise<VerifiedSelectorSuggestion> => {
      const node = byRef.get(s.ref);
      const loc = node ? locatorFor(root, s.tier, node) : null;
      const refPresent = (refCountByRef.get(s.ref) ?? 0) > 0;
      let matches = 0;
      let sameAsRef = 0;
      if (loc) {
        try {
          matches = await loc.count();
          if (matches > 0 && refPresent) {
            sameAsRef = await loc.and(root.locator(`[data-dw-ref="${s.ref}"]`)).count();
          }
        } catch {
          matches = 0; // invalid role / selector resolves to nothing
        }
      }
      const unique = matches === 1;
      const verifiedFlag = unique && refPresent && sameAsRef >= 1;
      const status: VerifyStatus = verifiedFlag
        ? 'verified'
        : matches > 1
          ? 'ambiguous'
          : matches === 1
            ? refPresent
              ? 'unique-elsewhere' // ref is on the page, so this really is a DIFFERENT element
              : 'unconfirmed' // ref is gone → can't confirm it's wrong OR right
            : 'broken';
      return { ...s, matches, unique, verified: verifiedFlag, status };
    },
  );

  // Stable re-rank: verified first, then by status, preserving suggest()'s within-status tier order.
  const selectors = verified
    .map((v, i) => ({ v, i }))
    .sort((a, b) => STATUS_RANK[a.v.status] - STATUS_RANK[b.v.status] || a.i - b.i)
    .map(({ v }) => v);

  const bestVerified = selectors.find((v) => v.verified) ?? null;

  // The first verified candidate PER node (in suggest()'s tier order) → re-point that node's assertion.
  const bestVerifiedByRef = new Map<string, VerifiedSelectorSuggestion>();
  for (const v of verified)
    if (v.verified && !bestVerifiedByRef.has(v.ref)) bestVerifiedByRef.set(v.ref, v);

  // Re-point each suggest() assertion onto its node's VERIFIED selector; drop those with none.
  const assertions: AssertionSuggestion[] = [];
  let droppedAssertions = 0;
  for (const a of base.assertions) {
    const best = bestVerifiedByRef.get(a.ref);
    if (best) assertions.push({ ref: a.ref, code: `await expect(${best.code}).toBeActionable();` });
    else droppedAssertions++;
  }

  const warnings = [...base.warnings];
  if (base.selectors.length > 0 && !bestVerified) {
    warnings.push(
      'verifySuggestions: no candidate resolves uniquely to the changed element on this page — hand-verify (staying unsure).',
    );
  }
  if (base.selectors.length > 0 && !anyRefPresent) {
    warnings.push(
      "verifySuggestions: none of the delta's data-dw-ref markers are on the page (they are cleared on the next actAndObserve), so same-element identity could not be confirmed — call this right after actAndObserve.",
    );
  }
  if (droppedAssertions > 0) {
    warnings.push(
      `verifySuggestions: dropped ${droppedAssertions} suggested assertion(s) whose selector did not verify uniquely — build them from a verified selector instead.`,
    );
  }

  return { selectors, assertions, warnings, bestVerified };
}
