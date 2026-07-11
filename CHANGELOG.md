# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.4] - 2026-07-11

### Added

- **Post-action background-churn detection** (Wave-2 #7): the diagnosis engine now flags a container
  that **starts churning after the action** (a polling feed, a live-updating region) — invisible to
  the pre-arm baseline — as `background-churn` (**suspected**), completing the residual the pre-arm
  baseline missed. The observer tracks in-window insertion recurrence; `background-churn` fires when a
  non-baseline signature recurs past a conservative threshold **and** the churn kept settle from
  quiescing (`hitMaxWait`) — so a list that appears and goes quiet is not flagged. (Honest residual: a
  legitimate but slow/large streamed payload that also caps trips the **suspected** flag too —
  tolerated because #7 only flags, never drops; see ADR.) Exposed as a new default-absent
  `DeltaStats.recurringInsert`, so a normal page's stats object is byte-unchanged.
  - **Non-behavioral + safe by design:** settle timing and delta membership are **unchanged** — the
    recurring nodes are kept, not dropped. Per the #30 in-window decision, in-window signal must
    **flag, not drop** (a false-drop of a real streamed payload is the one unforgivable error); and
    the settle-promptness optimization is deferred pending real-app corpus telemetry rather than tuned
    blindly (it shares the same false-early hazard). ADR 2026-07-11.

## [0.7.3] - 2026-07-11

First Wave-2 (correctness depth) release: a page-aware durable-selector recommender. Plus the Wave-1
composite GitHub Action (infra).

### Added

- **Durable-selector recommender** (Wave-2 #6, `deltawright/matchers`): `verifySuggestions(page, delta)`
  — a page-aware layer over the pure `suggest()` (which #57 punted). It rounds each suggested selector
  through the live page: `locator.count()` for uniqueness and same-element identity (via Playwright's
  `.and()` against the delta's `data-dw-ref`), classifying each `verified` / `ambiguous` /
  `unique-elsewhere` / `unconfirmed` / `broken`, re-ranking verified-first, and surfacing a paste-ready
  `bestVerified` — or **`null` with a warning when nothing resolves uniquely** (DW-03: stay unsure).
  Suggested `toBeActionable()` assertions are re-pointed onto each node's verified selector (dropped,
  with a warning, when a node has none), so it never hands back an assertion built on a selector it
  proved ambiguous. `suggest()` stays pure and unchanged. Honest limit: "stability" is single-page
  uniqueness + same-element identity, **not** cross-render history (no selector store exists to back
  that). ADR 2026-07-11.

### Added (infrastructure — not shipped in the npm package)

- **Composite GitHub Action** (Wave-1 #4, repo-root `action.yml`): one `uses: mstomar698/deltawright@<ref>`
  step turns the reporter's triage side-cars into a taxonomy-labeled **sticky** PR comment (updated in
  place, not spammed) plus a self-contained HTML flake dashboard artifact. Read-only; **degrades to
  nothing on a green run**. Consumes the side-car dir (does not run your suite), uses `gh` + the
  built-in token (no third-party action, no bespoke secret), needs only `pull-requests: write`. See the
  README "CI in one step" section. ADR 2026-07-11.

## [0.7.2] - 2026-07-11

### Changed

- **Checksum now distinguishes which state attribute changed** (Wave-1 #3): the delta fingerprint
  (`checksum` / `toMatchDeltaChecksum` / `toMatchDeltaSnapshot`) folds each `attrChanged` node's
  changed attribute **names**, filtered to a stable state allowlist (`aria-pressed`/`-expanded`/
  `-selected`/`-checked`/…, `disabled`, `checked`, `open`, `readonly`, `hidden`, `class`), sorted.
  An action that starts toggling a **different** state attribute (`class` → `aria-pressed`) with an
  otherwise-unchanged tree + verdict now **mismatches** instead of passing silently (a named blind
  spot, now closed). Only attribute names are captured (not values), so it catches _which_ state
  attribute changed, not its old→new value; volatile attrs (`style`, generated tokens) are dropped
  so they cannot jitter the hash. **This changes the canonical form** — existing committed
  `__dw_checksums__/*.json` baselines and any pinned fingerprints must be regenerated
  (`deltawright checksum --update -- <test cmd>`, or Playwright's `--update-snapshots`). ADR
  2026-07-11.

## [0.7.1] - 2026-07-11

First release of the v0.7.x "Trust & Adoption hardening" wave: a view-only flake dashboard, plus the
CI accuracy gate and tag-triggered OIDC release automation. The diagnosis engine is unchanged.

### Added

- **`deltawright aggregate --html`** (Wave-1): a self-contained, theme-aware static HTML dashboard
  over the existing `FlakeReport` — most-flaky-first table, dominant-category chips, a proportional
  category bar, settle-cap / disagreement rates, and the `unsure` bucket in its **own** panel (never
  folded into a category). New pure export `renderHtml(report)` from `deltawright/aggregate`; the CLI
  prints the document to stdout (`--html` wins over `--report`; redirect it, e.g. `> flakes.html`).
  View-only: no engine change, and the module writes nothing. Test IDs are HTML-escaped (a malicious
  test name cannot inject markup). Inline CSS + a tiny theme toggle, no external assets — opens
  offline anywhere.

### Changed (infrastructure — not shipped in the npm package)

- **CI now runs the accuracy floors on every PR** (Wave-1): an `accuracy` job runs
  `npm run bench:accuracy`, surfacing any regression in DW-02 (live verdict), confirmed-precision
  (≥ 95%), or silent-miss (≤ 5%) as a red check — previously the floors ran only in a local smoke
  test. To make such a regression **un-mergeable**, the check must be added to the `main` branch
  ruleset's required status checks (a one-time owner step, documented in
  [docs/RELEASING.md](docs/RELEASING.md)).
- **Tag-triggered release automation** (Wave-1): pushing a `vX.Y.Z` tag runs
  [`release.yml`](.github/workflows/release.yml), which builds, runs the full suite **and the
  accuracy gate**, publishes to npm via **OIDC trusted publishing** (no token/OTP, automatic
  provenance), and cuts the matching GitHub release. Both steps are idempotent. Retires the manual
  2FA/OTP publish path. See [docs/RELEASING.md](docs/RELEASING.md) (owner one-time setup required).

## [0.7.0] - 2026-07-11

Wave-2 of the v0.6 "root-cause explainer" milestone — the agent/author-facing capabilities on the
now-gated diagnosis engine. Everything is opt-in; the default `actAndObserve` path is byte-unchanged.

### Added

- **Agent-assist MCP debug tools** (#60, additive on the `deltawright/mcp` server): four **live-reproduce**
  tools — `preflight`, `observe_settle`, `explain_delta`, and `diagnose` — that drive the MCP session's
  **own** browser and diagnose what happens there. `diagnose` returns the gated taxonomy read
  `{ category, confidence, unsure, geomDisagreement }` grounded in Playwright's **authoritative**
  verdict (below the confidence gate, and for the `unknown` bucket, it stays **`unsure`** — never a
  fabricated cause). It consumes a new **shared reducer** (`summarizeDiagnoses`) that the #55 reporter
  now uses too, so the MCP and the side-car can't drift on which cause crossed the gate. Every tool
  (description **and** result) carries a **live-reproduce disclaimer**: these do **NOT** read your live
  Playwright test run (the session has no handle on it — a real past-run/trace reader is **cut** this
  cycle), and **none mutates a test or fixes a flake**. The existing `navigate` / `act_and_observe` /
  `snapshot` tools are unchanged (default path byte-identical). Final gated Wave-2 capability. ADR
  2026-07-10.
- **Flake-priority aggregator** (#59, `deltawright/aggregate` + a `deltawright aggregate` bin): a
  **read-only** pass over the #55 reporter's `*.deltawright-sidecar.json` artifacts across runs → a
  **JSONL** stream (`{ testId, runId, code, confidence, category, hitMaxWait, disagreement, … }`) and a
  ranked summary — which tests fail most, under which **dominant taxonomy category**, at what
  settle-cap / geometry-disagreement rate (both derived from the side-car's own diagnoses). `unsure`
  and any untaxonomized code are **bucketed separately** and never inflate a real category; missing /
  foreign / unparseable side-cars are skipped, never guessed. It **writes nothing** (`deltawright
  aggregate [--report] <dir…>`, one run = one dir). The rendered HTML dashboard is deliberately
  **cut** this cycle — this is the cheap, engine-independent stub. Third gated Wave-2 capability.
  Pure core, unit-tested. ADR 2026-07-10.
- **`observeConsequences(page, action)` settle-as-a-wait** (#58, `deltawright/wait`): a **locator-free**
  observe/explain completion **signal** → `{ settleMs, hitMaxWait, suspectedEarly, observed }`. It arms
  the observer, performs the action, waits for **structural quiescence**, and reports the gap-E
  late-wave heuristic (`suspectedEarly`) — and it **skips the O(nodes) reconcile** (no per-node
  Playwright probes / geometry), its cost win vs `actAndObserve` (though the default late-watch window
  means it is not unconditionally faster wall-clock; set `lateWatchMs: 0` to skip it). It is explicitly **NOT** a completion
  guarantee, a retry, or a flake suppressant (a named non-goal): the result type exposes only settle
  signals (no `ready`/`safe`/`settled` boolean, no retry knob) and `hitMaxWait` / `suspectedEarly` flag
  an inconclusive or possibly-early settle. Degrades with a reason under a strict CSP / non-Chromium.
  Second gated Wave-2 capability. ADR 2026-07-10.
- **`suggest(delta)` new-test authoring aid** (#57): a **pure** function → `{ assertions, selectors,
  warnings }` that proposes candidate Playwright locators for a delta's changed nodes, ranked
  **getByRole > getByText > testid > css**, and a `toBeActionable()` assertion **only** for nodes
  Playwright confirmed ACTIONABLE. It reuses the delta's existing verdict (no second role/name
  mapping), never writes or modifies a test file, and is honest by construction: it **never fabricates
  a `getByTestId`** (a test-id attribute isn't captured), **never offers the ephemeral `data-dw-ref`**
  as a selector, and warns that every suggestion is a candidate to verify — role/name are heuristic
  reads (not Playwright's a11y algorithm), a `name` may be an aria-label, and uniqueness/durability
  are not checked (the durable-selector problem is a separate investigation). Exported from the main
  entry; browser-free, unit-tested. First of the gated Wave-2 capabilities. ADR 2026-07-10.

## [0.6.0] - 2026-07-10

The **root-cause explainer** milestone — a single consolidated release of everything since 0.1.0:
the v0.5 core hardening (robust settle, causal attribution, role-aware verdicts, shadow DOM,
same-origin iframes, MCP server, screenshot fallback, packaged `dist/`), and the full v0.6 accuracy
spine (closed 18-code taxonomy, first-class `unsure` confidence, the pure `diagnose()` engine, the
labeled flake corpus, and the accuracy harness with **three gated floors** — DW-02 verdict-vs-reality,
confirmed-precision ≥95%, silent-miss ≤5% — all passing with `diagnose()` emitting all 18 codes at
100% recall / 0% silent-miss on the seed corpus), plus the Wave-1 wrappers (`toBeActionable()`
preflight matcher, delta checksum matcher, flake-triage reporter, and the integration cookbook).

### Added

- **v0.6 integration cookbook** (#56, `docs/cookbook.md`): a problem → capability → one-line-wiring
  table for every shipped surface (delta, diagnosis, the preflight + checksum matchers, the triage
  reporter, MCP, and the opt-in gap flags), plus a single **honest-limits matrix** — Chromium-only,
  strict-CSP skip-with-reason (`injection-blocked` / Playwright-only degrade), cross-boundary partial
  capture, ~150 ms + O(nodes) overhead, ephemeral `data-dw-ref`, and the **corpus-relative** accuracy
  + regression-only-checksum stamps in one place. Linked from the README.
- **Flake-triage side-car reporter** (#55, `deltawright/reporter`): a **zero-edit** Playwright Reporter —
  one line in `playwright.config.ts` (`reporter: [['deltawright/reporter']]`) writes a taxonomy-labeled
  triage side-car (`*.deltawright-sidecar.json` + `*.triage.txt`) for every **failed / timed-out** test,
  **never** on a passing test and **never** altering pass/fail. It consumes the **one** `diagnose()`
  engine (so it hard-gates on the #52 accuracy harness): the failing test's Playwright actionability
  error is turned into a synthetic delta and diagnosed (passive, zero-edit), or a `deltawright-delta`
  attachment left by `attachDelta(testInfo, delta)` is diagnosed richly (carrying the late-wave /
  stale-rect flags). A cause below the confidence threshold is reported as **`unsure`**, and a locator
  that never resolved degrades to **detached** — it never fabricates a cause. Pure, browser-free core
  (`triageFailure`) is unit-tested against all five criteria. ADR 2026-07-10.
- **Delta checksum regression matcher** (#54, `deltawright/matchers`): `expect(delta).toMatchDeltaChecksum(id)`
  + `expect(delta).toMatchDeltaSnapshot()` over the existing geometry/timing-tolerant `checksum` /
  `normalizeDelta` primitive. It **matches across pixel and timing jitter** (raw rects, computed
  styles, reason text, timing stats and record order are all normalized out) but **fails on a verdict
  or tree change**. Baselines live in `__dw_checksums__/` next to the spec, written on first run and
  refreshed with `DW_UPDATE_CHECKSUMS=1`, Playwright's `--update-snapshots`, or the new
  `deltawright checksum --update -- <cmd>` CLI; a mismatch renders a **structural** (not pixel) diff.
  Honesty is baked into every message: a green checksum is **regression-only** — it proves the
  normalized structure/semantics is unchanged, NOT that the delta is correct or models a real app
  faithfully. Pure, browser-free core (`matchDeltaChecksum`) is unit-tested. ADR 2026-07-10.
- **Preflight actionability matcher** (#53, `deltawright/matchers`): `expect(locator).toBeActionable()`
  + `preflight(locator) → { verdict, reason, geometryVerdict, agreed }` — a **ground-truth** wrapper
  on Playwright's own role-aware verdict, usable **standalone** (no prior `actAndObserve`). It reuses
  the exact same authoritative probe the delta uses (`click` trial for buttons/links, `fill`-editable
  for text inputs, `selectOption`-enabled for selects), so the boolean can never diverge between the
  two surfaces. Geometry is read best-effort via an additive injected `probeGeometry` entry purely for
  the `[geom:]` disagreement hint and **never flips the verdict** (DW-02); under a strict CSP /
  non-Chromium page (where the observer can't be injected) it degrades to a Playwright-only verdict
  (`geometryVerdict: 'n/a'`). Register with `expect.extend(dwMatchers)`. ADR 2026-07-10.

- **Capture-integrity diagnoses** (#71 fix #4): the last two `diagnose()` silent misses close.
  **`injection-blocked`** (confirmed) — when a strict CSP (`script-src 'none'`) blocks
  `addScriptTag`, `actAndObserve` no longer throws; it DEGRADES (still performs the action) and
  returns an empty delta carrying `stats.injectionBlocked`, so the caller gets a nameable failure
  instead of an exception or a silent no-op. Verified live against a `<meta CSP>` fixture.
  **`cross-boundary-partial`** (suspected) — `armChildFrames` now counts cross-origin/uninjectable
  child frames it skipped during `frames:true` traversal into `stats.crossBoundarySkipped`, so a
  partial capture is surfaced rather than passed off as complete (closed shadow roots are
  structurally uncountable, so skipped frames are the honest signal). Both fields are default-absent
  → the default path is byte-unchanged. **Harness: recall 88.9% → 100% (18/18), silent-miss
  11.1% → 0% (0/18)** — every taxonomy code now emits. ADR 2026-07-10.
- **`detached-re-render` diagnosis** (#71 fix #3): `diagnose()` now emits `detached-re-render`
  (suspected) when a freshly-added subtree was inserted and then DETACHED again within the settle
  window — a React re-render / list-virtualization swap. Such a node nets OUT of the reported delta
  (added-then-removed → neither net-added nor net-removed), so the delta shows only the replacement
  and the transience was previously a silent miss; a handle to the original would be stale.
  `coalesce` counts the in-window detaches (zero added latency — it already walks the added set) into
  a **default-absent** `stats.detachedReRender`, so a delta with no detach keeps a byte-unchanged
  stats object. Suspected, not confirmed: an add-then-detach can also be a benign transient (a
  spinner). ADR 2026-07-10. Harness: recall **83.3% → 88.9%** (16/18), silent-miss **16.7% → 11.1%**
  (2/18); the two remaining misses are the #71 capture-integrity codes (injection-blocked,
  cross-boundary-partial).
- **Accuracy harness** (#52, `npm run bench:accuracy`): scores the pure `diagnose()` engine against
  the #51 corpus and reports headline metrics — verdict-vs-reality (DW-02), confirmed-band
  precision, recall, silent-miss rate — all **corpus-relative** (NOT real-production precision;
  blocked on #25/#41). **Gating at introduction was reporting-first** (ADR 2026-07-10) — only a real
  DW-02 regression failed the run — with precision (target ≥95%) and silent-miss (target ≤5%)
  reported while #71's signals landed; both floors were **later ratcheted to hard gates** once #71
  closed (see _Changed_ above).
  Verdict-vs-reality is **split by case kind** — only live cases exercise Playwright's real verdict
  (the gate); delta verdicts are authored self-consistency, reported not gated. Confirmed-precision
  is scored **per-emitted-confirmed-diagnosis** (a confident non-label code counts wrong and is
  surfaced, never hidden by per-case scoring). Run at introduction: **live-verdict 100% (16/16),
  confirmed precision 100% (7/0), recall 83.3% (15/18), silent-miss 16.7% (3/18)** — the three silent
  misses were the open #71 gaps (detached-re-render / injection-blocked / cross-boundary-partial),
  surfaced as `✗ SILENT`; all three have since closed (recall 100%, see _Changed_). Pure scorer in `bench/flake-corpus/score.ts` (browser-free, unit-tested);
  `test/accuracy.spec.ts` guards the scorer contract, the split verdict oracle, and the gate.
- **Labeled flake corpus** (#51): `bench/flake-corpus/` — the non-circular ground truth for the
  accuracy harness (#52). 36 cases (22 live real-DOM + 14 hand-built delta) covering **all 18**
  taxonomy codes, each with a **positive AND a mandatory near-miss confuser** (a superficially-
  similar DOM whose correct label differs), so precision can't be inflated by an author who picked
  both the DOM and the label. Ground truth from **three independent oracles** — the real Playwright
  verdict, a construction manifest (`code` + `confidence`), and `window.__truth` — and **never** a
  stored Deltawright output (`load.ts` enforces it). `test/corpus.spec.ts` pins per-code coverage,
  the confuser requirement, and the independent-oracle rule. A live probe recorded the engine's
  **current behavior per code** in `CORPUS.md`, honestly surfacing that `diagnose()` emits ~9 of 18
  codes well today and documenting the rest as gaps (e.g. `pointer-events-none` mislabeled
  `covered-by-overlay`; `disabled`/`read-only` surface as `geom-disagreement`) — the corpus exists
  to make those measurable. All numbers are **corpus-relative**; real-production precision stays
  blocked on #25/#41. Scoring is #52.
- **Gap-F stale-rect flag** (#50, opt-in `rectRecheckMs`): closes the second silent gap — a
  JS-timer reposition AFTER settle leaves a STALE annotated rect (`getAnimations()` is empty for
  a plain style write, so `settleAnimations` never waits it out). With `rectRecheckMs > 0`, AFTER
  Playwright's authoritative probe the host calls `recheckRects()` — which re-reads each stamped
  node's geometry — and on a >2px move **adopts the later rect**, sets `geometry.stable=false`
  (surfaced by `diagnose` as `stale-rect-suspected`, suspected), and re-derives the geometry
  annotation. Running AFTER the probe means the **verdict is decided at the settle point and the
  re-check delay cannot change it** (a strengthened off-screen-move test proves the verdict stays
  `ACTIONABLE` while the geometry annotation flips). Default `rectRecheckMs=0` → the annotated
  rect, `stable` (absent), the annotation, and stats are **byte-unchanged**. `GeometryRead` gains
  optional `stable`.
- **Gap-E late-wave flag** (#49, opt-in `lateWatchMs`): closes a silent gap — a two-wave
  render whose second wave lands after settle was under-reported as a no-op with
  `hitMaxWait=false`. With `lateWatchMs > 0`, `waitForSettle` still resolves at the settle point
  (so the delta is **collected and frozen there, exactly as the default path**), and a
  **separate** short-lived observer watches the window for a late structural wave; the host
  reads it post-collect via `lateResult()`, setting `stats.lateStructural`, which `diagnose`
  surfaces as `late-wave-suspected` (suspected). **Flag-not-fix**: the late wave is detected,
  never merged into the delta — a *replacing* wave 2 (one that removes wave 1) cannot erase or
  alter the frozen delta (capturing wave 2 was declined-as-unsafe in #30). Default
  `lateWatchMs=0` → the settle path, the delta, and the stats object are **byte-unchanged** (the
  field is absent, not false). `SettleOptions` gains `lateWatchMs`; `DeltaStats` gains optional
  `lateStructural`.
- **Pure `diagnose(delta)` root-cause engine** (#48): `src/host/diagnose.ts` turns a `Delta`
  into a `DiagnosedDelta` (the delta plus `Diagnosis[]`), reading ONLY the existing
  delta/stats/actionability — no new capture, no membership filter, geometry never filters.
  The rule is **agree-or-flag** (DW-02/DW-03): a NOT-actionable node earns a specific cause
  code ONLY from the branch where both engines agree it is blocked (`agreed===true`); when
  they disagree (`agreed===false`, e.g. a disabled control or a fillable covered input) it is
  reported as `geom-disagreement` **with direction**, never a code that contradicts
  Playwright's verdict. Within the agreed branch **Playwright's named cause wins** over
  geometry's (verdict-agreement ≠ cause-agreement — a disabled+covered button is `disabled`,
  not `covered`); a geometry-only pick Playwright didn't corroborate is `suspected`, not
  `confirmed`. Delta-level flags: `settle-timeout`, `background-churn`, and
  `suspected-miss-empty` (empty + cap → `unknown`, the honest unsure). Serializer gains an
  **opt-in** `{ diagnostics: true }` flag on `serialize`/`render` that appends a diagnostics
  section; **default output is byte-identical** (proven by a test). Exported: `diagnose`,
  `DiagnosedDelta`, `Diagnosis`, `SerializeOptions`. No accuracy claim yet — the corpus (#51)
  and harness (#52) measure it next.
- **Shared Confidence primitive** (#47): `src/host/confidence.ts` gives every v0.6 diagnosis
  ONE confidence type — `confirmed | suspected | unknown` — with `unknown`/unsure as a
  first-class outcome ("unsure beats confidently wrong", DW-03). `assessConfidence(evidence)`
  encodes the rules: `confirmed` only when an authoritative engine named the cause (a
  Playwright error/verdict, or a geometry+Playwright agreement); a geometry-only or
  timing-only read is at most `suspected`; no grounding signal is `unknown`; and conflicting
  signals downgrade one notch (never upgrade). Exported (`assessConfidence`,
  `atLeastAsConfident`, `CONFIDENCE_ORDER`, `Confidence`). Registers **DW-03** (a diagnosis
  is a hypothesis and never contradicts Playwright's verdict). The engine (#48) consumes it;
  the suspected band gets its own measured precision floor from the harness (#52).
- **Canonical closed root-cause taxonomy** (#46): `src/host/taxonomy.ts` defines the ONE
  vocabulary every v0.6 diagnosis surface must speak — 18 codes across six categories
  (actionability-blocking, verdict-disagreement, membership-attribution, capture-integrity,
  fallback, and `unknown` as the first-class "unsure"), each grounded in ≥1 real
  `PrimitiveSignal` (hitSelf/coveredBy, offscreen, Playwright verdict/error, hitMaxWait,
  droppedBackground, getAnimations, screenshot-fallback, …). Exported from the package
  (`ROOT_CAUSE_TAXONOMY`, `ROOT_CAUSE_CODES`, `PRIMITIVE_SIGNALS`, `RootCauseCode`); the
  `satisfies` table is exhaustive at compile time. Governed by **DW-04**: adding/renaming a
  code requires an ADR + a corpus relabel + an accuracy-harness re-run, mechanically gated
  by a frozen SHA lock and a doc↔code sync check in `test/taxonomy.spec.ts`. Spec:
  `docs/specs/v0.6-root-cause-taxonomy.md`. This is the contract the diagnosis engine (#48)
  will fulfil; no diagnosis is emitted yet.
- **Distributable build** (#45): `npm run build` now emits a real `dist/` — ESM +
  bundled `.d.ts` for the public entry points (via tsup), a pre-bundled injected-observer
  IIFE so the installed package is self-contained (no build step at runtime), and two
  executable bins (`deltawright`, `deltawright-mcp`) built from JS. `package.json` gains a
  proper `exports`/`main`/`types` map (`.` and `./mcp`), `files: [dist]`, and `prepack`
  so `npm publish` always ships a fresh build. `deltawright/mcp` is a real importable
  module (`startServer`, `DeltawrightSession`) that self-runs only as the bin, so
  embedders can drive a session without spawning a server on import. **The package is now actually installable:**
  `import { actAndObserve } from 'deltawright'` resolves compiled JS + types, not raw
  TypeScript. Packaging correctness is locked by `test/packaging.spec.ts` (import from the
  built package under plain node, run the MCP bin from `dist/`, typecheck a by-name
  consumer against the published types under nodenext, and a byte-for-byte default
  serializer check across source vs. build). The dev/test path still runs TypeScript
  directly via tsx — unchanged.
- **Legacy-GWT actionability investigation + faithful fixture** (#41): a GWT-faithful
  synthetic fixture (`test/fixtures/gwt.html`) reproducing GWT's deferred-command cascade,
  `gwt-PopupPanelGlass` overlay, self-repositioning dialog, and delegated role-less DOM;
  a demo (`npm run demo:gwt`) and regression suite (`test/gwt.spec.ts`) that state
  Deltawright's honest, scoped value: a **locator-free settle** that catches a deferred
  render when observing consequences (a genuine win); a compact **coverage** and
  **disagreement** second-opinion (diagnostic — Playwright is already correct); and its
  own **silent gaps** (a two-wave under-report, a JS-recenter stale rect) asserted, not
  buried. Every naive baseline is paired with the idiomatic web-first steel-man — the
  finding is **GO** as "a better moment + stable handle + second-opinion", **NO-GO** as
  "Deltawright fixes Playwright's GWT actionability" (idiomatic Playwright already handles
  most of it). New `checksum`/`normalizeDelta` (`src/host/checksum.ts`) — a
  geometry-tolerant delta fingerprint, framed strictly as a regression guard, not proof of
  framework correctness. Findings: `docs/summaries/v0.5-gwt-legacy-findings.md`. The
  fixture is synthetic (not compiled GWT); calibration to a real portal trace is the
  follow-up, pairing with #25.
- **Anchor-aware background rescue** (#30, opt-in `inWindowRecurrence: true`): a
  trusted-event *anchor* captures the action's origin (target element + click point,
  latched from the first `isTrusted` event) so the pre-arm baseline's background-insert
  drop becomes **per-root** instead of all-or-nothing. When an app reuses a background
  signature (e.g. a toast class) for the action's OWN confirmation rendered at the click,
  that instance is now **KEPT** while the far background instances of the same signature
  are still dropped. It is **KEEP-ONLY** at the added-root level — the anchor can only
  rescue a root, never cause a drop and never promote a signature to background — so
  enabling it *strictly reduces* false-drops and even fixes a latent false-drop in the
  shipped slice (a rescued root also correctly re-scopes its descendants' attr/text into
  the added subtree instead of orphaning them under a dropped parent). Default off and
  byte-identical when off or when no trusted event fires (degrades to the shipped path).
  Regression suite `test/rescue.spec.ts` (rescue, additivity, untrusted-parity, and a
  streamed-payload no-drop case). This is the safe, adversarially-verified slice of the
  #30 advanced-attribution work; a design panel proved that *independent* in-window
  dropping (without pre-arm baseline corroboration) cannot be done without false-dropping
  a real streamed/staggered payload, so it is deliberately **not** shipped (see the #30
  decision memo in `docs/`).
- **Same-origin iframe traversal** (#34, opt-in `frames: true`): also injects/arms/collects
  child frames and merges their changes into the delta, with geometry offset to page-global
  coordinates and refs namespaced (`f1e2`); reconciliation uses the frame's own locator.
  Additive — the default (main-frame) path is byte-unchanged (all prior tests green).
  Cross-origin/uninjectable frames are skipped. Regression suite `test/iframe.spec.ts`.
- **Screenshot-diff fallback** for the DOM-less boundary (#20, opt-in
  `screenshotFallback: true`): when an action mutates no DOM but changes pixels (a
  `<canvas>`/WebGL draw, cross-origin content), Deltawright diffs a before/after
  screenshot and reports the changed region as a synthetic node (verdict `n/a` — no DOM
  element to probe). Exposed `diffChangedRegion`. Regression suite `test/canvas.spec.ts`.
- **Open shadow-DOM traversal** (#19): the observer now attaches into open shadow roots
  (recursively, incl. ones added mid-action), so changes inside web components appear in
  the delta; the geometry hit-test queries the element's own root (shadow
  `elementFromPoint` instead of the retargeted host). Playwright's CSS pierces open
  shadow DOM, so refs/actionability work across the boundary. Regression suite
  `test/shadow.spec.ts`. Same-origin iframe traversal → #34; closed shadow roots are
  inaccessible by design.
- **MCP server** (#22, `npm run mcp` / `deltawright-mcp` bin): a stdio Model Context
  Protocol server so agents (Claude Code, Cursor, …) consume deltas natively. Tools:
  `navigate(url)`, `act_and_observe({action, selector, value?})` — returns the compact
  delta (what changed + actionability, no re-snapshot) — and `snapshot()` fallback.
  Logic lives in a testable `DeltawrightSession`; validated end-to-end over the protocol
  in `test/mcp.spec.ts` (an MCP client spawns the server, lists tools, gets a delta).

- Real-app benchmark harness (`bench/`, `npm run bench`): compares the delta vs
  before+after+diff vs full re-snapshot on a real React SPA, with info-parity,
  noise-floor (null-action), settle, and timing metrics. First directional findings
  in `docs/summaries/v0.5-real-app-benchmark-findings.md` (issue #23): the token win
  holds (delta 0.01× a large re-snapshot; 0.15–0.87× the diff at info-parity), and
  noise/settle/time weaknesses are confirmed and quantified (feeding #13/#15/#18).
- Admissible benchmark (`npm run bench:admissible`, issue #25): runs on a **real,
  unmodified, third-party** app (TodoMVC React, pinned; `bench/corpus/CORPUS.md`) with
  pre-registered interactions incl. a navigation, a **structure-aware order-insensitive
  diff** (`bench/structural-diff.ts`, unit-tested), primary-change recall, and N=30 reps.
  Findings (`docs/summaries/v0.5-admissible-benchmark-findings.md`): the token win holds
  on code we didn't write (0.19–0.45× re-snapshot; 0.27–1.03× a structure-aware diff at
  info-parity), recall 30/30 and settle 0/30-capped on all interactions, and the O(nodes)
  actionability time cost is confirmed (hover-reveal controls pay the full trial timeout).

### Changed

- **Accuracy floors ratcheted from reported to gated** (#52/#71): now that `diagnose()` closed every
  #71 silent miss (recall 100% / silent-miss 0%), `npm run bench:accuracy` hard-fails on **three**
  floors, not just DW-02 — confirmed-band precision **≥95%** and silent-miss **≤5%** are now gates,
  alongside the DW-02 live verdict-vs-reality floor (checked first so a reality drift short-circuits).
  All three pass today with headroom (8/0 precision, 0/18 silent-miss). The floors are
  corpus-relative — they keep the engine in lockstep with the corpus, so a future code the engine
  can't yet diagnose fails CI rather than being silently reported. Supersedes the 2026-07-10
  reporting-first ADR.

- **Dependency classification for the distributable** (#45): `@playwright/test` is now a
  **peerDependency** (consumers bring their own Playwright — the core only uses type-only
  imports; the MCP server uses `chromium`), and `gpt-tokenizer` moved to a runtime
  **dependency** (the serializer imports it). `esbuild` stays a devDependency: the injected
  observer is pre-bundled at build time, and the dev-tree bundling fallback imports esbuild
  lazily, so the published package never pulls it in at runtime. The `DeltawrightApi`
  interchange type moved to `src/host/types.ts` and the host reads `window.__deltawright`
  through a local cast, so the shipped `.d.ts` no longer depends on the injected module and
  never augments a consumer's global `Window`.
- **Element-adding background-churn filter** (#30, extends #15): the pre-arm baseline now
  also learns recurring element-**insertion** signatures (`parent > tag . class`), so a
  background pattern that inserts elements every tick (toasts, live-feed rows, virtualized
  lists) is excluded from the delta too — while a one-off insert like a modal (a unique
  signature) is always kept. Additive to the baseline; `test/causal.spec.ts` proves a
  toast-churning page reports the modal alone (`droppedBackground > 0`). The larger
  advanced-attribution rewrite (in-window recurrence to drop the baseline latency, spatial
  cohort, locality keep-overrides) remains open in #30.
- **Role-aware actionability probes** (#17): the verdict now matches the action an agent
  would use on the node, not click-for-everything. Text inputs are probed with
  `isVisible + isEditable` (fill has no pointer hit-test), selects with
  `isVisible + isEnabled`, and buttons/links with the click trial. This fixes the cases
  a click-only probe got wrong: a **covered text input is ACTIONABLE** (fill works
  despite the cover), a **read-only input is NOT-actionable** (click-only wrongly said
  yes), and disabled inputs report `disabled`. Verified against real `fill`/`select` in
  `test/roles.spec.ts`. (DW-02 invariant strengthened, not retired.)
- **Causal attribution / mutation-noise filtering** (#15, §6.2 "where the value is
  earned"). Attribution moves from time-window-scoped to causal: a short pre-arm
  **baseline** (default 150 ms, early-exits on a quiet page) learns which
  `(element, channel)` pairs are already churning, and that background is excluded
  from the delta. Channel-granular, so an action that changes a churning node's
  *different* attribute is still kept; and it only excludes what churned *before* the
  action, so a "select-all"-style change is kept. On the live-SPA benchmark this
  collapses the noise: **noise_ratio 13.8/76.3 → 1.0**, **null-action false positives
  51/301 → 0**, **large-noisy delta 8958 → 99 tokens** — the delta on a 300-cell
  churning page is now identical to a quiet page (4 nodes), real change preserved
  (captured 3/3). New options `baseline`/`baselineMs`/`baselineEarlyExitMs`; new stat
  `droppedBackground`. Regression suite: `test/causal.spec.ts`. Residual (element-adding
  background churn: toasts/virtualized lists) documented in the observer.
- **Robust settle detection** (#13, retires DW-01): settle now resolves on **structural
  quiescence** — once an element add/remove is seen, it waits only for *structural* quiet,
  treating background ticker churn (attribute/text updates) as non-structural. So on a
  live-updating page it no longer waits out the full `maxWaitMs` cap, and still waits
  through a delayed insert (the insert is the structural signal). The old full-DOM
  quiescence remains as the quiet-page path. Regression suite: `test/settle.spec.ts` on a
  60 ms-ticker fixture. Residual (attribute/text-only effect on a live page) → #15.
- Actionability reconciliation is now **bounded-concurrent** instead of serial (#18):
  each changed node still receives its full authoritative Playwright trial (verdicts
  unchanged — the northstar cases and real-app recall 30/30 confirm), but probes run
  concurrently, so a many-node delta no longer pays `N × trialTimeoutMs`. Measured: the
  reconcile step ~8× faster on a 305-node delta (overall action 12.3 s → 3.4 s; the
  remainder is the settle cap, #13). New option: `reconcileConcurrency` (default 12).

### Fixed

- **Geometry-blind cause recall** (#71): `disabled` / `read-only` / `unstable-animating` are
  causes only Playwright can observe, so the node reads geometry-actionable (`agreed===false`) and
  used to collapse to `geom-disagreement` — a recall gap the corpus surfaced. `diagnose()` now
  RECOVERS the Playwright-named cause from the disagreed branch as `confirmed`: geometry's dissent
  on a cause it is structurally blind to is the absence of evidence, not counter-evidence, so it
  doesn't contradict the verdict — it *is* the verdict's reason. Strictly limited to the closed
  geometry-blind set; a dissent on a geometry-VISIBLE cause (covered / off-screen / …) stays
  `geom-disagreement` (the live corpus positive for it is now a covered-but-fillable input, the
  canonical genuine disagreement). Extends the #48 agree-or-flag rule (ADR 2026-07-10). The engine
  now emits ~14 of the 18 codes well; remaining gaps (detached/injection/cross-boundary signals)
  stay open in #71. `bench/flake-corpus/{cases.ts,CORPUS.md,fixtures/reveal.html}` updated.
- **Two corpus-surfaced diagnosis gaps** (#71, partial): (1) `pointer-events-none` was
  mislabeled `covered-by-overlay` — Playwright's error for a `pointer-events:none` target is a
  generic "intercept" and `elementFromPoint` returns the element behind, so the engine now
  recognises the target's own computed `pointer-events:none` as the true self-cause (suspected)
  instead of a wrong `confirmed` cover; (2) `diagnose()` now maps the screenshot-diff
  pixel-region node to `pixel-region-fallback`. The engine now emits ~11 of the 18 codes well;
  remaining gaps (disabled/read-only recall, detached/injection/cross-boundary signals) stay
  open in #71. `bench/flake-corpus/CORPUS.md` updated.
- Pin the token encoding to `cl100k_base`: the `gpt-tokenizer` 3.x bump had silently
  switched the default `encode` to o200k, invalidating every "cl100k" label. Counts
  are an OpenAI proxy; ratios are the tokenizer-robust signal.

## [0.1.0] - 2026-07-07

### Added

- Core primitive `actAndObserve(page, action)`: arms a MutationObserver, runs the
  action through Playwright, waits for settle, coalesces a net delta of changed
  nodes, reads geometry + `elementFromPoint`, and reconciles each node's
  actionability against Playwright's authoritative `click({ trial: true })` —
  Playwright wins disagreements, which are surfaced as `[geom:…]`.
- Compact text serializer for the delta format, with a cl100k token count.
- Controlled north-star fixture (popup / covered / off-screen / disabled) and a
  12-test suite including verdict-matches-reality checks.
- Developer tooling (ESLint, Prettier, EditorConfig, `.nvmrc`), version-controlled
  git hooks, and CI across Node 20/22.
- OSS + SDLC docs: plan, spec, context, decisions + design-watches, verification
  review, and the go/no-go summary.

### Known limitations

See `docs/summaries/v0.1-milestone.md`. In short: the verdict is
pointer/click-actionability (role-aware probes are v0.5); settle is a simple labeled
heuristic; mutation-noise filtering is untested; and the token win is unproven on the
tiny controlled fixture.

[Unreleased]: https://github.com/mstomar698/deltawright/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mstomar698/deltawright/compare/v0.1.0...v0.6.0
[0.1.0]: https://github.com/mstomar698/deltawright/releases/tag/v0.1.0
