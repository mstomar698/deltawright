// Deltawright ACCURACY harness (#52). REPORTING-FIRST.
//   npm run bench:accuracy   (npx tsx bench/run-accuracy.ts)
//
// Scores the pure diagnose() engine against the labeled flake corpus (#51). Ground truth is the
// corpus construction manifest (`code` + `confidence`) plus the reality-anchor `verdict` — NEVER
// a stored Deltawright output (`load.ts` guards it). Every number here is CORPUS-RELATIVE:
// "diagnoses correctly on a DOM we ASSERT resembles the failure mode." That is NOT real-production
// precision, which stays blocked on #25/#41 (the owner's real apps).
//
// HEADLINE metrics: verdict-vs-reality (DW-02), confirmed-band precision, recall, silent-miss.
// GATING is deliberately reporting-first while #71's remaining recall/signal gaps close: ONLY a
// real DW-02 regression fails the run — the LIVE verdict subset < 100% (or zero live oracles).
// Verdict-vs-reality is SPLIT by case kind (only live cases exercise Playwright's real verdict;
// delta verdicts are authored self-consistency, reported not gated). Confirmed-precision (target
// ≥0.95) and silent-miss (target ≤0.05) are REPORTED, then ratcheted into hard floors as #71 lands
// its detached-re-render / injection-blocked / cross-boundary-partial signals. See score.ts for
// the scoring rules and the known seed-corpus scoping limits (F3/F4).

import { chromium, type Browser, type Page } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { actAndObserve, diagnose, type DiagnosedDelta } from '../src/index';
import { CORPUS } from './flake-corpus/load';
import type { CorpusAction, CorpusCase } from './flake-corpus/cases';
import {
  scoreCase,
  aggregate,
  gateFailure,
  type CaseScore,
  type Metrics,
} from './flake-corpus/score';

const FLAKE_DIR = fileURLToPath(new URL('./flake-corpus', import.meta.url));
const VIEWPORT = { width: 1280, height: 720 };

/** Build a Playwright action from a corpus action descriptor. */
function toAction(a: CorpusAction) {
  return async (page: Page) => {
    const loc = page.locator(a.selector);
    switch (a.kind) {
      case 'click':
        return loc.click();
      case 'fill':
        return loc.fill(a.value ?? '');
      case 'select':
        return loc.selectOption(a.value ?? '');
      case 'check':
        return loc.check();
      case 'press':
        return loc.press(a.key ?? 'Enter');
    }
  };
}

/** Diagnose one case: run the live fixture through actAndObserve, or diagnose the hand-built delta. */
async function diagnoseCase(browser: Browser, c: CorpusCase): Promise<DiagnosedDelta> {
  if (c.kind === 'delta') return diagnose(c.delta!);

  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    await page.goto(pathToFileURL(resolve(FLAKE_DIR, c.fixture!)).href);
    const delta = await actAndObserve(page, toAction(c.action!), {
      label: c.id,
      lateWatchMs: c.options?.lateWatchMs,
      rectRecheckMs: c.options?.rectRecheckMs,
      screenshotFallback: c.options?.screenshotFallback,
      frames: c.options?.frames,
      maxWaitMs: c.options?.maxWaitMs,
      inWindowRecurrence: c.options?.inWindowRecurrence,
    });
    return diagnose(delta);
  } finally {
    await page.close();
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function report(scores: CaseScore[], m: Metrics): string {
  const L: string[] = [];
  L.push('Deltawright accuracy harness (#52) — CORPUS-RELATIVE, reporting-first');
  L.push('='.repeat(72));
  L.push('');
  L.push(`cases: ${m.total}  (specific-cause: ${m.specificCases}, unsure-label: ${m.unsureCases})`);
  L.push('');
  L.push('HEADLINE');
  L.push(
    `  verdict-vs-reality LIVE (DW-02 gate):     ${pct(m.liveVerdictAccuracy)}  ` +
      `(${m.liveVerdictMatches}/${m.liveVerdictOracleCases})  ` +
      `${gateFailure(m) === null ? 'PASS' : 'FAIL'}`,
  );
  L.push(
    `  verdict self-consistency (delta):        ${pct(m.deltaVerdictAccuracy)}  ` +
      `(${m.deltaVerdictMatches}/${m.deltaVerdictOracleCases})  [authored, not reality]`,
  );
  L.push(
    `  confirmed-band precision (target ≥95%):  ${pct(m.confirmedPrecision)}  ` +
      `(${m.confirmedCorrect} correct / ${m.confirmedWrong} wrong)  [reported]`,
  );
  L.push(
    `  recall (labeled cause emitted):          ${pct(m.recall)}  (${m.hits}/${m.specificCases})`,
  );
  L.push(
    `  silent-miss rate (target ≤5%):           ${pct(m.silentMissRate)}  ` +
      `(${m.silentMisses}/${m.specificCases})  [reported]`,
  );
  L.push(`  confidence-band accuracy (on hits):      ${pct(m.confidenceAccuracy)}`);
  L.push('');
  L.push('OUTCOMES BY CASE');
  const mark: Record<CaseScore['outcome'], string> = {
    hit: '✓ hit',
    'correct-unsure': '✓ unsure',
    'silent-miss': '✗ SILENT',
    mislabel: '✗ mislabel',
    'false-positive': '✗ FALSE-POS',
  };
  for (const s of scores) {
    const band = s.emittedConfidence ? ` ${s.emittedConfidence}` : '';
    const got = s.emittedCode ? ` → ${s.emittedCode}${band}` : '';
    const conf = s.outcome === 'hit' && !s.confidenceMatch ? ` (band≠${s.expectedConfidence})` : '';
    // Surface co-emitted specific codes so an extra (esp. a confident one) is never hidden (F2).
    const extra = s.extraSpecificCodes.length
      ? `  +${s.extraSpecificCodes.map((e) => `${e.code}/${e.confidence}`).join(', ')}`
      : '';
    const vv =
      s.verdictMatch === false ? `  ⚠ verdict ${s.verdictActual}≠${s.verdictExpected}` : '';
    L.push(
      `  ${mark[s.outcome].padEnd(12)} ${s.id.padEnd(28)} [${s.expectedCode}]${got}${conf}${extra}${vv}`,
    );
  }
  L.push('');
  L.push('HONESTY STAMP');
  L.push(
    '  Corpus-relative on a ~36-case seed. NOT real-production precision (blocked on #25/#41).',
  );
  L.push('  DW-02 gate is the LIVE verdict subset (real Playwright); delta verdicts are authored');
  L.push('  self-consistency, reported separately, never gated (F1).');
  L.push(
    '  Precision is per-emitted-confirmed-diagnosis (a confident non-label code counts wrong, F2);',
  );
  L.push(
    '  recall/verdict targeting is positional on this single-target-per-fixture seed (F3/F4).',
  );
  L.push('  Known silent misses (open in #71): detached-re-render, injection-blocked,');
  L.push(
    '  cross-boundary-partial — visible above as ✗ SILENT, by design (the corpus reveals them).',
  );
  return L.join('\n');
}

async function main() {
  const browser = await chromium.launch();
  try {
    const scores: CaseScore[] = [];
    for (const c of CORPUS) {
      const d = await diagnoseCase(browser, c);
      scores.push(scoreCase(c, d));
    }
    const metrics = aggregate(scores);
    const text = report(scores, metrics);
    console.log(text);

    const outDir = fileURLToPath(new URL('./results', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'accuracy.txt'), text + '\n');

    // Reporting-first gate: only a real DW-02 (live-verdict) regression fails the run today.
    const failure = gateFailure(metrics);
    if (failure) {
      console.error(`\nFAIL: ${failure}.`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
