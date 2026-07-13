// Deltawright ADMISSIBLE benchmark (issue #25) — the rigorous version of #23.
//   npx tsx bench/run-admissible.ts
//
// Removes #23's two biggest admissibility gaps:
//   1. AUTHOR BIAS — the apps under test are real, unmodified, third-party apps
//      (vendored TodoMVC React + Vue, pinned; see bench/corpus/CORPUS.md), not ones we wrote.
//   2. RIGOR — pre-registered interactions (incl. a NAVIGATION), a structure-aware
//      order-insensitive incumbent diff, primary-change capture (recall), and N>=30
//      reps with a discarded warm-up. The corpus is deterministic (fresh context per
//      run), so token counts are exact and only wall-time carries variance.
//
// The token counter is PLUGGABLE (bench/token-counter.ts): the offline cl100k proxy by
// default, or the real Anthropic count_tokens DEPLOYMENT counter when ANTHROPIC_API_KEY is
// set. Each interaction is scored for RECALL (primary change captured) and PRECISION (no
// over-report vs a hand-labeled expected-change set). What it still does NOT cover (tracked
// in #25): Tier-2 production sites via HAR replay; a keyed-list REORDER (TodoMVC has no
// native reorder — needs a sortable-list third-party app); and a covered/off-screen/disabled
// target (an actionability-verdict scenario, already anchored by the accuracy corpus's
// covered-input/disabled cases and the #41 GWT glass-panel — not a token measurement).
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  actAndObserve,
  render,
  ensureInjected,
  DEFAULT_SETTLE,
  type Delta,
  type DeltaNode,
} from '../src/index';
import { structuralDiff } from './structural-diff';
import { minimalDeltaText } from './delta-lite';
import { startCorpusServer } from './static-server';
import { selectCounter, type TokenCounter } from './token-counter';

const VIEWPORT = { width: 1280, height: 720 };
const N = 30; // measured reps per interaction
const WARMUP = 2; // discarded (cold JIT / inject)

// Two THIRD-PARTY frameworks (author-bias-free), same standardized TodoMVC selectors.
const APPS = [
  { name: 'react', path: 'todomvc-react' },
  { name: 'vue', path: 'todomvc-vue' },
];

const snapshot = (p: Page) => p.locator('body').ariaSnapshot();
const seed = (texts: string[]) => async (p: Page) => {
  const input = p.locator('.new-todo');
  for (const t of texts) {
    await input.fill(t);
    await input.press('Enter');
  }
};

interface Interaction {
  name: string;
  quadrant: string;
  setup: (p: Page) => Promise<void>;
  action: (p: Page) => Promise<unknown>;
  /** Recall check: did the delta capture the primary intended change? */
  primaryCaptured: (d: Delta) => boolean;
  /**
   * Precision label (HAND-LABELED GROUND TRUTH): is this reported node a LEGITIMATE
   * consequence of the action? Authored from the observed delta shapes on both React and
   * Vue. A node the delta reports that matches NO clause is a false positive — background
   * churn or over-report — so precision = |expected nodes| / |reported nodes| catches
   * padding the node-count ratio alone cannot. (Predicates are deliberately specific to the
   * action's semantics, not `() => true`, so a spurious node would actually be flagged.)
   */
  expected: (n: DeltaNode) => boolean;
}

// TodoMVC's footer item-count is an unnamed, role-less text node (a <span>/<strong>); it is
// the only text-changing element in these flows, so a role-less textChange is the count.
const isCountText = (n: DeltaNode) => n.kind === 'textChanged' && !n.role;

export const INTERACTIONS: Interaction[] = [
  {
    name: 'add',
    quadrant: 'insert (delta-favorable, clean)',
    setup: seed(['alpha', 'beta', 'gamma']),
    action: async (p) => {
      await p.locator('.new-todo').fill('delta-task');
      await p.locator('.new-todo').press('Enter');
    },
    // The new todo's text lives in a <label> (no accessible name), so recall is
    // "the insertion was detected", i.e. an added <li> subtree appears in the delta.
    primaryCaptured: (d) => d.nodes.some((n) => n.kind === 'added' && n.tag === 'li'),
    // Legit: the added <li> and its whole subtree (all kind:added) + the incremented count.
    expected: (n) => n.kind === 'added' || isCountText(n),
  },
  {
    name: 'toggle',
    quadrant: 'attribute-flip (over-report risk)',
    setup: seed(['alpha', 'beta', 'gamma']),
    action: async (p) => {
      await p.locator('.todo-list li .toggle').first().check();
    },
    primaryCaptured: (d) => d.nodes.some((n) => n.kind === 'attrChanged' || n.kind === 'added'),
    // Legit: the item's completed-class flip, the checkbox's checked flip, the revealed
    // "Clear completed" control, and the active-count text.
    expected: (n) =>
      (n.kind === 'attrChanged' && n.tag === 'li') ||
      (n.kind === 'attrChanged' && n.role === 'checkbox') ||
      (n.kind === 'attrChanged' && n.role === 'button' && n.name === 'Clear completed') ||
      isCountText(n),
  },
  {
    name: 'delete',
    quadrant: 'removal',
    setup: seed(['alpha', 'beta', 'gamma']),
    action: async (p) => {
      const li = p.locator('.todo-list li').nth(1);
      await li.hover();
      await li.locator('.destroy').click();
    },
    primaryCaptured: (d) => d.nodes.some((n) => n.kind === 'removed'),
    // Legit: the removed <li> + the decremented count.
    expected: (n) => (n.kind === 'removed' && n.tag === 'li') || isCountText(n),
  },
  {
    name: 'filter-nav',
    quadrant: 'NAVIGATION (re-snapshot home turf)',
    setup: async (p) => {
      await seed(['alpha', 'beta', 'gamma'])(p);
      await p.locator('.todo-list li .toggle').first().check();
    },
    action: async (p) => {
      await p.locator('.filters a', { hasText: 'Active' }).click();
    },
    primaryCaptured: (d) => d.nodes.some((n) => n.kind === 'removed' || n.kind === 'attrChanged'),
    // Legit: the items filtered OUT of view (removed) + the nav links' selected-state flips.
    expected: (n) =>
      (n.kind === 'removed' && n.tag === 'li') || (n.kind === 'attrChanged' && n.role === 'link'),
  },
];

async function freshApp(
  browser: Browser,
  url: string,
): Promise<{ close: () => Promise<void>; page: Page }> {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.new-todo');
  return { page, close: () => ctx.close() };
}

interface DeltaSample {
  tokens: number;
  lite: number;
  nodes: number;
  settleMs: number;
  capped: boolean;
  captured: boolean;
  /** Every reported node was an expected consequence of the action (no over-report). */
  precise: boolean;
  /** Labels of any nodes that matched no expected clause (empty on a precise sample). */
  spurious: string[];
  wallMs: number;
}

const nodeLabel = (n: DeltaNode) => `${n.kind}:${n.role ?? n.tag}${n.name ? ` "${n.name}"` : ''}`;

async function measureDelta(
  browser: Browser,
  ix: Interaction,
  url: string,
  counter: TokenCounter,
): Promise<DeltaSample> {
  const { page, close } = await freshApp(browser, url);
  await ix.setup(page);
  const t0 = performance.now();
  const delta = await actAndObserve(page, ix.action, { label: ix.name });
  const wallMs = performance.now() - t0;
  const { text } = render(delta);
  const spurious = delta.nodes.filter((n) => !ix.expected(n)).map(nodeLabel);
  const s: DeltaSample = {
    tokens: await counter.count(text),
    lite: await counter.count(minimalDeltaText(delta)),
    nodes: delta.nodes.length,
    settleMs: delta.stats.settleMs,
    capped: delta.stats.hitMaxWait,
    captured: ix.primaryCaptured(delta),
    precise: spurious.length === 0,
    spurious,
    wallMs,
  };
  await close();
  return s;
}

interface IncumbentSample {
  structDiffTokens: number;
  resnapshotTokens: number;
  wallMs: number;
}

async function measureIncumbent(
  browser: Browser,
  ix: Interaction,
  url: string,
  counter: TokenCounter,
): Promise<IncumbentSample> {
  const { page, close } = await freshApp(browser, url);
  await ix.setup(page);
  await ensureInjected(page);
  const t0 = performance.now();
  const before = await snapshot(page);
  await page.evaluate(() => window.__deltawright!.arm());
  await ix.action(page);
  await page.evaluate((o) => window.__deltawright!.waitForSettle(o), DEFAULT_SETTLE);
  const after = await snapshot(page);
  const wallMs = performance.now() - t0;
  const s: IncumbentSample = {
    structDiffTokens: await counter.count(structuralDiff(before, after)),
    resnapshotTokens: await counter.count(after),
    wallMs,
  };
  await close();
  return s;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};
const median = (xs: number[]) => pct(xs, 0.5);

async function main() {
  const counter = selectCounter();
  const browser = await chromium.launch({ headless: true });
  const server = await startCorpusServer();
  const rows: Record<string, unknown>[] = [];
  const spuriousReport: string[] = [];

  for (const app of APPS) {
    const url = `${server.origin}/${app.path}/`;
    for (const ix of INTERACTIONS) {
      process.stdout.write(`\n[${app.name}/${ix.name}] ${ix.quadrant} `);
      const dS: DeltaSample[] = [];
      const iS: IncumbentSample[] = [];
      for (let t = 0; t < N + WARMUP; t++) {
        const d = await measureDelta(browser, ix, url, counter);
        const i = await measureIncumbent(browser, ix, url, counter);
        if (t >= WARMUP) {
          dS.push(d);
          iS.push(i);
        }
        if (t % 5 === 0) process.stdout.write('.');
      }

      const dTok = median(dS.map((s) => s.tokens));
      const dLite = median(dS.map((s) => s.lite));
      const sDiff = median(iS.map((s) => s.structDiffTokens));
      const reSnap = median(iS.map((s) => s.resnapshotTokens));
      const captureRate = dS.filter((s) => s.captured).length;
      const preciseN = dS.filter((s) => s.precise).length;
      const spuriousSeen = [...new Set(dS.flatMap((s) => s.spurious))];
      const nodes = median(dS.map((s) => s.nodes));
      const cappedN = dS.filter((s) => s.capped).length;
      if (spuriousSeen.length) {
        spuriousReport.push(
          `  [${app.name}/${ix.name}] ${N - preciseN}/${N} reps over-reported: ${spuriousSeen.join(', ')}`,
        );
      }

      rows.push({
        app: app.name,
        interaction: ix.name,
        delta_tokens: dTok,
        lite_tokens: dLite,
        struct_diff_tokens: sDiff,
        resnapshot_tokens: reSnap,
        lite_vs_structdiff: sDiff ? +(dLite / sDiff).toFixed(2) : 0,
        delta_vs_resnapshot: reSnap ? +(dTok / reSnap).toFixed(2) : 0,
        nodes,
        recall: `${captureRate}/${N}`,
        precision: `${preciseN}/${N}`,
        capped: `${cappedN}/${N}`,
        delta_ms_med: Math.round(median(dS.map((s) => s.wallMs))),
        incumbent_ms_med: Math.round(median(iS.map((s) => s.wallMs))),
      });
    }
  }

  await browser.close();
  await server.close();
  console.log(
    `\n\n=== ADMISSIBLE RESULTS (real TodoMVC React + Vue, N=${N}, ${WARMUP} warm-up discarded) ===\n`,
  );
  console.log(`token counter: ${counter.label}\n`);
  console.table(rows);
  if (spuriousReport.length) {
    console.log('\nOVER-REPORT (nodes the delta reported that were NOT expected consequences):');
    console.log(spuriousReport.join('\n'));
  } else {
    console.log(
      '\nprecision: no over-report on any interaction — every reported node was an\n' +
        '  expected consequence of the action (hand-labeled ground truth).',
    );
  }
  console.log(
    `\nlegend (counter=${counter.name}${counter.isDeploymentCounter ? ' — the real deployment tokenizer' : ' — a PROXY, not the deployment tokenizer'}):` +
      '\n  deterministic corpus => structural counts (lite/struct-diff/resnapshot) exact; the full' +
      '\n    delta_tokens column wobbles a little sub-pixel with geometry rects — take the median.' +
      '\n  lite_vs_structdiff <1 => delta more compact than a STRUCTURE-AWARE diff at info-parity.' +
      '\n  delta_vs_resnapshot <1 => delta smaller than re-dumping the full a11y tree.' +
      '\n  recall = trials where the delta captured the primary intended change.' +
      '\n  precision = trials with ZERO over-report — every reported node matched a hand-labeled' +
      '\n    expected consequence of the action (catches padding the token ratio alone cannot).' +
      '\n  capability axis (not tokens): delta also carries geometry + actionability the diff lacks.' +
      '\n  NOTE: cl100k (raw text) and Anthropic (message-framed) are DIFFERENT metrics — within a' +
      '\n    run all columns share one counter so ratio DIRECTION holds, but absolute numbers/ratios' +
      '\n    are not directly comparable across the two counter modes.',
  );
}

// Auto-run only as the CLI entry point — NOT when a test imports INTERACTIONS to verify the
// hand-labeled precision predicates (importing must not launch a browser + run the suite).
if (process.argv[1]?.includes('run-admissible')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
