# Deltawright

[![npm](https://img.shields.io/npm/v/deltawright?color=cb3837&logo=npm)](https://www.npmjs.com/package/deltawright)
[![CI](https://github.com/mstomar698/deltawright/actions/workflows/ci.yml/badge.svg)](https://github.com/mstomar698/deltawright/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/mstomar698/deltawright?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](package.json)
[![Built on Playwright](https://img.shields.io/badge/built%20on-Playwright-2EAD33)](https://playwright.dev)

**A delta-and-actionability layer for Playwright agents: it tells the agent what changed after an action and whether it can actually act on it.**

Deltawright is *not* a browser and *not* a Playwright replacement. It sits on top of Playwright + headless Chromium and, instead of dumping and re-dumping accessibility snapshots, turns a single action into a compact structured **delta**: what changed on the page, where it is, and whether it's actionable — using Playwright's *own* actionability judgment so the verdict matches reality.

> Positioning: *Playwright MCP tells the agent what's on the page. Deltawright tells it what just changed and whether it can act on it.* Use both.

---

## The gap it closes

Agent-facing browser tools (Playwright MCP, Chrome DevTools MCP) represent pages as accessibility snapshots that are **layout-independent** — no geometry — and that **list every DOM element regardless of viewport** (an open Playwright issue, [#39955](https://github.com/microsoft/playwright/issues/39955)). So an element that "exists" but is covered by an overlay, off-screen, or `pointer-events:none` shows up as if directly interactive, the agent picks it, and the real click fails. And to learn *what a click did*, you diff a full before/after snapshot yourself.

Deltawright inverts the loop: **delta-first**. Arm a `MutationObserver`, perform one action, wait for settle, and emit a tiny delta of the changed nodes only — each with geometry and an actionability verdict reconciled against Playwright.

## Quickstart

```bash
npm install deltawright @playwright/test
```

```ts
import { chromium } from '@playwright/test';
import { actAndObserve, render } from 'deltawright';

const page = await (await chromium.launch()).newPage();
await page.goto('https://example.com');

// one action → a compact, actionability-annotated delta of what changed
const delta = await actAndObserve(page, (p) => p.click('#sign-in'), { label: 'click "Sign in"' });
console.log(render(delta).text);
```

Requires **Node ≥ 20**. `@playwright/test` is a **peer** dependency — bring your own.

## The core primitive: `actAndObserve`

`actAndObserve(page, action, opts?)` runs **one** action through Playwright and returns a compact `Delta` of what changed — no before/after full snapshot. A button that opens a popup (inserted after a delay, with a CSS entrance animation) yields:

```
after click "Open popup":
  + dialog "Session expired" [e1] @ (320,160 380x154) topmost ACTIONABLE
    + button "Renew" [e2] @ (341,213 79x35) ACTIONABLE
    + button "Cancel" [e3] @ (430,213 79x35) ACTIONABLE
    + textbox "Password" [e4] @ (341,260 338x33) ACTIONABLE
```

Nodes nest by DOM containment. Each node carries geometry `@ (x,y WxH)` and a Playwright-reconciled verdict. The two dimensions an a11y snapshot lacks — **geometry** and **actionability** — are the whole point. When the same target is **covered** or **off-screen**, the snapshot still lists it as interactive but the delta calls it correctly:

```
- button "Renew"      (a11y snapshot: looks directly interactive)
  deltawright:  NOT-actionable (covered-by div.dw-overlay)   ← a real click then FAILS

- button "Ghost"      (a11y snapshot: looks directly interactive)
  deltawright:  NOT-actionable (off-screen)                  ← a real click then FAILS
```

### Structured access

```ts
import { actAndObserve, render } from 'deltawright';

const delta = await actAndObserve(page, (p) => p.click('#sign-in'), { label: 'click "Sign in"' });

const { text, tokens } = render(delta);
console.log(text);    // the compact delta above
console.log(tokens);  // measured token size

for (const node of delta.nodes) {
  node.name;                     // "Renew"
  node.geometry?.rect;           // { x, y, width, height }
  node.actionability.verdict;    // 'ACTIONABLE' | 'NOT-actionable' | 'n/a'
  node.actionability.reason;     // 'covered-by div.dw-overlay' | 'off-screen' | ...
  node.actionability.agreed;     // did geometry & Playwright agree?
}
```

`delta` is `{ action, nodes, stats }`. `stats` always reports `rawRecords`, `settleMs`, `hitMaxWait`, `animationsAwaited`, `droppedBackground`, and adds fields such as `lateStructural`, `recurringInsert`, `crossBoundarySkipped`, or `injectionBlocked` only when the corresponding condition actually fired.

### Role-aware verdict — Playwright wins

The verdict is **role-aware**: it matches the action an agent would use — `click` for buttons/links, `fill` for text inputs (so a *covered* input is actionable but a *read-only* one is not), `select` for `combobox`. The authoritative probe is Playwright's own — for a click it is a real `click({ trial: true })` including the pointer hit-test. When the geometry read and Playwright disagree, **Playwright wins**, and the delta surfaces what geometry thought via a trailing marker:

```
~ button "Submit" [e2] @ (336,416 78x33) NOT-actionable (disabled) [geom:ACTIONABLE]
```

Geometry called it clickable; Playwright called it `disabled`. The verdict is Playwright's; `[geom:ACTIONABLE]` is only the disagreement signal this library exists to surface.

### Options

`actAndObserve(page, action, opts?)` accepts:

| Option | Default | What it does |
| --- | --- | --- |
| `label` | `'action'` | Text in the serialized header (`after <label>:`) |
| `quietMs` | `120` | Declare settled after the DOM is quiet this long |
| `maxWaitMs` | `2000` | Hard cap on the post-action settle wait (excludes Playwright's own auto-wait on the action) |
| `animMaxMs` | `1000` | Budget to wait out CSS animations/transitions before reading geometry |
| `trialTimeoutMs` | `1200` | Per-node authoritative Playwright trial-probe timeout |
| `reconcileConcurrency` | `12` | Bounded concurrency so a delta of many not-actionable nodes doesn't pay `N × trialTimeout` serially |
| `baseline` | `true` | Causal attribution — samples pre-action churn and excludes it; `baseline: false` disables (`baselineMs`, `baselineEarlyExitMs` tune it) |
| `inWindowRecurrence` | `false` | Anchor-aware background rescue; keeps (never drops) uncertain nodes |
| `lateWatchMs` | `0` | Detect a late structural wave after settle (flag, never fix — sets `stats.lateStructural`) |
| `rectRecheckMs` | `0` | After the authoritative probe, re-read rects; a `>2px` move adopts the later rect and marks geometry unstable — Playwright's verdict is never touched |
| `frames` | `false` | Same-origin child-frame traversal; child refs are prefixed and offset to page-global coords; cross-origin frames increment `crossBoundarySkipped` |
| `screenshotFallback` | `false` | DOM-less fallback: when nothing changed in the DOM, a screenshot-diff emits one synthetic pixel region (`tag: 'canvas-region'`, verdict `n/a`); `pixelThreshold`, `minPixels` tune it |

If injection is blocked (e.g. strict CSP forbids `addScriptTag`), `actAndObserve` **still runs the action** and returns an empty delta with `stats.injectionBlocked = true` — it degrades, it does not throw.

## Serialize + regression checksum

- `render(delta, opts?)` → `{ text, tokens }`; `serialize(delta, opts?)` → the text alone; `tokenCount(text)` → a token count. The tokenizer is pinned to `gpt-tokenizer` (cl100k) as an **OpenAI proxy** — absolute counts are approximate, so **ratios**, not absolute numbers, are the robust signal.
- Diagnostics are **opt-in** (`serialize(delta, { diagnostics: true })`); off by default the output is byte-stable.
- `checksum(delta)` = `sha256(normalizeDelta(delta))` — a fingerprint of the delta's **structure + semantics** (kind, tag, role, verdict, geometry-agreement, coarse size bucket, changed-attribute *names*, and the tree edges) with run-to-run jitter (raw refs, pixel rects, timing, obfuscated class hashes) deliberately dropped. A matching checksum proves the output is unchanged — a **regression** guard — nothing more.

## Preflight actionability matcher

For test suites, `deltawright/matchers` adds a fail-fast assertion on Playwright's *own* role-aware actionability verdict — no `actAndObserve` needed:

```ts
import { expect } from '@playwright/test';
import { dwMatchers } from 'deltawright/matchers';
expect.extend(dwMatchers);

await expect(page.getByRole('button', { name: 'Submit' })).toBeActionable();
```

The verdict **is Playwright's** — geometry only annotates a `[geom:]` disagreement in the failure message and **never flips the boolean**. It works standalone and degrades to a Playwright-only verdict under a strict CSP or a non-Chromium browser. Read the structured result directly with `preflight(locator)`:

```ts
import { preflight } from 'deltawright/matchers';
const { verdict, reason, geometryVerdict, agreed } = await preflight(locator);
```

The same module adds a **delta checksum regression** matcher:

```ts
expect(delta).toMatchDeltaChecksum('submit-opens-dialog'); // or .toMatchDeltaSnapshot()
```

It tolerates pixel/timing jitter but fails on a **verdict or tree change**, storing baselines in `__dw_checksums__/` (refresh with `DW_UPDATE_CHECKSUMS=1`, `--update-snapshots`, or `deltawright checksum --update -- <cmd>`) and rendering a structural diff on mismatch. `matchDeltaChecksum(delta, file)` is available as a plain function too. `verifySuggestions(root, delta)` rounds each `suggest(delta)` selector candidate through the live page and re-ranks verified-first, for stable-selector / assertion generation.

## Use it as an MCP server

Deltawright ships a stdio MCP server so agents consume deltas natively:

```bash
deltawright-mcp          # the installed bin
deltawright mcp          # equivalent
npm run mcp              # from a source checkout (tsx)
```

Point Claude Code / Cursor at it via their MCP config — installed: `command: "npx"`, `args: ["deltawright-mcp"]`. Registered tools:

| Tool | What it does |
| --- | --- |
| `navigate` | Open a URL and return its accessibility snapshot |
| `act_and_observe` | Perform ONE action (`click`/`fill`/`select`/`check`/`press`) and return the compact delta + actionability, *instead of* re-snapshotting |
| `snapshot` | Full accessibility snapshot of the current page (fallback) |
| `preflight` | Probe one selector and return Playwright's verdict, geometry's conclusion, and whether they agreed — read-only |
| `observe_settle` | Perform one action and report the settle signal (quiet time, whether it hit the cap, late wave) |
| `explain_delta` | Perform one action and return its delta with the root-cause diagnostics section |
| `diagnose` | Perform one action and return the gated taxonomy read `{category, confidence, unsure, geomDisagreement}`; stays `unsure` when no cause crosses the confidence gate |

## Flake-triage reporter (zero-edit)

Add one line to `playwright.config.ts` and every failed test gets a taxonomy-labeled triage side-car, with **no per-test changes**:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['deltawright/reporter']],
});
```

For each finally-failed / timed-out test it writes `*.deltawright-sidecar.json` + `*.triage.txt` — **never on a passing, skipped, or flaky-then-passed test, and never altering pass/fail**. The cause comes from the same `diagnose()` engine (the Playwright error is diagnosed as a synthetic delta); a low-confidence cause is reported as **`unsure`** and a locator that was already gone degrades to **`detached`** — it never fabricates. Attach a real delta with `attachDelta(testInfo, delta)` for a geometry-grounded diagnosis.

### Aggregate flake dashboard

`deltawright aggregate` folds the reporter's side-cars into a ranked, most-flaky-first report — **read-only, it writes nothing itself**:

```bash
deltawright aggregate <dir> [<dir> ...]            # JSONL to stdout (default)
deltawright aggregate --report <dir> [<dir> ...]   # compact human-readable summary
deltawright aggregate --html   <dir> [<dir> ...]   # self-contained, theme-aware HTML dashboard
```

Unrecognized or below-threshold causes land in a separate **unsure** bucket rather than being force-labeled.

### CI in one step — the GitHub Action

With the reporter attached, add one step after your Playwright run to post a taxonomy-labeled, **sticky** PR triage comment and upload the HTML flake dashboard as an artifact. It is read-only and **degrades to nothing on a green run** (no side-cars → no comment, no artifact):

```yaml
# .github/workflows/e2e.yml
permissions:
  contents: read
  pull-requests: write # so the action can post the triage comment
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      # … checkout, setup-node, install, then run Playwright with deltawright/reporter attached …
      - run: npx playwright test
        continue-on-error: true # let triage run even when tests fail
      - uses: mstomar698/deltawright@main
        with:
          results-dir: deltawright-triage # relative to the repo root
```

Inputs: `results-dir`, `version` (default `latest`), `comment` (default `true`), `dashboard-artifact`, `github-token`. It uses the built-in token via `gh` (no third-party action, no bespoke secret), and HTML-escapes report text into the comment so a malicious test name can't inject Markdown.

## Observe consequences without a locator: `deltawright/wait`

`observeConsequences(page, action, opts?)` arms the observer, performs one action, waits for structural quiescence, and returns a `ConsequenceObservation` (`settleMs`, `hitMaxWait`, `suspectedEarly`, `observed`, and an optional `skippedReason`). It skips the per-node reconcile, so it's a lightweight settle **signal**:

```ts
import { observeConsequences } from 'deltawright/wait';

const obs = await observeConsequences(page, (p) => p.click('#load-more'));
if (obs.hitMaxWait) console.warn('never settled within the cap');
```

It is explicitly a *signal*, not a readiness guarantee, a retry, or a flake suppressant.

## Diagnose a failing trace, offline

Already have a `trace.zip` from a failed CI run? Explain the failing action **without re-running it** — no browser, no flake, no reproduction:

```bash
deltawright diagnose-trace test-results/my-failed-test/trace.zip
```

It takes a single trace per invocation. It reads the trace's failing action + its retry call-log, runs the **same** `diagnose()` engine, and prints a root cause:

```
deltawright diagnose-trace — trace.zip
trace v8 · playwright 1.61.1 · chromium · OFFLINE reconstruction (no re-run, no browser)
failed action: click #submit
────────────────────────────────────────────────────────────────────────
after click #submit:
  ~ element [e1] NOT-actionable (unknown)
diagnostics:
  [e1] covered-by-overlay (suspected) — Playwright NOT-actionable (… <div class="modal-glass"> intercepts pointer events)
────────────────────────────────────────────────────────────────────────
cause: covered-by-overlay (suspected)
```

**Honest by construction.** Every offline cause is **`suspected`, never `confirmed`** — it is reconstructed from the trace's error string, not observed live, so geometry, the live verdict, and the observer stats are simply not available. A failure that is not a recognized Playwright *actionability* error (an assertion diff, an app error) or whose locator never resolved stays **`unsure`** — a cause is never fabricated. The unzip is dependency-free (Node's built-in `zlib`) and refuses (never guesses) ZIP64/encrypted members; an unrecognized trace `version` **fails loud** rather than mis-parsing. It reads standard `@playwright/test` traces (v8); it never re-runs, retries, or changes anything.

## How it works

```
arm     → MutationObserver on document, buffering records
act     → your action, run THROUGH Playwright (inherits auto-wait + actionability on the target)
settle  → quiet for quietMs after the most-recent mutation (the quiet window resets on
          each change; capped at maxWaitMs), then await running animations so geometry
          is final, not mid-animation
collect → coalesce records into a net {added, removed, attrChanged, textChanged} set;
          read rect + computed style + elementFromPoint per node; stamp data-dw-ref
annotate → per node, reconcile the geometry read with Playwright's authoritative
           verdict (click({ trial: true }) for clicks) — Playwright wins any disagreement
serialize → the compact text format + token count
```

Every diagnosis maps to a code in a **closed, versioned taxonomy** (or `unknown`), banded by confidence: an authoritative Playwright/geometry+Playwright source yields `confirmed`; a geometry- or timing-only hypothesis is at most `suspected`; conflicting evidence only ever downgrades.

- Host wrapper: [`src/host/actAndObserve.ts`](src/host/actAndObserve.ts), [`actionability.ts`](src/host/actionability.ts), [`serialize.ts`](src/host/serialize.ts), [`diagnose.ts`](src/host/diagnose.ts), [`taxonomy.ts`](src/host/taxonomy.ts)

## What it does NOT do

Deltawright **observes and explains**. It is deliberately *not* an actionability fixer:

- **It never fixes, retries, suppresses, or force-clicks.** It cannot dismiss an overlay, re-enable a control, or make a covered / disabled / off-screen element clickable. Those `NOT-actionable` verdicts are *correct*, and rescuing them would be a bug, not a feature.
- **Playwright's actionability verdict is authoritative and never overridden.** `ACTIONABLE` ⇔ a real Playwright action would succeed. When geometry and Playwright disagree, Playwright wins; geometry only annotates the disagreement with `[geom:…]` and never flips the boolean.
- **A diagnosis is a hypothesis, never a contradiction of the verdict.** A cause is `confirmed` only when an authoritative engine *named* it; a geometry- or timing-only signal is at most `suspected`; when nothing crosses the confidence gate the answer is **`unsure`**. The design goal, stated plainly: **unsure beats confidently wrong.**
- **When attribution is uncertain, it keeps.** A false-keep (leaking a little background churn) is a tolerable quality bug; a false-drop would destroy trust, so uncertain nodes are never silently dropped.
- **A green checksum is regression-only** — it proves the delta's structure is unchanged, not that it is correct.
- **It is additive, not substitutive.** Playwright MCP still tells the agent what's on the page; Deltawright tells it what just changed and whether it can act. Use both.

### Known limits

- The observer is **Chromium/DOM-based**. Under a strict CSP or a non-Chromium browser it degrades to a Playwright-only verdict (or an empty delta flagged `injectionBlocked`) rather than guessing.
- Same-origin child-frame traversal is **opt-in** (`frames`); cross-origin frames are skipped and counted, not descended into.
- The delta is **token-tiny in absolute terms**; the token win is on large, churning pages versus a full re-snapshot — not on trivial ones (measure your own targets with `npm run bench`).
- Settle is a **labeled, tunable heuristic** (`quietMs` / `maxWaitMs` / `animMaxMs`), not a hard readiness guarantee — an empty delta at the cap is reported as a *suspected miss*, not silence.
- The screenshot fallback is opt-in and **coarse**: one pixel region with verdict `n/a`, for canvas/WebGL/cross-origin areas the DOM can't describe.

## Project docs

- **[`docs/cookbook.md`](docs/cookbook.md)** — problem → capability → one-line wiring, plus the honest-limits matrix (Chromium-only, CSP skip-with-reason, overhead, ephemeral refs, corpus-relative accuracy).
- `docs/specs/ideation-agent-delta-layer.md` — the binding design doc.
- `docs/plans/`, `docs/specs/`, `docs/decisions/`, `docs/contexts/`, `docs/summaries/` — the SDLC trail.
- `CONTRIBUTING.md` — how to build, test, and open a PR.

## License

MIT — see [LICENSE](LICENSE).

---

## TL;DR

Deltawright is a thin layer on Playwright + Chromium for AI agents and test suites. Instead of re-dumping accessibility snapshots, `actAndObserve` turns **one action into a compact delta** of the nodes that changed — each with **geometry** and a **role-aware actionability verdict** reconciled against Playwright, whose judgment is always authoritative (`[geom:…]` only annotates disagreement, never overrides it). Around that core it ships a **preflight** matcher and checksum-regression matchers, a **stdio MCP server**, a **zero-edit flake-triage reporter** with an aggregate dashboard and one-step GitHub Action, a locator-free settle signal (`observeConsequences`), and an **offline `diagnose-trace`** that root-causes a `trace.zip` without re-running it. Throughout, a diagnosis is a confidence-banded *hypothesis* from a closed taxonomy — `confirmed` only from an authoritative source, otherwise `suspected` or **`unsure`**. It observes and explains; it never fixes, retries, or force-clicks. Unsure beats confidently wrong.
