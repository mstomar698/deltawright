import { chromium, type Browser, type Page } from '@playwright/test';
import { actAndObserve, render, diagnose } from '../index';
import { preflight } from '../matchers/actionable';
import { observeConsequences } from '../wait';
import { summarizeDiagnoses } from '../host/summarize';
import type { Verdict } from '../host/types';
import type { Confidence } from '../host/confidence';
import type { RootCauseCategory, RootCauseCode } from '../host/taxonomy';

// A long-lived browser session behind the MCP server. Kept separate from the server
// so the actual logic is unit-testable without the stdio protocol.
//
// The #60 agent-assist debug methods (preflightSelector / observeSettle / explainDelta /
// diagnoseAction) are LIVE-REPRODUCE: they drive THIS session's own browser and diagnose what
// happens here. They do NOT — and cannot — read the user's live Playwright test run; the session
// has no handle on that process. None mutates a test or "fixes" a flake; they only observe + explain.

export type McpAction =
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  // Char-by-char typing (v0.9 Move 1): `pressSequentially` dispatches a real key event per
  // character, so it exercises per-keystroke widgets (a GWT SuggestBox) that a bulk `.value` set
  // from `fill` bypasses. Threaded through the same input-integrity check as `fill`.
  | { kind: 'type'; selector: string; value: string }
  | { kind: 'select'; selector: string; value: string }
  | { kind: 'check'; selector: string }
  | { kind: 'press'; selector: string; key: string };

/** The live-reproduce disclaimer stamped on every #60 debug result — it is THIS session, not your run. */
export const LIVE_REPRODUCE_NOTE =
  'live-reproduce in this MCP browser session — this does NOT read your Playwright test run';

/**
 * Run a debug-tool body and, if it THROWS, rethrow with the live-reproduce disclaimer appended. The
 * debug tools exist to probe FAILING actions, so the throwing path is the PRIMARY one — a failed
 * action's error (a timeout, a bad selector) must never be mistaken for the user's OWN failing-test
 * error. On success the body returns unchanged (the note is already on the result object/text).
 */
async function withLiveReproduceNote<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n\n(${LIVE_REPRODUCE_NOTE})`, { cause: err });
  }
}

/** #60 preflight: Playwright's authoritative actionability verdict for one selector, here and now. */
export interface PreflightReport {
  selector: string;
  /** Playwright's AUTHORITATIVE verdict (geometry never flips it, DW-02). */
  verdict: Verdict;
  reason: string | null;
  geometryVerdict: Verdict;
  agreed: boolean;
  note: string;
}

/** #60 observe_settle: the settle signal for one action (NOT a readiness guarantee). */
export interface SettleReport {
  settleMs: number;
  hitMaxWait: boolean;
  suspectedEarly: boolean;
  observed: boolean;
  skippedReason?: string;
  note: string;
}

/** #60 diagnose: the gated taxonomy read for one action's delta, Playwright-authoritative. */
export interface DiagnoseReport {
  action: string;
  /** Taxonomy category of the gated cause, or null when unsure / the `unknown` bucket. */
  category: RootCauseCategory | null;
  confidence: Confidence;
  /** True when no cause crossed the confidence gate — `unsure` beats confidently-wrong (DW-03). */
  unsure: boolean;
  /** Geometry↔Playwright disagreed on some changed node (kept a hypothesis, DW-02). */
  geomDisagreement: boolean;
  cause: RootCauseCode | 'unsure';
  detail: string;
  /**
   * The changed node's Playwright-authoritative verdict the cause is grounded in. It is the `n/a`
   * sentinel when `unsure` AND also for a NAMED delta-scope cause (e.g. a `suspected` settle-timeout /
   * late-wave that has no single node ref) — so key "is there a grounded node verdict" off `verdict`,
   * NOT off `unsure`.
   */
  verdict: Verdict;
  note: string;
}

function describe(action: McpAction): string {
  switch (action.kind) {
    // fill/type carry a FREE-TEXT value that may be a password or PII. It becomes `delta.action`,
    // which render()/serialize print — so, consistent with the input-integrity stat storing only
    // lengths, the label REDACTS the value to its length rather than echoing plaintext (privacy).
    case 'fill':
      return `fill "${action.selector}" = <${action.value.length} chars>`;
    case 'type':
      return `type "${action.selector}" = <${action.value.length} chars>`;
    // A select value is a bounded, DOM-visible option identifier (not a typed secret), so it is kept.
    case 'select':
      return `select "${action.selector}" = ${JSON.stringify(action.value)}`;
    case 'press':
      return `press ${action.key} on "${action.selector}"`;
    default:
      return `${action.kind} "${action.selector}"`;
  }
}

/**
 * Read a field's committed value after the settle window (v0.9 Move 1). Handles standard form
 * controls (`value`) and contenteditable/rich widgets (`textContent`), so a GWT rich-text field is
 * covered too. Best-effort with a short timeout; the caller treats a throw as "could not read".
 */
async function readCommittedValue(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((el) => {
    const input = el as HTMLInputElement;
    if (typeof input.value === 'string') return input.value;
    return el.textContent ?? '';
  });
}

/** The input-integrity option for a value-bearing action (fill/type), else undefined (v0.9 Move 1). */
function inputIntegrityFor(action: McpAction) {
  if (action.kind !== 'fill' && action.kind !== 'type') return undefined;
  return {
    intended: action.value,
    readCommitted: (page: Page) => readCommittedValue(page, action.selector),
  };
}

async function perform(page: Page, action: McpAction): Promise<void> {
  const locator = page.locator(action.selector);
  switch (action.kind) {
    case 'click':
      await locator.click();
      break;
    case 'fill':
      await locator.fill(action.value);
      break;
    case 'type':
      await locator.pressSequentially(action.value);
      break;
    case 'select':
      await locator.selectOption(action.value);
      break;
    case 'check':
      await locator.check();
      break;
    case 'press':
      await locator.press(action.key);
      break;
  }
}

export class DeltawrightSession {
  private browser?: Browser;
  private page?: Page;

  private async ensurePage(): Promise<Page> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    if (!this.page)
      this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    return this.page;
  }

  /** Navigate and return the initial full accessibility snapshot (the starting map). */
  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();
    await page.goto(url);
    const snap = await page.locator('body').ariaSnapshot();
    return `navigated to ${url}\n\n${snap}`;
  }

  /**
   * Perform ONE action and return the compact delta — the core value: what changed,
   * where, and whether the agent can act on it, with no before/after snapshot.
   */
  async act(action: McpAction): Promise<string> {
    const page = await this.ensurePage();
    const delta = await actAndObserve(page, (p) => perform(p, action), {
      label: describe(action),
      inputIntegrity: inputIntegrityFor(action),
    });
    const { text, tokens } = render(delta);
    const dropped = delta.stats.droppedBackground
      ? `, ${delta.stats.droppedBackground} background changes filtered`
      : '';
    return `${text}\n\n(${tokens} tokens${dropped})`;
  }

  /** The full accessibility snapshot — the fallback when a full map is needed. */
  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    return page.locator('body').ariaSnapshot();
  }

  // --- #60 agent-assist debug (LIVE-REPRODUCE over THIS session's browser) -------------------------
  // All four reproduce here and diagnose what happens; none reads the user's live run or mutates it.

  /**
   * PREFLIGHT one selector on the current page: Playwright's authoritative actionability verdict,
   * plus what geometry alone concluded and whether they agreed. Reads only — performs no action.
   */
  async preflightSelector(selector: string): Promise<PreflightReport> {
    return withLiveReproduceNote(async () => {
      const page = await this.ensurePage();
      const r = await preflight(page.locator(selector));
      return { selector, ...r, note: LIVE_REPRODUCE_NOTE };
    });
  }

  /**
   * OBSERVE the settle SIGNAL after one action (cheaper than a full delta): when the DOM went
   * structurally quiet, whether that was inconclusive (hit the cap), and whether a late wave landed.
   * A signal, never a readiness guarantee — it exposes no `ready`/`safe` boolean.
   */
  async observeSettle(action: McpAction): Promise<SettleReport> {
    return withLiveReproduceNote(async () => {
      const page = await this.ensurePage();
      const o = await observeConsequences(page, (p) => perform(p, action));
      return {
        settleMs: o.settleMs,
        hitMaxWait: o.hitMaxWait,
        suspectedEarly: o.suspectedEarly,
        observed: o.observed,
        ...(o.skippedReason ? { skippedReason: o.skippedReason } : {}),
        note: LIVE_REPRODUCE_NOTE,
      };
    });
  }

  /**
   * EXPLAIN one action's delta as human text WITH the root-cause diagnostics section folded in — the
   * same `render(delta, { diagnostics: true })` an author would read, over this session's browser.
   */
  async explainDelta(action: McpAction): Promise<string> {
    return withLiveReproduceNote(async () => {
      const page = await this.ensurePage();
      const delta = await actAndObserve(page, (p) => perform(p, action), {
        label: describe(action),
        inputIntegrity: inputIntegrityFor(action),
      });
      const { text } = render(diagnose(delta), { diagnostics: true });
      return `${text}\n\n(${LIVE_REPRODUCE_NOTE})`;
    });
  }

  /**
   * DIAGNOSE one action's delta to the gated taxonomy read: {category, confidence, unsure,
   * geomDisagreement}, grounded in Playwright's authoritative verdict. Consumes the ONE shared
   * reducer (so it can't drift from the reporter); an uncrossed gate stays `unsure`, never invented.
   */
  async diagnoseAction(action: McpAction): Promise<DiagnoseReport> {
    return withLiveReproduceNote(async () => {
      const page = await this.ensurePage();
      const delta = await actAndObserve(page, (p) => perform(p, action), {
        label: describe(action),
        inputIntegrity: inputIntegrityFor(action),
      });
      const summary = summarizeDiagnoses(diagnose(delta).diagnoses);
      // The Playwright-authoritative verdict the NAMED cause is grounded in: the changed node carrying
      // the primary diagnosis. It is the 'n/a' sentinel when unsure, and ALSO for a named delta-scope
      // cause (no single node ref) — we never borrow an unrelated node's verdict to look grounded.
      const crossed = summary.cause !== 'unsure';
      const primaryRef = crossed ? summary.primary?.ref : undefined;
      const groundNode = primaryRef ? delta.nodes.find((n) => n.ref === primaryRef) : undefined;
      const verdict: Verdict = groundNode?.actionability.verdict ?? 'n/a';
      return {
        action: describe(action),
        category: summary.category,
        confidence: summary.confidence,
        unsure: summary.unsure,
        geomDisagreement: summary.geomDisagreement,
        cause: summary.cause,
        // When unsure, do NOT surface the below-gate primary's detail (that would describe a cause we
        // are declining to name) — mirror the reporter's neutral fallback.
        detail: crossed ? summary.primary!.detail : 'no cause crossed the confidence gate',
        verdict,
        note: LIVE_REPRODUCE_NOTE,
      };
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }
}
