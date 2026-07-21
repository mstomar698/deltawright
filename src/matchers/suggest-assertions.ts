import type { Page, Frame, Locator } from '@playwright/test';
import {
  scoreSelectors,
  type ScoreSelectorsOptions,
  type ScoredSelectorSuggestion,
  type SelectorGrade,
} from './score-selectors';
import { locatorFor } from './verify-suggest';
import type { Delta, DeltaNode } from '../host/types';

// Delta→assertion synthesis (testgen A) — turn the OBSERVED state transition in a delta into candidate,
// live-verified Playwright assertions, bound to a durable selector. Codegen records actions but NOT
// assertions (the oracle gap), and even Playwright has no feature that maps an observed aria/state
// transition to the right assertion method — you hand-write it. DW is the only layer that knows the
// old→new TRANSITION (the a11y tree shows static state, never the edge), so it can answer "what should
// I assert here?" from the delta's own pre/post comparison.
//
// HONESTY (the firewall line for testgen): a GENERATOR produces the artifact and owns its correctness;
// DW GROUNDS the author/agent who produces it. Every assertion here is a CANDIDATE from ONE observed
// delta, bound to a Playwright-verified durable selector, live-re-read so it isn't handed back if it no
// longer holds, and flagged `transient` if the state already reverted. DW-02 — it emits `expect(...)`
// CODE; Playwright's `expect` runs it and is authoritative (DW runs no assertion engine). DW-03 — the
// transition HAPPENED; DW never claims it was correct/intended (co-occurrence ≠ the spec), and never
// suppresses a reverted transition (surfaces it flagged). DW-04 — a closed transition→assertion map;
// an unmapped transition yields no assertion. It NEVER writes/owns/re-runs a test file.

/** A single quote-escaped JS string literal (mirrors suggest.ts's `q`). */
function q(s: string): string {
  return (
    "'" +
    s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') +
    "'"
  );
}

export interface SynthesizedAssertion {
  /** The changed node's ephemeral ref (correlation only). */
  ref: string;
  /** Paste-ready assertion, bound to the node's durable selector. */
  code: string;
  /** What the assertion asserts about. */
  kind: 'state' | 'presence' | 'text' | 'actionability';
  /** The observed transition this assertion encodes (human-readable). */
  from: string;
  /** Did the asserted condition still hold on an INDEPENDENT live re-read? `true`/`false` only for the
   *  `state` and `presence` kinds (re-read via getAttribute/isChecked/isVisible/count). `null` for `text`
   *  (its assertion is populated FROM the live region — there is no independent oracle) and for
   *  `actionability` (it carries the delta's action-time verdict, not a fresh re-read). */
  holds: boolean | null;
  /** True when a live-re-read transition has since reverted (`holds === false`) — assert with care. */
  transient: boolean;
  /** Durability grade of the bound selector (from scoreSelectors); null when no selector was scored for it
   *  (a removed-node count assertion, or a folded actionability assertion with no bound candidate). */
  selectorGrade: SelectorGrade | null;
}

export interface AssertionSynthesisResult {
  /** Candidate assertions, verified-and-holding first, then the rest (transient / unverifiable last). */
  assertions: SynthesizedAssertion[];
  /** scoreSelectors' caveats + the assertion-synthesis honesty caveats. */
  warnings: string[];
}

export type SuggestAssertionsOptions = ScoreSelectorsOptions;

/** A candidate assertion template for one node: the code (given the bound selector) + a live re-read. */
interface AssertionTemplate {
  kind: SynthesizedAssertion['kind'];
  from: string;
  code: (sel: string) => string;
  /** Live re-read against the bound locator: does the asserted condition hold right now? */
  check: (loc: Locator) => Promise<boolean>;
}

/** State-attribute transitions (aria-expanded / aria-checked / disabled / aria-disabled / other). */
function stateTemplates(node: DeltaNode): AssertionTemplate[] {
  const out: AssertionTemplate[] = [];
  for (const sc of node.stateChanges ?? []) {
    const nv = sc.new;
    if (sc.attr === 'aria-expanded' && (nv === 'true' || nv === 'false')) {
      const expanded = nv === 'true';
      out.push({
        kind: 'state',
        from: `aria-expanded → ${nv}`,
        code: (s) => `await expect(${s}).toBeExpanded(${expanded ? '' : '{ expanded: false }'});`,
        check: async (loc) => (await loc.getAttribute('aria-expanded')) === nv,
      });
    } else if (
      sc.attr === 'aria-checked' &&
      (node.role === 'checkbox' || node.role === 'radio') &&
      (nv === 'true' || nv === 'false')
    ) {
      // toBeChecked() is only valid for checkbox/radio (it errors on ARIA `switch`); other roles fall
      // through to the generic toHaveAttribute below.
      const checked = nv === 'true';
      out.push({
        kind: 'state',
        from: `aria-checked → ${nv}`,
        code: (s) => `await expect(${s}).toBeChecked(${checked ? '' : '{ checked: false }'});`,
        check: async (loc) => (await loc.isChecked()) === checked,
      });
    } else if (sc.attr === 'disabled') {
      const disabled = nv !== null;
      out.push({
        kind: 'state',
        from: `disabled ${disabled ? 'added' : 'removed'}`,
        code: (s) => `await expect(${s}).${disabled ? 'toBeDisabled' : 'toBeEnabled'}();`,
        check: async (loc) => (await loc.isDisabled()) === disabled,
      });
    } else if (nv !== null) {
      // Any other allowlisted state attr (aria-disabled/selected/pressed/…): assert the attribute value
      // directly — the honest, role-agnostic form (no toBeChecked switch-role trap).
      out.push({
        kind: 'state',
        from: `${sc.attr} → ${nv}`,
        code: (s) => `await expect(${s}).toHaveAttribute(${q(sc.attr)}, ${q(nv)});`,
        check: async (loc) => (await loc.getAttribute(sc.attr)) === nv,
      });
    }
  }
  return out;
}

/** Presence transition: a dialog/alertdialog appeared → toBeVisible(). (Removals are handled separately.) */
function presenceTemplates(node: DeltaNode): AssertionTemplate[] {
  if (node.kind === 'added' && (node.role === 'dialog' || node.role === 'alertdialog')) {
    return [
      {
        kind: 'presence',
        from: `a role=${node.role} appeared`,
        code: (s) => `await expect(${s}).toBeVisible();`,
        check: (loc) => loc.isVisible(),
      },
    ];
  }
  return [];
}

/** Did an aria-live region announce text on this action? (The text itself is read live — the observer
 *  does not always surface a status/alert region's announced text as the node's accessible name.) */
function isAnnouncement(node: DeltaNode): boolean {
  return !!node.ariaLive && (node.kind === 'textChanged' || node.kind === 'added');
}

/** Cap the read announced text so a candidate assertion never carries an unbounded/PII-heavy blob. */
const MAX_ANNOUNCED_LEN = 120;

/** Rebuild the live locator for a bound candidate (mirrors measureRetention/verifySuggestions). */
function locatorForNode(
  root: Page | Frame,
  cand: ScoredSelectorSuggestion,
  node: DeltaNode,
): Locator | null {
  if (cand.synthesized && cand.rawSelector) return root.locator(cand.rawSelector);
  return locatorFor(root, cand.tier, node);
}

/**
 * Synthesize candidate, live-verified assertions from a delta's observed transitions, each bound to a
 * durable selector (via {@link scoreSelectors}). Call RIGHT AFTER `actAndObserve` (it needs the delta's
 * live `data-dw-ref` markers, cleared on the next action). DW grounds the author — it does not author,
 * own, or vouch for the test; assert a candidate only if the transition is what you intended.
 */
export async function suggestAssertions(
  root: Page | Frame,
  delta: Delta,
  opts: SuggestAssertionsOptions = {},
): Promise<AssertionSynthesisResult> {
  const scored = await scoreSelectors(root, delta, opts);
  // Per-ref best VERIFIED selector (prefer non-brittle) to bind assertions onto — mirrors how
  // scoreSelectors re-points its own toBeActionable assertions.
  const bestByRef = new Map<string, (typeof scored.selectors)[number]>();
  for (const s of scored.selectors) {
    if (!s.verified) continue;
    const cur = bestByRef.get(s.ref);
    if (!cur || (cur.grade === 'brittle' && s.grade !== 'brittle')) bestByRef.set(s.ref, s);
  }

  const assertions: SynthesizedAssertion[] = [];
  let dropped = 0;

  for (const node of delta.nodes) {
    if (node.kind === 'removed') {
      // A removed node has no live element to bind a durable selector to. If it had a role+name, the
      // honest post-condition is "it's gone" — a role/name locator that now resolves to zero.
      if (node.role && node.name) {
        const sel = `page.getByRole(${q(node.role)}, { name: ${q(node.name)} })`;
        const loc = locatorFor(root, 'role', node);
        let holds: boolean | null = null;
        try {
          if (loc) holds = (await loc.count()) === 0;
        } catch {
          holds = null;
        }
        assertions.push({
          ref: node.ref,
          code: `await expect(${sel}).toHaveCount(0);`,
          kind: 'presence',
          from: 'the node was removed',
          holds,
          transient: holds === false,
          selectorGrade: null, // no selector was durability-scored for a removed node
        });
      }
      continue;
    }

    const templates = [...stateTemplates(node), ...presenceTemplates(node)];
    const announced = isAnnouncement(node);
    if (templates.length === 0 && !announced) continue;

    const best = bestByRef.get(node.ref);
    if (!best) {
      // No verified durable selector → we won't hand back an assertion on a selector we couldn't bind.
      dropped += templates.length + (announced ? 1 : 0);
      continue;
    }
    const loc = locatorForNode(root, best, node);
    for (const t of templates) {
      let holds: boolean | null = null;
      try {
        if (loc) holds = await t.check(loc);
      } catch {
        holds = null; // detached / not applicable — surface as unverifiable, never a false hold
      }
      assertions.push({
        ref: node.ref,
        code: t.code(best.code),
        kind: t.kind,
        from: t.from,
        holds,
        transient: holds === false,
        selectorGrade: best.grade,
      });
    }

    // Announcement (aria-live) → toContainText(<announced text>). The observer does not reliably surface
    // the announced text as a name, so read it LIVE from the bound region and offer it as the candidate
    // text the author would otherwise hand-write. holds is null (NOT true): the assertion is populated
    // FROM the region's live text, so re-asserting it contains that text is tautological — there is no
    // independent oracle. The author confirms it is the message they meant.
    if (announced && loc) {
      let text = '';
      try {
        // Code-point-safe truncation (never split a surrogate pair into a lone half in the emitted code).
        text = Array.from(((await loc.textContent()) ?? '').trim())
          .slice(0, MAX_ANNOUNCED_LEN)
          .join('');
      } catch {
        // detached / unreadable region — leave text empty so no announcement assertion is emitted
      }
      if (text) {
        assertions.push({
          ref: node.ref,
          code: `await expect(${best.code}).toContainText(${q(text)});`,
          kind: 'text',
          from: `aria-live=${node.ariaLive} announced text`,
          holds: null, // populated from the live region — not an independent re-verification
          transient: false,
          selectorGrade: best.grade,
        });
      }
    }
  }

  // Fold in scoreSelectors' already-durable toBeActionable assertions as the actionability family. holds
  // is null: this carries the delta's ACTION-TIME verdict (Playwright-authoritative, DW-02), not a fresh
  // independent re-read like the state/presence kinds — so `holds:true` keeps one meaning across the set.
  for (const a of scored.assertions) {
    assertions.push({
      ref: a.ref,
      code: a.code,
      kind: 'actionability',
      from: 'the node was actionable at action time',
      holds: null,
      transient: false,
      selectorGrade: bestByRef.get(a.ref)?.grade ?? null,
    });
  }

  // Rank: holding first, then transient/unverifiable; stable within.
  const rankOf = (x: SynthesizedAssertion) => (x.holds === true ? 0 : x.holds === null ? 1 : 2);
  const ranked = assertions
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rankOf(a.v) - rankOf(b.v) || a.i - b.i)
    .map(({ v }) => v);

  const warnings = [...scored.warnings];
  warnings.push(
    'suggestAssertions: every assertion is a CANDIDATE synthesized from ONE observed transition — DW grounds the author, it does not author, own, or run the test. Assert it only if the transition is what you intended; Playwright’s expect stays authoritative.',
  );
  const transientCount = ranked.filter((a) => a.transient).length;
  if (transientCount > 0) {
    warnings.push(
      `suggestAssertions: ${transientCount} assertion(s) are \`transient\` — the observed state has already reverted on a live re-read, so it was NOT a stable post-condition (surfaced, not dropped).`,
    );
  }
  if (dropped > 0) {
    warnings.push(
      `suggestAssertions: dropped ${dropped} candidate assertion(s) whose node had no verified durable selector to bind to.`,
    );
  }

  return { assertions: ranked, warnings };
}
