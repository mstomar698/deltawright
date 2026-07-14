// Deltawright on legacy GWT (#41) — the HONEST demo.
//   npm run demo:gwt
//
// Runs a GWT-FAITHFUL synthetic fixture (deferred commands, glass overlay, self-reposition,
// delegated role-less DOM — NOT compiled GWT) and prints, for each case, exactly what
// Deltawright does AND does not do. The whole point is intellectual honesty: idiomatic
// Playwright already handles most of GWT; Deltawright's real value is narrow and it has its
// own gaps. Wins and CANNOTs are printed on the same slide.
import { chromium, type Browser, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { actAndObserve, render, diagnose } from '../src/index';
import { summarizeDiagnoses } from '../src/host/summarize';

const fixture = pathToFileURL(resolve('test/fixtures/gwt.html')).href;
const inputFixture = pathToFileURL(resolve('test/fixtures/input-drop.html')).href;
const rule = (c = '─') => console.log(c.repeat(72));

async function fresh(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(fixture);
  return page;
}

const browser = await chromium.launch({ headless: true });

rule('═');
console.log('DELTAWRIGHT ON LEGACY GWT — honest, scoped demo');
console.log('fixture: a FAITHFUL REPRODUCTION of GWT DOM+timing, not compiled GWT.');
rule('═');

// ── WIN A: deferred-observe (the one win attributed to settle) ──────────────
{
  const page = await fresh(browser);
  const syncMissed = await page.evaluate(() => {
    (document.querySelector('[data-cmd=approve]') as HTMLElement).click();
    return document.querySelector('.panel') === null;
  });
  await page.goto(fixture);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=approve]'), {
    label: 'approve',
  });
  const node = delta.nodes.find((n) => n.kind === 'added');

  console.log('\n[WIN] A — deferred-observe (no locator to name)');
  console.log(
    `  zero-wait read (accessibility.snapshot/evaluate): node present? ${!syncMissed ? 'yes' : 'NO — raced the setTimeout/rAF cascade'}`,
  );
  console.log(
    `  deltawright settle:  captured the appeared node, settle=${delta.stats.settleMs}ms, hitMaxWait=${delta.stats.hitMaxWait}, ref=${node?.ref} @ rect present=${!!node?.geometry}`,
  );
  console.log('  claim: a locator-free, network-free completion signal for "what appeared".');
  console.log(
    '  NOT a claim: for a KNOWN target, idiomatic expect(locator).toBeVisible() also passes.',
  );
  await page.close();
}

// ── DIAGNOSTIC B + VISIBILITY C: glass coverage & disabled disagreement ─────
{
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=open]'), {
    label: 'open dialog',
  });
  const refresh = delta.nodes.find((n) => n.name === 'Refresh balance');
  const confirm = delta.nodes.find((n) => n.name === 'Confirm');

  console.log('\n[DIAGNOSTIC] B — glass overlay coverage');
  console.log(
    `  refresh: verdict=${refresh?.actionability.verdict} coveredBy=${refresh?.geometry?.coveredBy} agreed=${refresh?.actionability.agreed}`,
  );
  console.log('  claim: turns a post-hoc 30s click-hang into a sub-second labeled coverage fact.');
  console.log(
    '  NOT a claim: this AGREES with Playwright (already correct); DW cannot dismiss the glass.',
  );
  console.log('\n[VISIBILITY] C — geometry vs Playwright disagreement');
  console.log(
    `  confirm: verdict=${confirm?.actionability.verdict} geometryVerdict=${confirm?.actionability.geometryVerdict} agreed=${confirm?.actionability.agreed}`,
  );
  console.log(
    '  render() surfaces it:',
    render(delta)
      .text.split('\n')
      .find((l) => l.includes('[geom:'))
      ?.trim(),
  );
  await page.close();
}

// ── LIMIT D: role-less delegated cell ───────────────────────────────────────
{
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click('td[data-cmd=expand]'), {
    label: 'expand',
  });
  const row = delta.nodes.find((n) => n.kind === 'added' && n.tag === 'tr');
  console.log('\n[LIMIT] D — role-less delegated FlexTable cell');
  console.log(
    `  reported: <${row?.tag}> role=${row?.role} name=${row?.name} — "structure changed here", no invented semantics.`,
  );
  console.log(
    "  honest: DW's textContent name is the same handle getByText already uses — no added semantics.",
  );
  await page.close();
}

// ── GAP E: two-wave silent under-report ─────────────────────────────────────
{
  const page = await fresh(browser);
  const delta = await actAndObserve(page, (p) => p.click('[data-cmd=twowave]'), {
    label: 'two-wave',
  });
  const wave2 = delta.nodes.some((n) => n.geometry !== null && n.geometry.rect.y >= 300);
  console.log('\n[GAP] E — two-wave render, inter-wave gap > quietMs');
  console.log(
    `  wave 2 captured? ${wave2 ? 'yes' : 'NO'}  hitMaxWait=${delta.stats.hitMaxWait}  suspected-miss flag? ${render(delta).text.includes('SUSPECTED MISS')}`,
  );
  console.log(
    '  honest gap: settle resolves on wave 1 and SILENTLY under-reports wave 2. Real limitation.',
  );
  await page.close();
}

// ── GAP F: stale annotated rect on JS-timer recenter ────────────────────────
{
  const page = await fresh(browser);
  const js = await actAndObserve(page, (p) => p.click('[data-cmd=recenter-js]'), {
    label: 'js recenter',
  });
  const jsDlg = js.nodes.find((n) => n.kind === 'added' && n.geometry);
  await page.goto(fixture);
  const css = await actAndObserve(page, (p) => p.click('[data-cmd=recenter-css]'), {
    label: 'css recenter',
  });
  const cssDlg = css.nodes.find((n) => n.kind === 'added' && n.geometry);
  console.log('\n[GAP] F — dialog recenter after settle');
  console.log(
    `  JS-timer recenter:  annotated x=${jsDlg?.geometry?.rect.x} (STALE, pre-center), animationsAwaited=${js.stats.animationsAwaited}`,
  );
  console.log(
    `  CSS-transition:     annotated x=${cssDlg?.geometry?.rect.x} (correct, awaited),   animationsAwaited=${css.stats.animationsAwaited}`,
  );
  console.log(
    '  honest gap: getAnimations() is empty for JS style writes, so the rect can be stale. Verdict stays correct.',
  );
  await page.close();
}

// ── WIN G: post-settle input-integrity (v0.9 Move 1) ────────────────────────
// A GWT SuggestBox whose async RPC returns and CLEARS the field, and a length-limited field that
// truncates — both AFTER Playwright's fill/type reports success. A synchronous post-fill check
// cannot see it; DW re-reads the committed value at the post-settle point and labels the drop.
{
  const INTENDED = 'acetaminophen500';
  const readValue = (sel: string) => (p: Page) => p.locator(sel).inputValue();
  // Playwright's pressSequentially reports success on all these fields (never throws — confirmed by
  // the Move 1 kill-hypothesis); DW re-reads the committed value at the post-settle point.
  const typeInto = async (sel: string) => {
    const page = await browser.newPage();
    await page.goto(inputFixture);
    const delta = await actAndObserve(
      page,
      async (p) => {
        await p.locator(sel).click();
        await p.locator(sel).pressSequentially(INTENDED);
      },
      {
        label: `type ${sel}`,
        inputIntegrity: { intended: INTENDED, readCommitted: readValue(sel) },
      },
    );
    await page.close();
    return delta;
  };

  const clear = await typeInto('#debounce-clear');
  const mask = await typeInto('#mask-upper');
  const clearCause = summarizeDiagnoses(diagnose(clear).diagnoses).cause;
  const maskCause = summarizeDiagnoses(diagnose(mask).diagnoses).cause;

  console.log('\n[WIN] G — post-settle input-integrity (a class DW scored zero on before v0.9)');
  console.log(
    `  SuggestBox (debounce-then-clear): Playwright pressSequentially reported success; ` +
      `field committed ${clear.stats.inputIntegrity?.committedLen}/${INTENDED.length} chars`,
  );
  console.log(
    `  deltawright:  ${clearCause} (${clear.stats.inputIntegrity?.shape}) — the async clear a synchronous post-fill check cannot see`,
  );
  console.log(
    `  formatting mask (uppercase): committed value differs too, but DW labels it "${maskCause}" — a transform is NOT a loss (DW-03 false-positive guard).`,
  );
  console.log(
    '  claim: value-comparison only (no role/name/text) → language- and obfuscation-independent; suspected, never a fix.',
  );
}

rule('═');
console.log('VERDICT: GO as "a better MOMENT (locator-free settle for observe), a stable HANDLE,');
console.log('an independent coverage/disagreement SECOND-OPINION, and (v0.9) a post-settle');
console.log('INPUT-INTEGRITY verdict (G) — the async keystroke-drop no other tool detects". NO-GO');
console.log('as "DW fixes Playwright\'s GWT actionability" — idiomatic Playwright already handles');
console.log(
  'most of it, DW never fixes/retries, and it has its own silent gaps (E, F). Fixture is',
);
console.log('synthetic; calibrate to a real portal trace before any framework-specific claim.');
rule('═');
await browser.close();
