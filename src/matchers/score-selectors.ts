import type { Page, Frame } from '@playwright/test';
import {
  verifySuggestions,
  type VerifiedSelectorSuggestion,
  type VerifiedSuggestResult,
  type VerifySuggestionsOptions,
} from './verify-suggest';
import type { AssertionSuggestion } from '../host/suggest';
import type { Delta, DeltaNode, Rect } from '../host/types';

// R3 (Phase 3) — a DURABILITY recommender layered on `verifySuggestions`. verifySuggestions answers
// "does this candidate resolve UNIQUELY to the changed element on THIS page"; scoreSelectors adds
// "…and how likely is it to KEEP working" — a 0..100 durability ESTIMATE + brittleness flags + a
// delta-anchored geometry-relative fallback when nothing semantic verifies. It borrows Robula+'s
// generated-id/positional penalties and Similo's two-tier stability weighting as the scoring function.
//
// HONESTY (load-bearing, DW-03): durability is a SINGLE-PAGE ESTIMATE — a proxy for "how brittle does
// this selector look", NEVER a claim of stability across releases/renders. The only sound cross-render
// signal is a two-snapshot re-check, which is a deliberate follow-up (not fabricated here). Every
// caveat verifySuggestions carries is inherited. `bestDurable` is null (with a warning) rather than
// handing back a brittle selector as if it were durable. Playwright's uniqueness/identity verdict
// (from verifySuggestions) is authoritative and unchanged.

/** A band over the durability ESTIMATE (single page) — `durable` means "estimated low brittleness on
 *  THIS page", NOT a guarantee of stability across releases/re-renders. See `durability`. */
export type SelectorGrade = 'durable' | 'usable' | 'brittle' | 'broken';

export interface ScoredSelectorSuggestion extends VerifiedSelectorSuggestion {
  /** 0..100 durability ESTIMATE (single-page proxy — never "stable across releases"). */
  durability: number;
  /** Estimate band from `durability` (see {@link SelectorGrade}) — an estimate, not a guarantee. */
  grade: SelectorGrade;
  /** Brittleness/context flags: unstable-id · text-volatile · heuristic-role-unverified · tag-only ·
   *  ambiguous · wrong-element · no-match · geometry-relative · occluded · offscreen · not-actionable. */
  flags: string[];
  /** True when this candidate was SYNTHESIZED as a geometry-relative fallback (not from suggest()). */
  synthesized?: boolean;
}

export interface DurableSuggestResult {
  /** Re-ranked by (grade, durability, then verify/tier order). */
  selectors: ScoredSelectorSuggestion[];
  /** The highest-scoring candidate that is `verified` AND grade !== 'brittle', else null (+ a warning). */
  bestDurable: ScoredSelectorSuggestion | null;
  /** `toBeActionable()` assertions re-pointed onto each node's `bestDurable`; brittle/absent ones dropped. */
  assertions: AssertionSuggestion[];
  /** verifySuggestions' caveats + the durability-estimate caveats. */
  warnings: string[];
}

export interface ScoreSelectorsOptions extends VerifySuggestionsOptions {
  /** Synthesize a geometry-relative fallback for nodes where nothing semantic verifies. Default true. */
  geometryFallback?: boolean;
}

// --- brittleness detectors (Robula+ blacklist / Similo weighting, applied to the accessible NAME) ---

/** A clearly framework-GENERATED identifier (not a human-authored, stable string). Conservative on
 *  purpose — a human name with an incidental year ("Save 2024") must NOT trip it. */
function isGeneratedId(v: string): boolean {
  if (!v) return false;
  return (
    /gwt-uid-\d+/i.test(v) || // GWT
    /\bext-(comp|gen|element)-?\d+/i.test(v) || // ExtJS
    /_ng(content|host)?-?[a-z]?c?\d+/i.test(v) || // Angular _ngcontent-c14
    /^:r[0-9a-z]+:$/i.test(v) || // React useId ":r0:"
    /[-_][0-9a-f]{8,}\b/i.test(v) || // long hex hash suffix
    /\b[a-z]{2,}[-_]\d{4,}\b/i.test(v) // prefix-1234 (component-1012, item-10847, row-88231); 4+
    // digits keeps human names with a small numeric suffix (e.g. "plan-500", "step-100") off the list
  );
}

/** A volatile human name — digits/currency/date/very-long — where getByText/name is likely to drift. */
function isDynamicText(v: string): boolean {
  if (!v) return false;
  return (
    v.length > 40 ||
    /[$€£¥%]/.test(v) || // currency / percent
    /\b\d{1,2}[:/]\d{2}\b/.test(v) || // time / date
    /#\d+/.test(v) || // "#10847"
    /\b\d[\d.,]{2,}\b/.test(v) // a number ≥ 3 chars (1,234 · 12.50 · 100)
  );
}

const DURABLE_MIN = 70;
const USABLE_MIN = 40;

/** Score one verified candidate for durability. Pure — reads the candidate + its delta node. */
function scoreCandidate(
  cand: VerifiedSelectorSuggestion,
  node: DeltaNode | undefined,
  synthesized: boolean,
): { durability: number; grade: SelectorGrade; flags: string[] } {
  const flags: string[] = [];
  const name = node?.name ?? '';

  // (0) Tier base weight.
  let base: number;
  if (synthesized) {
    base = 15;
    flags.push('geometry-relative');
  } else if (cand.tier === 'role') {
    base = node?.name ? 100 : 75; // role+name is user-facing & refactor-durable; role-only is broad
  } else if (cand.tier === 'testid') {
    base = 90;
  } else if (cand.tier === 'text') {
    base = 70;
  } else {
    base = 35; // css: the bare tag (suggest emits no id/class) — structurally fragile
    flags.push('tag-only');
  }

  // (1) Uniqueness / identity — from verifySuggestions (Playwright-authoritative).
  switch (cand.status) {
    case 'verified':
      break;
    case 'unconfirmed':
      base *= 0.85;
      break;
    case 'ambiguous':
      base *= 0.3;
      flags.push('ambiguous');
      break;
    case 'unique-elsewhere':
      base *= 0.1;
      flags.push('wrong-element');
      break;
    case 'broken':
      return { durability: 0, grade: 'broken', flags: [...flags, 'no-match'] };
  }

  // (2) Name volatility — a role+name or text candidate whose NAME is generated/dynamic is brittle.
  if ((cand.tier === 'role' && node?.name) || cand.tier === 'text') {
    if (isGeneratedId(name)) {
      base *= 0.25;
      flags.push('unstable-id');
    } else if (cand.tier === 'text' && isDynamicText(name)) {
      base *= 0.5;
      flags.push('text-volatile');
    }
  }

  // (3) Heuristic-role discount — DW's role/name are not Playwright's ARIA algorithm, so an UNVERIFIED
  //     role candidate may resolve elsewhere.
  if (cand.tier === 'role' && cand.status !== 'verified') {
    base *= 0.7;
    flags.push('heuristic-role-unverified');
  }

  // (4) Geometry / actionability context (DW-native) — annotations, not score changes beyond the above.
  if (node?.geometry?.coveredBy) flags.push('occluded');
  if (node?.geometry?.offscreen) flags.push('offscreen');
  if (node && node.actionability.verdict === 'NOT-actionable') flags.push('not-actionable');

  const durability = Math.max(0, Math.min(100, Math.round(base)));
  const grade: SelectorGrade =
    durability >= DURABLE_MIN ? 'durable' : durability >= USABLE_MIN ? 'usable' : 'brittle';
  return { durability, grade, flags };
}

const GRADE_RANK: Record<SelectorGrade, number> = { durable: 0, usable: 1, brittle: 2, broken: 3 };

function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Escape a string for a double-quoted Playwright text-engine literal. */
function dq(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const DEFAULT_CONCURRENCY = 12;

/** Order-preserving bounded-concurrency map (mirrors verifySuggestions' fan-out). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * Score `verifySuggestions` candidates for durability, synthesize a delta-anchored geometry-relative
 * fallback when nothing semantic verifies, and honestly flag brittleness. Call RIGHT AFTER
 * `actAndObserve` (it needs the delta's live `data-dw-ref` markers, which the next action clears).
 * Durability is a single-page ESTIMATE — never a cross-release stability claim.
 */
export async function scoreSelectors(
  root: Page | Frame,
  delta: Delta,
  opts: ScoreSelectorsOptions = {},
): Promise<DurableSuggestResult> {
  const base: VerifiedSuggestResult = await verifySuggestions(root, delta, opts);
  const byRef = new Map(delta.nodes.map((n) => [n.ref, n] as const));

  const scored: ScoredSelectorSuggestion[] = base.selectors.map((cand) => {
    const s = scoreCandidate(cand, byRef.get(cand.ref), false);
    return { ...cand, durability: s.durability, grade: s.grade, flags: s.flags };
  });

  // Geometry-relative fallback (opt-in, default on): for each node with NO verified candidate, anchor a
  // layout locator on the NEAREST node that DID verify uniquely and has a usable text name, then run
  // that synthesized locator back through the same verify path. Last-resort + honestly flagged.
  const warnings = [...base.warnings];
  if (opts.geometryFallback !== false) {
    const verifiedByRef = new Set(scored.filter((s) => s.verified).map((s) => s.ref));
    // Anchors: verified, named, on-screen, non-occluded nodes with geometry.
    const anchors = delta.nodes.filter(
      (n) =>
        verifiedByRef.has(n.ref) &&
        n.name &&
        n.geometry &&
        !n.geometry.offscreen &&
        !n.geometry.coveredBy,
    );
    // Targets: nodes with geometry and NO verified candidate (and not removed).
    const targets = delta.nodes.filter(
      (n) => n.kind !== 'removed' && n.geometry && !verifiedByRef.has(n.ref),
    );
    // Bounded-concurrent (honors the advertised `concurrency`) — each target is isolated: a detached
    // page/frame drops THAT target to a broken candidate, never aborting the whole scan.
    const synthesized = await mapWithConcurrency(
      targets,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      async (target): Promise<ScoredSelectorSuggestion | null> => {
        const tc = centerOf(target.geometry!.rect);
        let nearest: DeltaNode | null = null;
        let bestDist = Infinity;
        for (const a of anchors) {
          if (a.ref === target.ref) continue;
          const ac = centerOf(a.geometry!.rect);
          const d = (ac.x - tc.x) ** 2 + (ac.y - tc.y) ** 2;
          if (d < bestDist) {
            bestDist = d;
            nearest = a;
          }
        }
        if (!nearest || !nearest.name) return null;
        // Playwright layout engine: `<tag>:near(:text("anchor"))`. Re-verified below; if it does not
        // resolve uniquely to the target it is simply graded low (never presented as durable).
        const selector = `${target.tag}:near(:text(${dq(nearest.name)}))`;
        const code = `page.locator(${JSON.stringify(selector)})`;
        let matches = 0;
        let sameAsRef = 0;
        let refPresent = false;
        try {
          // ALL page round-trips guarded together (incl. the ref-presence probe), so a mid-scan
          // detach drops this one target rather than rejecting scoreSelectors.
          refPresent = (await root.locator(`[data-dw-ref="${target.ref}"]`).count()) > 0;
          const loc = root.locator(selector);
          matches = await loc.count();
          if (matches > 0 && refPresent) {
            sameAsRef = await loc.and(root.locator(`[data-dw-ref="${target.ref}"]`)).count();
          }
        } catch {
          // a detached page/frame or invalid layout selector — the init values (0/0/false) stand.
        }
        const unique = matches === 1;
        const verified = unique && refPresent && sameAsRef >= 1;
        const status = verified
          ? ('verified' as const)
          : matches > 1
            ? ('ambiguous' as const)
            : matches === 1
              ? refPresent
                ? ('unique-elsewhere' as const)
                : ('unconfirmed' as const)
              : ('broken' as const);
        const candidate: VerifiedSelectorSuggestion = {
          ref: target.ref,
          tier: 'css',
          code,
          matches,
          unique,
          verified,
          status,
        };
        const s = scoreCandidate(candidate, target, true);
        return {
          ...candidate,
          durability: s.durability,
          grade: s.grade,
          flags: s.flags,
          synthesized: true,
        };
      },
    );
    for (const s of synthesized) if (s) scored.push(s);
  }

  // Re-rank by grade, then durability, then the verify/tier order that produced them (stable).
  const selectors = scored
    .map((v, i) => ({ v, i }))
    .sort(
      (a, b) =>
        GRADE_RANK[a.v.grade] - GRADE_RANK[b.v.grade] ||
        b.v.durability - a.v.durability ||
        a.i - b.i,
    )
    .map(({ v }) => v);

  // bestDurable = the top candidate that is verified AND not brittle. Never a brittle handoff.
  const bestDurable = selectors.find((s) => s.verified && s.grade !== 'brittle') ?? null;

  // Re-point assertions onto each node's bestDurable (verified + not brittle); drop the rest.
  const bestByRef = new Map<string, ScoredSelectorSuggestion>();
  for (const s of selectors)
    if (s.verified && s.grade !== 'brittle' && !bestByRef.has(s.ref)) bestByRef.set(s.ref, s);
  const assertions: AssertionSuggestion[] = [];
  let dropped = 0;
  for (const a of base.assertions) {
    // base.assertions were re-pointed onto verified selectors by verifySuggestions; keep only those
    // whose node also has a NON-brittle durable selector.
    const best = bestByRef.get(a.ref);
    if (best) assertions.push({ ref: a.ref, code: `await expect(${best.code}).toBeActionable();` });
    else dropped++;
  }

  warnings.push(
    'scoreSelectors: `durability` is a SINGLE-PAGE ESTIMATE (a brittleness proxy), NOT a guarantee of stability across releases or re-renders — the only sound cross-render signal is a two-snapshot re-check.',
  );
  if (base.selectors.length > 0 && !bestDurable) {
    warnings.push(
      'scoreSelectors: no verified candidate graded above `brittle` on this page — hand-author a durable handle (staying unsure) rather than shipping a brittle one.',
    );
  }
  if (dropped > 0) {
    warnings.push(
      `scoreSelectors: dropped ${dropped} suggested assertion(s) whose node has no non-brittle durable selector.`,
    );
  }

  return { selectors, bestDurable, assertions, warnings };
}
