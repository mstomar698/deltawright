// Deltawright TIER-2 real-app benchmark (issue #25) — runs the admissible methodology against
// REAL, LIVE web apps (not the frozen Tier-1 corpus), to check the token-compactness + actionability
// story holds on production DOM with real forms and overlays.
//
//   npx tsx bench/run-live.ts
//
// Targets are read from bench/live-targets.json (GITIGNORED — it names your own sites + points at
// credentials via env vars; see bench/live-targets.example.json for the shape). Nothing site-
// specific is committed: this harness is generic, and it prints SANITIZED metrics only (node
// counts, kinds, token counts, actionability verdicts) — never page content, URLs, or credentials.
//
// Unlike Tier-1 this is DIRECTIONAL, not a rigorous N=30 stat: live DOM is non-deterministic, so we
// take a small N and report medians; the point is "does the delta stay compact + surface
// actionability on real apps?", which the ratios answer robustly.
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actAndObserve, render, ensureInjected, DEFAULT_SETTLE } from '../src/index';
import { structuralDiff } from './structural-diff';
import { minimalDeltaText } from './delta-lite';
import { selectCounter } from './token-counter';

interface LocSpec {
  role?: string;
  name?: string;
  exact?: boolean;
  nameRe?: string; // regex string for name
  css?: string;
}
interface Interaction {
  name: string;
  quadrant: string;
  click: LocSpec;
}
interface LoginSpec {
  user: LocSpec;
  pass: LocSpec;
  submit: LocSpec;
  userEnv: string;
  passEnv: string;
  typeDelayMs?: number;
  successGoneCss?: string; // login done when this selector disappears (e.g. the password field)
}
interface Target {
  name: string;
  url: string;
  waitMs?: number;
  ready?: LocSpec;
  login?: LoginSpec;
  interactions: Interaction[];
}

const N = Number(process.env.LIVE_N || 3);
const WARMUP = 1;
const counter = selectCounter();
const snapshot = (p: Page) => p.locator('body').ariaSnapshot();
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function loc(page: Page, s: LocSpec): Locator {
  if (s.css) return page.locator(s.css).first();
  if (s.role) {
    const name = s.nameRe ? new RegExp(s.nameRe, 'i') : s.name;
    return page.getByRole(s.role as never, name ? { name, exact: s.exact } : {}).first();
  }
  throw new Error(`bad locator spec: ${JSON.stringify(s)}`);
}

async function login(page: Page, l: LoginSpec) {
  const u = process.env[l.userEnv] || '';
  const p = process.env[l.passEnv] || '';
  const delay = l.typeDelayMs ?? 20;
  const uf = loc(page, l.user);
  await uf.click();
  await uf.pressSequentially(u, { delay }); // real typing — React controlled inputs need events
  const pf = loc(page, l.pass);
  await pf.click();
  await pf.pressSequentially(p, { delay });
  await loc(page, l.submit).click({ timeout: 8000 });
  await page.waitForTimeout(4000);
  if (
    l.successGoneCss &&
    (await page
      .locator(l.successGoneCss)
      .count()
      .catch(() => 0)) > 0
  ) {
    throw new Error('login did not complete (success-gone selector still present)');
  }
}

async function freshPage(browser: Browser, t: Target) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(t.waitMs ?? 2500);
  if (t.login) await login(page, t.login);
  if (t.ready)
    await loc(page, t.ready)
      .waitFor({ timeout: 15000 })
      .catch(() => {});
  return { page, close: () => ctx.close() };
}

async function main() {
  let raw: string;
  try {
    raw = readFileSync(fileURLToPath(new URL('./live-targets.json', import.meta.url)), 'utf8');
  } catch {
    console.log(
      'No bench/live-targets.json found (it is gitignored). Copy bench/live-targets.example.json,\n' +
        'point it at your own sites, set the credential env vars, and re-run. This harness commits\n' +
        'nothing site-specific.',
    );
    return;
  }
  let cfg: { targets: Target[] };
  try {
    cfg = JSON.parse(raw); // present but malformed → fail loud, not "not found" (names no content)
  } catch (e) {
    console.error(`bench/live-targets.json is present but not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const rows: Record<string, unknown>[] = [];
  console.log(`token counter: ${counter.label}\n`);

  for (const t of cfg.targets) {
    for (const ix of t.interactions) {
      process.stdout.write(`\n[${t.name}/${ix.name}] ${ix.quadrant} `);
      const dTok: number[] = [],
        dLite: number[] = [],
        sDiff: number[] = [],
        reSnap: number[] = [];
      const nodes: number[] = [],
        notAct: number[] = [],
        covered: number[] = [];
      let cappedN = 0,
        errN = 0;
      for (let r = 0; r < N + WARMUP; r++) {
        try {
          // delta
          const d = await freshPage(browser, t);
          const delta = await actAndObserve(
            d.page,
            (p) => loc(p, ix.click).click({ timeout: 8000 }),
            { label: ix.name },
          );
          const dt = await counter.count(render(delta).text);
          const dl = await counter.count(minimalDeltaText(delta));
          const na = delta.nodes.filter(
            (n) => n.actionability?.verdict === 'NOT-actionable',
          ).length;
          const cov = delta.nodes.filter((n) => n.geometry?.coveredBy).length;
          const cap = delta.stats.hitMaxWait;
          await d.close();
          // incumbent
          const i = await freshPage(browser, t);
          await ensureInjected(i.page);
          const before = await snapshot(i.page);
          await i.page.evaluate(() => window.__deltawright!.arm());
          await loc(i.page, ix.click).click({ timeout: 8000 });
          await i.page.evaluate((o) => window.__deltawright!.waitForSettle(o), DEFAULT_SETTLE);
          const after = await snapshot(i.page);
          const sd = await counter.count(structuralDiff(before, after));
          const rs = await counter.count(after);
          await i.close();
          if (r >= WARMUP) {
            dTok.push(dt);
            dLite.push(dl);
            sDiff.push(sd);
            reSnap.push(rs);
            nodes.push(delta.nodes.length);
            notAct.push(na);
            covered.push(cov);
            if (cap) cappedN++;
          }
          process.stdout.write('.');
        } catch {
          errN++;
          process.stdout.write('x');
        }
      }
      const mdTok = median(dTok),
        mReSnap = median(reSnap),
        mLite = median(dLite),
        mSDiff = median(sDiff);
      rows.push({
        target: t.name,
        interaction: ix.name,
        delta_tokens: mdTok,
        lite_tokens: mLite,
        struct_diff_tokens: mSDiff,
        resnapshot_tokens: mReSnap,
        lite_vs_structdiff: mSDiff ? +(mLite / mSDiff).toFixed(2) : 0,
        delta_vs_resnapshot: mReSnap ? +(mdTok / mReSnap).toFixed(2) : 0,
        nodes: median(nodes),
        not_actionable: median(notAct),
        covered: median(covered),
        capped: `${cappedN}/${dTok.length}`,
        errors: `${errN}/${N + WARMUP}`,
      });
    }
  }

  await browser.close();
  console.log(`\n\n=== TIER-2 LIVE RESULTS (real apps, N=${N}, ${WARMUP} warm-up) ===\n`);
  console.table(rows);
  console.log(
    '\nlegend (SANITIZED — no page content/URLs/creds are printed or committed):' +
      '\n  delta_vs_resnapshot <1 => delta smaller than re-dumping the full a11y tree (the MCP default).' +
      '\n  lite_vs_structdiff <1 => delta more compact than a STRUCTURE-AWARE diff at info-parity.' +
      '\n  covered/not_actionable => nodes DW flagged covered-by-overlay / NOT-actionable — the' +
      '\n    real-overlay capability the frozen Tier-1 corpus cannot exercise.' +
      '\n  DIRECTIONAL (live DOM is non-deterministic): small N, medians; ratios are the robust signal.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
