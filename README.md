# Deltawright

[![CI](https://github.com/mstomar698/deltawright/actions/workflows/ci.yml/badge.svg)](https://github.com/mstomar698/deltawright/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mstomar698/deltawright?sort=semver&color=3fb950)](https://github.com/mstomar698/deltawright/releases)
[![License: MIT](https://img.shields.io/github/license/mstomar698/deltawright?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](package.json)
[![Built on Playwright](https://img.shields.io/badge/built%20on-Playwright-2EAD33)](https://playwright.dev)

**A delta-and-actionability layer for Playwright agents: it tells the agent what
changed after an action and whether it can act on it.**

Deltawright is *not* a browser and *not* a Playwright replacement. It sits on top
of Playwright + headless Chromium and, instead of dumping and re-dumping
accessibility snapshots, turns a single action into a compact structured delta:
what changed on the page, where it is, and whether it's actually actionable — using
Playwright's own actionability judgment so the verdict matches reality.

> Positioning: *Playwright MCP tells the agent what's on the page. Deltawright tells
> it what just changed and whether it can act on it.* Use both.

---

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

Requires **Node ≥ 20**. Full API and options are in **[Use it](#use-it)** below; to drive it
from an agent, see **[Use it as an MCP server](#use-it-as-an-mcp-server)**.

## The gap it closes

Agent-facing browser tools (Playwright MCP, Chrome DevTools MCP) represent pages as
accessibility snapshots that are **layout-independent** — no geometry — and that
**list every DOM element regardless of viewport** (an open Playwright issue,
[#39955](https://github.com/microsoft/playwright/issues/39955)). So an element that
"exists" but is covered by an overlay, off-screen, or `pointer-events:none` shows up
as if directly interactive, the agent picks it, and the real click fails. And to
learn *what a click did*, you diff a full before/after snapshot yourself.

Deltawright inverts the loop: **delta-first**. Arm a `MutationObserver`, perform one
action, wait for settle, and emit a tiny delta of the changed nodes only — each with
geometry and an actionability verdict reconciled against Playwright.

## The proof (v0.1)

A button that opens a popup (inserted after a delay, with a CSS entrance animation):

```
after click "Open popup":
  + dialog "Session expired" [e1] @ (320,160 380x154) topmost ACTIONABLE
    + button "Renew" [e2] @ (341,213 79x35) ACTIONABLE
    + button "Cancel" [e3] @ (430,213 79x35) ACTIONABLE
    + textbox "Password" [e4] @ (341,260 338x33) ACTIONABLE
```

- **101 tokens** (cl100k proxy). 2 raw `MutationRecord`s coalesced to 4 reported nodes. No before/after diff.
- Settle quiesced at ~340 ms; 2 CSS animations awaited so the geometry is final, not mid-animation.
- Geometry and Playwright **agree on every node**.

The two dimensions the a11y snapshot lacks — geometry and actionability — are the
whole point. When the same button is **covered** or the element is **off-screen**:

```
CASE 2 — popup partly covered by an overlay
  a11y snapshot says : - button "Renew"          <- looks directly interactive
  deltawright says   : Renew -> NOT-actionable (covered-by div.dw-overlay)
  reality check      : real Playwright click FAILED -> verdict MATCHED reality ✓

CASE 3 — element inserted off-screen
  a11y snapshot says : - button "Ghost action"   <- looks directly interactive
  deltawright says   : Ghost action -> NOT-actionable (off-screen)
  reality check      : real Playwright click FAILED -> verdict MATCHED reality ✓
```

Run it yourself:

```bash
npm install
npx playwright install chromium   # if not already cached
npm run demo                      # the three cases above
npm test                          # the full suite: units + live-page validation + packaging
npm run build                     # emit the distributable to dist/ (ESM + types + bins)
```

## Use it

Install it alongside Playwright, which is a **peer** dependency (bring your own):

```bash
npm install deltawright
npm install -D @playwright/test   # if you don't already have it
```

```ts
import { chromium } from '@playwright/test';
import { actAndObserve, render } from 'deltawright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

const delta = await actAndObserve(page, (p) => p.click('#sign-in'), {
  label: 'click "Sign in"',
});

const { text, tokens } = render(delta);
console.log(text);      // the compact delta above
console.log(tokens);    // measured token size

// Structured access:
for (const node of delta.nodes) {
  node.name;                       // "Renew"
  node.geometry?.rect;             // { x, y, width, height }
  node.actionability.verdict;      // 'ACTIONABLE' | 'NOT-actionable' | 'n/a'
  node.actionability.reason;       // 'covered-by div.dw-overlay' | 'off-screen' | ...
  node.actionability.agreed;       // did geometry & Playwright agree?
}
```

`actAndObserve(page, action, opts?)` options: `label`, and settle tunables
`quietMs` (120), `maxWaitMs` (2000), `animMaxMs` (1000), plus `trialTimeoutMs` (1200).

When the geometry read and Playwright disagree, **Playwright wins** and the delta
surfaces what geometry thought — e.g. a visible-but-disabled button:

```
~ button "Submit" [e2] @ (336,416 78x33) NOT-actionable (disabled) [geom:ACTIONABLE]
```

The verdict is **role-aware** (#17): it matches the action an agent would use — `click`
for buttons/links, `fill` for text inputs (so a *covered* input is actionable but a
*read-only* one is not), `selectOption` for selects. Playwright's judgment wins.

## Use it as an MCP server

Deltawright ships a stdio MCP server so agents consume deltas natively — *Playwright MCP
tells the agent what's on the page; Deltawright tells it what just changed and whether it
can act on it.*

```bash
deltawright mcp        # the installed bin (alias: deltawright-mcp)
npm run mcp            # from a source checkout (tsx), equivalent
```

Tools: **`navigate`** (open a URL → its a11y snapshot), **`act_and_observe`** (perform one
`click`/`fill`/`select`/`check`/`press` on a selector → the compact delta, *instead of*
re-snapshotting), and **`snapshot`** (full-tree fallback). Point Claude Code / Cursor at it
via their MCP config — installed: `command: "npx"`, `args: ["deltawright-mcp"]`; or from a
source checkout: `command: "npx"`, `args: ["tsx", "src/mcp/server.ts"]`.

## Preflight actionability matcher

For test suites, `deltawright/matchers` adds a fail-fast assertion on Playwright's *own*
actionability verdict — no `actAndObserve` needed:

```ts
import { expect } from '@playwright/test';
import { dwMatchers } from 'deltawright/matchers';
expect.extend(dwMatchers);

await expect(page.getByRole('button', { name: 'Submit' })).toBeActionable();
```

The verdict is **role-aware** (click-trial for buttons/links, `fill`-editable for text inputs,
`selectOption`-enabled for selects) and is Playwright's — geometry only annotates a `[geom:]`
disagreement in the failure message and **never flips the boolean** (DW-02). It works standalone and
degrades to a Playwright-only verdict under a strict CSP / non-Chromium. Or read the structured
result: `const { verdict, reason, geometryVerdict, agreed } = await preflight(locator)`.

The same module adds a **delta checksum regression** matcher:

```ts
expect(delta).toMatchDeltaChecksum('submit-opens-dialog'); // or .toMatchDeltaSnapshot()
```

It matches across pixel/timing jitter but fails on a **verdict or tree change**, storing baselines in
`__dw_checksums__/` (refresh with `DW_UPDATE_CHECKSUMS=1`, `--update-snapshots`, or
`deltawright checksum --update`) and rendering a structural diff on mismatch. A green checksum is
**regression-only** — it proves the delta's structure is unchanged, not that it's correct.

## Flake-triage reporter (zero-edit)

Add one line to `playwright.config.ts` and every failed test gets a taxonomy-labeled triage side-car,
with **no per-test changes**:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['deltawright/reporter']],
});
```

For each failed / timed-out test it writes `*.deltawright-sidecar.json` + `*.triage.txt` — never on a
passing test, never altering pass/fail. The cause comes from the same `diagnose()` engine (the failing
Playwright error is diagnosed as a synthetic delta); a low-confidence cause is reported as **`unsure`**
and a locator that was already gone degrades to **detached** — it never fabricates. Attach a real
delta with `attachDelta(testInfo, delta)` for a geometry-grounded diagnosis that also carries the
late-wave / stale-rect flags.

### CI in one step — the GitHub Action

With the reporter attached, add one step after your Playwright run to post a taxonomy-labeled,
**sticky** PR triage comment and upload the HTML flake dashboard (`deltawright aggregate --html`) as an
artifact. It is read-only and **degrades to nothing on a green run** (no side-cars → no comment, no
artifact):

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
      - uses: mstomar698/deltawright@main # pin to a tag once one includes the action
        with:
          # Relative to the repo root. The reporter resolves its outputDir against Playwright's
          # rootDir, so if your config is in a subdir, prefix it — e.g. e2e/deltawright-triage.
          results-dir: deltawright-triage
```

Inputs: `results-dir` (where the side-cars are, relative to the repo root — see the note above for a
subdir config), `version` (npm version to run, default `latest`), `comment` (default `true`),
`dashboard-artifact` (name, empty to skip), `github-token`. It uses the built-in token via `gh` (no
third-party action, no bespoke secret). The report text is HTML-escaped into the comment, so a
malicious test name can't inject Markdown.

## How it works

```
arm  → MutationObserver on document, buffering records
act  → your action, run through Playwright (inherits auto-wait + actionability)
settle → quiet for quietMs after the first mutation (capped at maxWaitMs),
         then await running animations so geometry is final
collect → coalesce records into a net {added, removed, attrChanged, textChanged}
          set of elements; read rect + computed style + elementFromPoint per node;
          stamp data-dw-ref
annotate → per node, reconcile the geometry read with Playwright's authoritative
           click({ trial: true }) verdict — Playwright wins any disagreement
serialize → the compact §3 text format + token count
```

- Injected page script: [`src/injected/observer.ts`](src/injected/observer.ts)
- Host wrapper: [`src/host/actAndObserve.ts`](src/host/actAndObserve.ts),
  [`actionability.ts`](src/host/actionability.ts),
  [`serialize.ts`](src/host/serialize.ts)

## What v0.1 proves — and what it doesn't

**Proven, on a controlled DOM page:** the core primitive works end-to-end — a click
yields a correct, token-tiny, structured delta with geometry and a pointer-actionability
verdict, with no before/after diff; and on the covered/off-screen/disabled cases the
verdict agrees with what a real Playwright action then does.

**Stated plainly — not proven:**

- **No token win here.** The delta is 101 tokens vs an 87-token full-page a11y
  snapshot of the same page — the delta is *larger*, not smaller. And the real
  incumbent (snapshot **before + after + diff**) was not measured. Token savings are
  an unmeasured large-SPA extrapolation; "token-tiny in absolute terms (~100 tokens)"
  is honest, "cuts tokens vs the incumbent" is not shown.
- **The trial↔real match is internal consistency, not independent ground truth.** The
  verdict *is* a Playwright trial-click and the reality check *is* a Playwright real
  click — the same engine, so agreement is near-tautological. The genuinely
  independent evidence is the **a11y-snapshot-says-interactive vs delta-says-NOT-actionable**
  contrast in cases 2–3.
- **Only ran on a synthetic fixture.** The ideation §10 bar ("on your own real target
  app") is *not* met; v0.1 clears a narrower engineering sub-bar. Mutation-noise
  filtering (§6.2) is untested — attribution here is time-window-scoped, not causal.
  See `docs/summaries/v0.1-milestone.md` for the honest go/no-go.

What v0.1 *does* demonstrate is the two dimensions the snapshot lacks entirely —
geometry and a pointer-actionability verdict — shown by cases 2–4.

**Update — v0.5 real-app benchmark (#23, directional).** On a real React SPA the
large-page token win *is* now measured (`npm run bench`,
[findings](docs/summaries/v0.5-real-app-benchmark-findings.md)): the delta is **~1% of a
full re-snapshot** on a large table, and **0.15–0.87× the before+after diff at information
parity** — a real win. The predicted live-SPA weaknesses were confirmed and then **fixed**:
robust settle (#13) stops the cap, causal attribution (#15) excludes background churn, and
bounded-concurrent reconciliation (#18) removes the O(nodes) time cost. On a live, 300-cell
churning page the delta is now **identical to a quiet page** — noise_ratio 76× → **1.0**,
null-action false positives 301 → **0**, delta 8958 → **99 tokens**, i.e. ~1% of the
before+after diff (which has no causal attribution). Still one framework / not the full §10
verdict (#25).

## Deferred to v0.5

- **Robust settle detection** (the #1 thing to harden — see `docs/decisions/design-watches.md` DW-01). v0.1 is a simple quiescence heuristic.
- **Mutation-noise filtering** on real React/Vue/Angular apps (a semantic-attribute whitelist; today attr changes on surviving elements are reported by name, though churn that nets to the original is already dropped).
- **Role-aware actionability probes** (`fill`/`selectOption`/`hover` editability) so the verdict matches the *specific* action, not just click.
- **Shadow DOM + same-origin iframe** traversal.
- ~~**Screenshot-diff fallback** for canvas/WebGL and cross-origin regions~~ — shipped (#20, opt-in `screenshotFallback`).
- ~~**MCP server** surface~~ — shipped (#22). ~~**Distributable JS build**~~ — shipped (#45): `npm install deltawright` resolves a real `dist/` (ESM + types + `deltawright`/`deltawright-mcp` bins).
- **Test-gen opinion**: stable-selector candidates and assertion suggestions per changed node.
- Cross-browser (Firefox/WebKit) and terminal observability (human, not agent, input).

## Project docs

- **[`docs/cookbook.md`](docs/cookbook.md)** — problem → capability → one-line wiring, plus the
  honest-limits matrix (Chromium-only, CSP skip-with-reason, overhead, ephemeral refs, corpus-relative
  accuracy).
- `docs/specs/ideation-agent-delta-layer.md` — the binding design doc.
- `docs/plans/`, `docs/specs/`, `docs/decisions/`, `docs/contexts/`, `docs/summaries/` — the SDLC trail.
- `CONTRIBUTING.md` — how to build, test, and open a PR.

## License

MIT — see [LICENSE](LICENSE).
