// Deltawright ADMISSIBLE benchmark (issue #25) — the rigorous version of #23.
//   npx tsx bench/run-admissible.ts
//
// Removes #23's two biggest admissibility gaps:
//   1. AUTHOR BIAS — the app under test is a real, unmodified, third-party app
//      (vendored TodoMVC React, pinned; see bench/corpus/CORPUS.md), not one we wrote.
//   2. RIGOR — pre-registered interactions (incl. a NAVIGATION), a structure-aware
//      order-insensitive incumbent diff, primary-change capture (recall), and N>=30
//      reps with a discarded warm-up. The corpus is deterministic (fresh context per
//      run), so token counts are exact and only wall-time carries variance.
//
// What it still does NOT cover (tracked in #25): a second framework (Vue), Tier-2
// production sites via HAR replay, and Anthropic's tokenizer as the primary counter.
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  actAndObserve,
  render,
  tokenCount,
  ensureInjected,
  DEFAULT_SETTLE,
  type Delta,
} from '../src/index';
import { structuralDiff } from './structural-diff';
import { minimalDeltaText } from './delta-lite';
import { startCorpusServer } from './static-server';

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
}

const INTERACTIONS: Interaction[] = [
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
  },
  {
    name: 'toggle',
    quadrant: 'attribute-flip (over-report risk)',
    setup: seed(['alpha', 'beta', 'gamma']),
    action: async (p) => {
      await p.locator('.todo-list li .toggle').first().check();
    },
    primaryCaptured: (d) => d.nodes.some((n) => n.kind === 'attrChanged' || n.kind === 'added'),
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
  wallMs: number;
}

async function measureDelta(browser: Browser, ix: Interaction, url: string): Promise<DeltaSample> {
  const { page, close } = await freshApp(browser, url);
  await ix.setup(page);
  const t0 = performance.now();
  const delta = await actAndObserve(page, ix.action, { label: ix.name });
  const wallMs = performance.now() - t0;
  const { tokens } = render(delta);
  const s: DeltaSample = {
    tokens,
    lite: tokenCount(minimalDeltaText(delta)),
    nodes: delta.nodes.length,
    settleMs: delta.stats.settleMs,
    capped: delta.stats.hitMaxWait,
    captured: ix.primaryCaptured(delta),
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
    structDiffTokens: tokenCount(structuralDiff(before, after)),
    resnapshotTokens: tokenCount(after),
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
  const browser = await chromium.launch({ headless: true });
  const server = await startCorpusServer();
  const rows: Record<string, unknown>[] = [];

  for (const app of APPS) {
    const url = `${server.origin}/${app.path}/`;
    for (const ix of INTERACTIONS) {
      process.stdout.write(`\n[${app.name}/${ix.name}] ${ix.quadrant} `);
      const dS: DeltaSample[] = [];
      const iS: IncumbentSample[] = [];
      for (let t = 0; t < N + WARMUP; t++) {
        const d = await measureDelta(browser, ix, url);
        const i = await measureIncumbent(browser, ix, url);
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
      const nodes = median(dS.map((s) => s.nodes));
      const cappedN = dS.filter((s) => s.capped).length;

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
        capture: `${captureRate}/${N}`,
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
  console.table(rows);
  console.log(
    '\nlegend (deterministic corpus => token counts exact; only time varies):' +
      '\n  lite_vs_structdiff <1 => delta more compact than a STRUCTURE-AWARE diff at info-parity.' +
      '\n  delta_vs_resnapshot <1 => delta smaller than re-dumping the full a11y tree.' +
      '\n  capture = trials where the delta captured the primary intended change (recall).' +
      '\n  capability axis (not tokens): delta also carries geometry + actionability the diff lacks.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
