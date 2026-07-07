// Deltawright real-app benchmark (issue #23) — the §10 experiment.
//   npx tsx bench/run-bench.ts
//
// For each scenario, on a real React SPA, compares three approaches per action and
// maps the results to §10 kill-criteria (a) token win, (b) noise, (c) settle:
//
//   - DELTA         : actAndObserve -> compact delta (what Deltawright produces)
//   - RE-SNAPSHOT   : the full a11y snapshot after the action (Playwright-MCP style)
//   - BEFORE+AFTER  : snapshot before + after, minimal line-diff (the classic incumbent)
//
// Fairness rules (from the methodology red-team):
//   * The incumbent is steel-manned: we count the DIFF the agent reads, not just the
//     full snapshot; and we report the full snapshot separately.
//   * Both DELTA and BEFORE+AFTER use the SAME settle wait, so timing is comparable.
//   * The delta's geometry + actionability is a CAPABILITY the a11y diff structurally
//     lacks — reported as a separate axis, never folded into the token score.
//   * We record TIME too, so a token win can't hide the delta's O(nodes) trial cost.
//   * Median of N trials (noise makes single runs vary).
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  actAndObserve,
  render,
  tokenCount,
  ensureInjected,
  DEFAULT_SETTLE,
  type Delta,
  type DeltaNode,
} from '../src/index';
import { loadReactApp, type AppConfig } from './load-app';
import { lineDiff } from './diff';

// Information-parity variant: the delta stripped of geometry + actionability, so
// its token cost is comparable to the a11y diff (which carries neither). This is
// the apples-to-apples token-efficiency axis; the full delta does strictly more.
function minimalDeltaText(delta: Delta): string {
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

const VIEWPORT = { width: 1280, height: 720 };
const TRIALS = 3;

interface Scenario {
  name: string;
  config: AppConfig;
  /** Ground-truth count of the intended change (the modal subtree: dialog + 3 controls). */
  meaningful: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'small-quiet', config: { rows: 10, noise: false, intervalMs: 60 }, meaningful: 4 },
  { name: 'large-quiet', config: { rows: 300, noise: false, intervalMs: 60 }, meaningful: 4 },
  { name: 'small-noisy', config: { rows: 50, noise: true, intervalMs: 60 }, meaningful: 4 },
  { name: 'large-noisy', config: { rows: 300, noise: true, intervalMs: 60 }, meaningful: 4 },
];

const openModal = (p: Page) => p.click('#open-modal');
const snapshot = (p: Page) => p.locator('body').ariaSnapshot();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

interface DeltaSample {
  tokens: number;
  liteTokens: number;
  rawRecords: number;
  reportedNodes: number;
  settleMs: number;
  hitMaxWait: boolean;
  capturedModal: boolean;
  wallMs: number;
}

async function measureDelta(browser: Browser, sc: Scenario): Promise<DeltaSample> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await loadReactApp(page, sc.config);
  const t0 = performance.now();
  const delta = await actAndObserve(page, openModal, { label: sc.name });
  const wallMs = performance.now() - t0;
  const { tokens } = render(delta);
  const liteTokens = tokenCount(minimalDeltaText(delta));
  const capturedModal = delta.nodes.some((n) => n.role === 'dialog' || n.name === 'New item');
  await page.close();
  return {
    tokens,
    liteTokens,
    rawRecords: delta.stats.rawRecords,
    reportedNodes: delta.nodes.length,
    settleMs: delta.stats.settleMs,
    hitMaxWait: delta.stats.hitMaxWait,
    capturedModal,
    wallMs,
  };
}

/**
 * Noise-floor probe: arm -> settle around a NO-OP on the (possibly churning) app.
 * Nothing was intended to change, so every reported node is a pure false positive.
 * Proves criterion (b) is measuring real background churn, not benchmark construction.
 */
async function measureNullAction(browser: Browser, sc: Scenario): Promise<number> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await loadReactApp(page, sc.config);
  const delta = await actAndObserve(page, async () => {}, { label: `${sc.name}:null` });
  const n = delta.nodes.length;
  await page.close();
  return n;
}

interface IncumbentSample {
  beforeTokens: number;
  afterTokens: number;
  diffTokens: number;
  diffLines: number;
  wallMs: number;
}

async function measureIncumbent(browser: Browser, sc: Scenario): Promise<IncumbentSample> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await loadReactApp(page, sc.config);
  // Use the SAME settle mechanism the delta uses, so both wait the same amount.
  await ensureInjected(page);
  const t0 = performance.now();
  const before = await snapshot(page);
  await page.evaluate(() => window.__deltawright!.arm());
  await openModal(page);
  await page.evaluate((o) => window.__deltawright!.waitForSettle(o), DEFAULT_SETTLE);
  const after = await snapshot(page);
  const wallMs = performance.now() - t0;
  const diff = lineDiff(before, after);
  await page.close();
  return {
    beforeTokens: tokenCount(before),
    afterTokens: tokenCount(after),
    diffTokens: tokenCount(diff),
    diffLines: diff.split('\n').filter((l) => l.trim()).length,
    wallMs,
  };
}

function med<T>(samples: T[], key: keyof T): number {
  return median(samples.map((s) => Number(s[key])));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const rows: Record<string, unknown>[] = [];

  for (const sc of SCENARIOS) {
    process.stdout.write(`\n[${sc.name}] rows=${sc.config.rows} noise=${sc.config.noise} `);
    const deltas: DeltaSample[] = [];
    const incs: IncumbentSample[] = [];
    const nulls: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      deltas.push(await measureDelta(browser, sc));
      incs.push(await measureIncumbent(browser, sc));
      nulls.push(await measureNullAction(browser, sc));
      process.stdout.write('.');
    }

    const dTokens = med(deltas, 'tokens');
    const dLite = med(deltas, 'liteTokens');
    const dNodes = med(deltas, 'reportedNodes');
    const dRaw = med(deltas, 'rawRecords');
    const dSettle = med(deltas, 'settleMs');
    const dWall = med(deltas, 'wallMs');
    const capped = deltas.filter((d) => d.hitMaxWait).length;
    const captured = deltas.filter((d) => d.capturedModal).length;
    const afterTokens = med(incs, 'afterTokens');
    const diffTokens = med(incs, 'diffTokens');
    const iWall = med(incs, 'wallMs');
    const nullNodes = median(nulls);

    rows.push({
      scenario: sc.name,
      delta_tokens: dTokens,
      delta_lite_tokens: dLite,
      diff_tokens: diffTokens,
      resnapshot_tokens: afterTokens,
      lite_vs_diff: +(dLite / diffTokens).toFixed(2),
      delta_vs_resnapshot: +(dTokens / afterTokens).toFixed(2),
      delta_nodes: `${dRaw}->${dNodes}`,
      noise_ratio: +(dNodes / sc.meaningful).toFixed(1),
      null_false_pos: nullNodes,
      settle_ms: Math.round(dSettle),
      capped: `${capped}/${TRIALS}`,
      captured: `${captured}/${TRIALS}`,
      delta_wall_ms: Math.round(dWall),
      incumbent_wall_ms: Math.round(iWall),
    });
  }

  await browser.close();

  console.log('\n\n=== RESULTS (median of ' + TRIALS + ' trials) ===\n');
  console.table(rows);
  console.log(
    '\nlegend (tokens = cl100k proxy; RATIOS are the tokenizer-robust signal):' +
      '\n  delta_tokens      = full delta (geometry + actionability verdict per node).' +
      '\n  delta_lite_tokens = info-parity: delta stripped to what-changed only, vs the a11y diff.' +
      '\n  lite_vs_diff  <1  => the delta is more compact than the incumbent diff at equal info.' +
      '\n  delta_vs_resnapshot <1 => delta smaller than re-dumping the full a11y tree (MCP default).' +
      '\n  noise_ratio       = reported nodes / meaningful (modal=4); >1 => background churn leaked in.' +
      '\n  null_false_pos    = nodes reported for a NO-OP action (pure noise-floor false positives).' +
      '\n  capability axis (NOT a token score): the delta carries geometry + a Playwright-aligned' +
      '\n  verdict the a11y snapshot/diff structurally cannot.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
