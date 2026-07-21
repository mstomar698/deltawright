import type { RootCauseCategory } from '../host/taxonomy';
import type { FlakeReport, PriorityQueue, TestFlakeRecordView, TestFlakeSummary } from './index';

// The flake dashboard (#2, Wave-1) — a self-contained, theme-aware static HTML view over the
// EXISTING FlakeReport (#59's deliberately-cut dashboard). VIEW-ONLY: `renderHtml` is a pure
// function that returns an HTML document string and writes NOTHING (same read-only invariant as the
// aggregator). No engine change, no new data — it renders exactly what `aggregate()` already
// computes: most-flaky-first, dominant category, settle-cap / disagreement rates, and the `unsure`
// bucket kept in its OWN panel (never folded into a category — the aggregator's honesty rule,
// preserved here). Self-contained: inline CSS + a tiny theme-toggle script, no external assets, so
// the file opens offline anywhere.

/** Escape a string for safe interpolation into HTML text/attribute context. testIds are user data. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** rate (0..1) → a whole-percent label. */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Display metadata per taxonomy category — a fixed order + a swatch colour visible on both themes. */
const CATEGORY_META: Record<RootCauseCategory, { label: string; color: string }> = {
  'actionability-blocking': { label: 'Actionability blocking', color: '#e5534b' },
  'verdict-disagreement': { label: 'Verdict disagreement', color: '#a371f7' },
  'membership-attribution': { label: 'Membership / attribution', color: '#4c8ed9' },
  'outcome-integrity': { label: 'Outcome integrity', color: '#db6d28' },
  'capture-integrity': { label: 'Capture integrity', color: '#d4a017' },
  fallback: { label: 'Fallback', color: '#3fb950' },
  unknown: { label: 'Unknown', color: '#8b949e' },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META) as RootCauseCategory[];

function categorySwatch(cat: RootCauseCategory | null): string {
  if (cat === null)
    return `<span class="chip"><span class="dot" style="background:#8b949e"></span>unsure</span>`;
  const meta = CATEGORY_META[cat];
  return `<span class="chip"><span class="dot" style="background:${meta.color}"></span>${escapeHtml(meta.label)}</span>`;
}

/** Sum per-test category counts into an overall category → count map. */
function categoryTotals(tests: TestFlakeSummary[]): Map<RootCauseCategory, number> {
  const totals = new Map<RootCauseCategory, number>();
  for (const t of tests)
    for (const [cat, n] of Object.entries(t.categories) as Array<[RootCauseCategory, number]>)
      totals.set(cat, (totals.get(cat) ?? 0) + n);
  return totals;
}

function categorySection(tests: TestFlakeSummary[], unsureBucket: number): string {
  const totals = categoryTotals(tests);
  const categorized = [...totals.values()].reduce((a, b) => a + b, 0);
  const grand = categorized + unsureBucket;
  if (grand === 0) return '';

  // A proportional stacked bar: one segment per category present, plus an unsure segment. Widths are
  // percentages of ALL records (categorized + unsure) so the unsure share is visible, not hidden.
  const segments = CATEGORY_ORDER.filter((c) => (totals.get(c) ?? 0) > 0).map((c) => {
    const n = totals.get(c)!;
    const meta = CATEGORY_META[c];
    return `<span class="seg" style="width:${(n / grand) * 100}%;background:${meta.color}" title="${escapeHtml(meta.label)}: ${n}"></span>`;
  });
  if (unsureBucket > 0)
    segments.push(
      `<span class="seg seg-unsure" style="width:${(unsureBucket / grand) * 100}%" title="unsure: ${unsureBucket}"></span>`,
    );

  const legend = CATEGORY_ORDER.filter((c) => (totals.get(c) ?? 0) > 0)
    .map((c) => {
      const n = totals.get(c)!;
      return `<li><span class="dot" style="background:${CATEGORY_META[c].color}"></span>${escapeHtml(CATEGORY_META[c].label)} <b>${n}</b></li>`;
    })
    .join('');

  return `
    <section class="panel">
      <h2>By category</h2>
      <div class="catbar">${segments.join('')}</div>
      <ul class="legend">${legend}<li><span class="dot dot-unsure"></span>unsure <b>${unsureBucket}</b></li></ul>
    </section>`;
}

/** Flags present on a record, as fixed human labels (not user data). */
function recordFlags(r: TestFlakeRecordView): string[] {
  const flags: string[] = [];
  if (r.detached) flags.push('detached');
  if (r.lateWave) flags.push('late-wave');
  if (r.staleRect) flags.push('stale-rect');
  return flags;
}

/**
 * One failure record inside a test's expandable detail panel: its gated cause (+ confidence), the
 * honest `detail` text, each per-diagnosis line `[scope] code (confidence) — detail`, any flags, and
 * the source. ALL dynamic text (detail / diagnosis strings / source) is escaped — it is user data.
 */
function recordEntry(r: TestFlakeRecordView): string {
  // Key `unsure` off the resolved CATEGORY, not the literal code: the aggregate buckets `category ===
  // null` as unsure — which also covers the taxonomy's first-class `unknown` and any foreign /
  // untaxonomized code. So an `unknown`/foreign record renders honestly as `unsure` here (no confident
  // cause + no confidence badge), exactly how the summary buckets it — never as a confident cause.
  const unsure = r.category === null;
  const cause = unsure
    ? '<span class="cause unsure">unsure</span>'
    : `<span class="cause"><code>${escapeHtml(r.code)}</code> <span class="conf">(${escapeHtml(r.confidence)})</span></span>`;
  const diagLines = r.diagnoses
    .map(
      (d) =>
        `<li>[${escapeHtml(d.scope)}] <code>${escapeHtml(d.code)}</code> <span class="conf">(${escapeHtml(
          d.confidence,
        )})</span>${d.detail ? ` — ${escapeHtml(d.detail)}` : ''}</li>`,
    )
    .join('');
  const flags = recordFlags(r);
  return `
            <li class="rec">
              <div class="rec-head"><span class="rec-run">${escapeHtml(r.runId)}</span>${cause}</div>
              ${r.detail ? `<p class="rec-detail">${escapeHtml(r.detail)}</p>` : ''}
              ${diagLines ? `<ul class="diags">${diagLines}</ul>` : ''}
              <div class="rec-meta">${
                flags.length
                  ? `<span class="flags">${flags.map(escapeHtml).join(' · ')}</span>`
                  : ''
              }<span class="src">source: ${escapeHtml(r.source)}</span></div>
            </li>`;
}

/** The hidden detail row toggled beneath a test row — the per-record explanation panel. */
function detailRow(t: TestFlakeSummary, rank: number): string {
  const entries = t.records.map(recordEntry).join('');
  return `
      <tr class="detail-row" id="dw-detail-${rank}" hidden>
        <td colspan="8">
          <div class="detail">
            <h3>Failure records (${t.records.length})</h3>
            <ul class="recs">${entries}</ul>
          </div>
        </td>
      </tr>`;
}

function testRow(t: TestFlakeSummary, rank: number): string {
  const id = `dw-detail-${rank}`;
  // The summary row carries an accessible toggle button (native <button> ⇒ Enter/Space work) that
  // controls the hidden detail row via aria-controls; JS below flips `hidden` + `aria-expanded`.
  return `
      <tr class="test-row">
        <td class="num">${rank}</td>
        <td class="test">
          <button class="toggle" type="button" aria-expanded="false" aria-controls="${id}"
            aria-label="Show failure detail for ${escapeHtml(t.testId)}">▸</button>
          <code>${escapeHtml(t.testId)}</code>
        </td>
        <td class="num">${t.failures}</td>
        <td class="num">${t.runs}</td>
        <td>${categorySwatch(t.dominantCategory)}</td>
        <td class="num">${pct(t.settleCapRate)}</td>
        <td class="num">${pct(t.disagreementRate)}</td>
        <td class="num${t.unsure > 0 ? ' has-unsure' : ''}">${t.unsure}</td>
      </tr>${detailRow(t, rank)}`;
}

function testsSection(tests: TestFlakeSummary[]): string {
  if (tests.length === 0)
    return `
    <section class="panel empty">
      <h2>No flake records</h2>
      <p>No <code>*.deltawright-sidecar.json</code> artifacts were found in the scanned directories.
      Run your Playwright suite with the <code>deltawright/reporter</code> attached, then point
      <code>deltawright aggregate</code> at the run directories.</p>
    </section>`;

  const rows = tests.map((t, i) => testRow(t, i + 1)).join('');
  return `
    <section class="panel">
      <h2>Most flaky first</h2>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th class="num">#</th><th>Test</th><th class="num">Failures</th><th class="num">Runs</th>
              <th>Dominant category</th><th class="num">Settle-cap</th>
              <th class="num">Disagreement</th><th class="num">Unsure</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

/**
 * The fix-first Actionability Priority panel (reporting A). Renders the cause clusters ranked by shared
 * blast radius × confidence — each row DECOMPOSED (blast radius · confidence · failures), never an opaque
 * score — plus a separate "needs human triage" note for the unsure lane. Returns '' when no priority queue
 * is supplied (the dashboard degrades to its existing panels). All dynamic text is HTML-escaped.
 */
function prioritySection(priority?: PriorityQueue): string {
  if (!priority || (priority.rows.length === 0 && priority.humanLane.length === 0)) return '';
  const rows = priority.rows
    .map(
      (r) => `
            <tr>
              <td class="num">${r.rank}</td>
              <td class="num"><b>${r.blastRadius}</b></td>
              <td>${escapeHtml(r.confidence)}</td>
              <td><code>${escapeHtml(r.code)}</code> <span class="conf">[${escapeHtml(r.category)}]</span>
                ${r.detailSample ? `<p class="rec-detail">${escapeHtml(r.detailSample)}</p>` : ''}</td>
              <td class="num">${r.failures}</td>
              <td class="num">${r.runs}</td>
              <td>${escapeHtml(r.fingerprintSource)}</td>
            </tr>`,
    )
    .join('');
  const humanLane =
    priority.humanLane.length > 0
      ? `<p><b>${priority.humanLane.length}</b> unsure failure${priority.humanLane.length === 1 ? '' : 's'}
         go to their OWN lane — routed to a human, never scored as a cause (silence beats a
         confidently-wrong priority).</p>`
      : '';
  const table =
    priority.rows.length > 0
      ? `<div class="tablewrap">
        <table>
          <thead>
            <tr><th class="num">#</th><th class="num">Tests</th><th>Confidence</th><th>Cause</th>
              <th class="num">Failures</th><th class="num">Runs</th><th>Fingerprint</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      : '';
  return `
    <section class="panel">
      <h2>Fix first — priority by shared root cause</h2>
      <p>Ranked by <b>blast radius × confidence</b> (decomposed — each row shows its components, never one
      opaque score). Blast radius = distinct tests sharing the cause: a <b>fix-once-fix-many candidate</b>,
      a hypothesis, not a guarantee. Playwright's verdict stays authoritative.</p>
      ${humanLane}
      ${table}
    </section>`;
}

function unsurePanel(unsureBucket: number, totalRecords: number): string {
  const share = totalRecords > 0 ? unsureBucket / totalRecords : 0;
  return `
    <section class="panel unsure-panel">
      <h2>Unsure / untaxonomized</h2>
      <p><b>${unsureBucket}</b> of ${totalRecords} failure records (${pct(share)}) could not be
      attributed to a taxonomy category — the reporter's <code>unsure</code> sentinel, an
      untaxonomized cause, or the taxonomy's first-class <code>unknown</code>. These are counted
      <b>apart</b> and are <b>never</b> folded into a real category: silence beats a
      confidently-wrong label.</p>
    </section>`;
}

/**
 * Render a FlakeReport as a self-contained, theme-aware HTML dashboard. Pure — returns a string,
 * writes nothing. Dynamic text (test IDs) is HTML-escaped; all other content is fixed taxonomy data.
 */
export function renderHtml(report: FlakeReport, priority?: PriorityQueue): string {
  const { tests, totalRecords, unsureBucket } = report;
  const subtitle = `${totalRecords} failure record${totalRecords === 1 ? '' : 's'} across ${tests.length} test${tests.length === 1 ? '' : 's'} · ${unsureBucket} unsure`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deltawright — Flake Triage</title>
<style>
  :root {
    --bg:#ffffff; --panel:#f6f8fa; --fg:#1f2328; --muted:#656d76; --border:#d0d7de;
    --accent:#0969da; --code:#eff1f3; --unsure:#8b949e; --shadow:0 1px 3px rgba(31,35,40,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0d1117; --panel:#161b22; --fg:#e6edf3; --muted:#8b949e; --border:#30363d;
      --accent:#58a6ff; --code:#1b222c; --unsure:#8b949e; --shadow:0 1px 3px rgba(1,4,9,.5);
    }
  }
  :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#161b22; --fg:#e6edf3; --muted:#8b949e; --border:#30363d;
    --accent:#58a6ff; --code:#1b222c; --unsure:#8b949e; --shadow:0 1px 3px rgba(1,4,9,.5);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  }
  .wrap { max-width:1080px; margin:0 auto; }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  h1 { font-size:1.5rem; margin:0; }
  h2 { font-size:1.05rem; margin:0 0 .75rem; }
  .sub { color:var(--muted); margin:.25rem 0 0; }
  .stamp { color:var(--muted); font-size:.82rem; margin:.75rem 0 1.5rem; max-width:70ch; }
  button#theme-toggle {
    background:var(--panel); color:var(--fg); border:1px solid var(--border); border-radius:6px;
    padding:.4rem .7rem; font:inherit; font-size:.85rem; cursor:pointer;
  }
  button#theme-toggle:hover { border-color:var(--accent); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1rem; margin-bottom:1.5rem; }
  .card {
    background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:1rem 1.1rem;
    box-shadow:var(--shadow);
  }
  .card .big { font-size:1.9rem; font-weight:650; line-height:1; }
  .card .lbl { color:var(--muted); font-size:.82rem; margin-top:.35rem; }
  .card.unsure { border-left:3px solid var(--unsure); }
  .panel {
    background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:1.25rem;
    margin-bottom:1.5rem; box-shadow:var(--shadow);
  }
  .catbar { display:flex; height:14px; border-radius:7px; overflow:hidden; border:1px solid var(--border); }
  .seg { display:block; height:100%; }
  .seg-unsure {
    background:repeating-linear-gradient(45deg,var(--unsure),var(--unsure) 4px,transparent 4px,transparent 8px);
    background-color:transparent;
  }
  .legend { list-style:none; padding:0; margin:.9rem 0 0; display:flex; flex-wrap:wrap; gap:.35rem 1.1rem; font-size:.85rem; }
  .legend li { display:flex; align-items:center; gap:.4rem; }
  .legend b { font-weight:650; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:2px; flex:0 0 auto; }
  .dot-unsure {
    background:repeating-linear-gradient(45deg,var(--unsure),var(--unsure) 2px,transparent 2px,transparent 4px);
    border:1px solid var(--unsure);
  }
  .chip { display:inline-flex; align-items:center; gap:.4rem; white-space:nowrap; }
  .tablewrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.02em; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:hover { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  td.test code { background:var(--code); padding:.1rem .35rem; border-radius:4px; font-size:.85em; }
  td.test { display:flex; align-items:center; gap:.5rem; }
  td.has-unsure { color:var(--unsure); font-weight:650; }
  code { font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace; }
  button.toggle {
    background:none; border:1px solid var(--border); border-radius:5px; color:var(--muted);
    width:1.5rem; height:1.5rem; line-height:1; padding:0; cursor:pointer; flex:0 0 auto;
    font-size:.8rem; font-family:inherit;
  }
  button.toggle:hover { border-color:var(--accent); color:var(--fg); }
  button.toggle:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .detail-row td { padding:0; background:color-mix(in srgb, var(--accent) 4%, transparent); }
  .detail-row[hidden] { display:none; }
  .detail { padding:.9rem 1.1rem 1.1rem 2.6rem; }
  .detail h3 { font-size:.82rem; text-transform:uppercase; letter-spacing:.02em; color:var(--muted); margin:0 0 .6rem; }
  ul.recs { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.75rem; }
  li.rec { border-left:2px solid var(--border); padding-left:.75rem; }
  .rec-head { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; font-size:.88rem; }
  .rec-run { color:var(--muted); font-size:.8rem; }
  .cause code { background:var(--code); padding:.05rem .3rem; border-radius:4px; }
  .cause.unsure { color:var(--unsure); font-weight:650; }
  .conf { color:var(--muted); font-size:.82rem; }
  .rec-detail { margin:.35rem 0; font-size:.86rem; max-width:80ch; }
  ul.diags { list-style:none; margin:.35rem 0; padding:0; display:flex; flex-direction:column; gap:.2rem; font-size:.82rem; color:var(--muted); }
  ul.diags code { background:var(--code); padding:.02rem .25rem; border-radius:3px; }
  .rec-meta { display:flex; gap:.75rem 1rem; flex-wrap:wrap; font-size:.78rem; color:var(--muted); margin-top:.3rem; }
  .rec-meta .flags { color:var(--accent); }
  .unsure-panel { border-left:3px solid var(--unsure); }
  .unsure-panel p, .empty p { color:var(--muted); margin:0; max-width:75ch; }
  .empty h2 { color:var(--muted); }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Deltawright — Flake Triage</h1>
      <p class="sub">${escapeHtml(subtitle)}</p>
    </div>
    <button id="theme-toggle" type="button" aria-label="Toggle colour theme">◐ Theme</button>
  </header>
  <p class="stamp">Corpus-relative diagnosis; Playwright's verdict is authoritative. Counts are per
  failure record across runs. The unsure bucket is never folded into a category.</p>

  <section class="cards">
    <div class="card"><div class="big">${totalRecords}</div><div class="lbl">Failure records</div></div>
    <div class="card"><div class="big">${tests.length}</div><div class="lbl">Flaky tests</div></div>
    <div class="card unsure"><div class="big">${unsureBucket}</div><div class="lbl">Unsure records</div></div>
  </section>
${prioritySection(priority)}
${categorySection(tests, unsureBucket)}
${testsSection(tests)}
${unsurePanel(unsureBucket, totalRecords)}
</div>
<script>
  (function () {
    var root = document.documentElement;
    var KEY = 'dw-flake-theme';
    try { var saved = localStorage.getItem(KEY); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}
    function current() {
      var attr = root.getAttribute('data-theme');
      if (attr) return attr;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });

    // Expandable test rows: a native button (Enter/Space work) toggles its controlled detail row's
    // hidden attr + its own aria-expanded, flipping the caret glyph. No dependency, keyboard-accessible.
    var toggles = document.querySelectorAll('button.toggle');
    Array.prototype.forEach.call(toggles, function (t) {
      t.addEventListener('click', function () {
        var row = document.getElementById(t.getAttribute('aria-controls'));
        if (!row) return;
        var open = t.getAttribute('aria-expanded') === 'true';
        t.setAttribute('aria-expanded', open ? 'false' : 'true');
        t.textContent = open ? '▸' : '▾'; // ▸ collapsed / ▾ expanded
        if (open) row.setAttribute('hidden', ''); else row.removeAttribute('hidden');
      });
    });
  })();
</script>
</body>
</html>
`;
}
