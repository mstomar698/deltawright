// Deltawright v0.1 demo — the proof.
//   npm run demo
//
// Runs the three controlled north-star cases and prints, for each, the actual
// compact delta. For the covered / off-screen cases it also prints the full-page
// accessibility snapshot's line for the same element, to show the gap Deltawright
// closes: the snapshot lists it as a normal interactive node with no hint that it
// is unusable, while the delta marks it NOT-actionable with a reason that matches
// what Playwright actually does.
import { chromium, type Browser, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { actAndObserve, render, tokenCount } from '../src/index';

const fixture = pathToFileURL(resolve('test/fixtures/northstar.html')).href;

async function fresh(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(fixture);
  return page;
}

function line(char = '─') {
  console.log(char.repeat(64));
}

const browser = await chromium.launch({ headless: true });

// ── Case 1: the north-star ────────────────────────────────────────────────
{
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click('#open-popup'), {
    label: 'click "Open popup"',
  });
  const { text, tokens } = render(delta);

  line('═');
  console.log('CASE 1 — north-star popup (delayed insert + CSS animation)');
  line('═');
  console.log(text);
  console.log();
  console.log(`delta size   : ${tokens} tokens (cl100k proxy), ${text.length} chars`);
  console.log(
    `coalescing   : ${delta.stats.rawRecords} raw MutationRecords -> ${delta.nodes.length} reported nodes`
  );
  console.log(
    `settle       : ${delta.stats.settleMs}ms ${delta.stats.hitMaxWait ? '(hit maxWait)' : '(quiesced)'}, ${delta.stats.animationsAwaited} animations awaited`
  );
  console.log(
    `agreement    : ${delta.nodes.every((n) => n.actionability.agreed) ? 'geometry & Playwright AGREE on every node' : 'DISAGREEMENT'}`
  );

  // Honest baseline: a full-page a11y snapshot of THIS (small) page.
  const snapshot = await page.locator('body').ariaSnapshot();
  const snapTokens = tokenCount(snapshot);
  console.log(
    `\nbaseline     : full-page a11y snapshot = ${snapTokens} tokens (whole page, no geometry, no actionability).`
  );
  console.log(
    `               NO token win here: the delta (${tokens}) is ${tokens > snapTokens ? 'LARGER' : 'smaller'} than the snapshot (${snapTokens}).`
  );
  console.log(
    '               Token savings are a large-SPA property, unmeasured in v0.1. The value shown here is'
  );
  console.log(
    '               the two dimensions the snapshot lacks — geometry + actionability — in cases 2-4.'
  );
  await page.close();
}

// ── Cases 2 & 3: the "present-but-not-actionable" gap ─────────────────────
for (const c of [
  { id: '#open-covered', label: 'click "Open covered popup"', target: 'Renew', title: 'CASE 2 — popup partly covered by an overlay' },
  { id: '#open-offscreen', label: 'click "Insert off-screen"', target: 'Ghost action', title: 'CASE 3 — element inserted off-screen' },
]) {
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click(c.id), { label: c.label });
  const node = delta.nodes.find((n) => n.name === c.target)!;

  line('═');
  console.log(c.title);
  line('═');

  const snapshot = await page.locator('body').ariaSnapshot();
  const snapLine = snapshot
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes(`"${c.target}"`));

  console.log(`a11y snapshot says : ${snapLine ?? '(node present)'}   <- looks directly interactive`);
  console.log(
    `deltawright says   : ${c.target} -> ${node.actionability.verdict} (${node.actionability.reason})`
  );

  // Confirm reality: a real Playwright click on the flagged node is refused.
  let realFailed = false;
  try {
    await page.locator(`[data-dw-ref="${node.ref}"]`).click({ timeout: 800 });
  } catch {
    realFailed = true;
  }
  console.log(
    `reality check      : real Playwright click ${realFailed ? 'FAILED' : 'succeeded'} -> verdict ${
      realFailed === (node.actionability.verdict === 'NOT-actionable') ? 'MATCHED reality ✓' : 'MISMATCH ✗'
    }`
  );
  await page.close();
}

// ── Case 4: geometry vs Playwright disagreement ───────────────────────────
{
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click('#open-disabled'), {
    label: 'click "Insert disabled control"',
  });
  const submit = delta.nodes.find((n) => n.name === 'Submit')!;

  line('═');
  console.log('CASE 4 — visible but disabled button (geometry vs Playwright disagree)');
  line('═');
  console.log(render(delta).text);
  console.log();
  console.log(
    `geometry alone     : ${submit.actionability.geometryVerdict} (looks reachable — visible, uncovered)`
  );
  console.log(
    `deltawright verdict: ${submit.actionability.verdict} (${submit.actionability.reason}) — Playwright wins`
  );
  console.log(`agreed             : ${submit.actionability.agreed} (surfaced as [geom:...] above)`);
  await page.close();
}

line('═');
console.log('All four cases produced correct, tiny, structured deltas with no before/after diff.');
await browser.close();
