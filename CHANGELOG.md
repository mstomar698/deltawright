# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Actionability priority queue (`prioritize` in `deltawright/aggregate`; `deltawright aggregate --priority`,
  and it now leads the `--html` dashboard)** — turns the report from "here is all the data" into "fix THIS
  cluster first, and here is why". Ranks the cause clusters by shared-cause **blast radius × confidence** —
  a decomposed, auditable order (every row shows its blast radius, confidence band, and failure count),
  never one opaque score. Where incumbents sort by raw frequency / CI-time, DW ranks by *shared root-cause
  blast radius* (fix-once-fix-many candidate), which is only possible because DW owns the per-action
  taxonomy. The confidence axis is the cluster's *highest* band (the cause was confirmed on at least one
  member). Honest: `unsure` is **never scored low or folded** — it goes to its own "route to a human" lane
  on par with the top; a high rank is a fix-first *hypothesis*, never a confirmed bug or a guarantee one fix
  clears the cluster; priority annotates, never overrides Playwright. Reporting A from the SDLC research
  (`docs/research/sdlc-reporting.md`).
- **Cross-test cause-clustering (`clusterByCause` in `deltawright/aggregate`; `deltawright aggregate --clusters`)** —
  suite-scale triage that collapses a corpus of failures into root-cause clusters on a key no incumbent has:
  the closed taxonomy **code** (Level 1 — two different codes never merge, the anti-over-group firewall) ×
  the geometry/timing/message-tolerant delta **fingerprint** (Level 2 — "same cause" collapses even when the
  error text jitters, the anti-under-group key). Each cluster reports its **blast radius** (distinct tests
  sharing the cause — a fix-once-fix-many *candidate*: one fix may clear them all, not a guarantee),
  failures, runs, and highest confidence; clusters rank by blast radius. The side-car now persists a `fingerprint` + `fingerprintSource` (`delta` = structural checksum in
  rich mode, `coarse` = error-shape signature in passive mode — resolution surfaced, not hidden); old
  side-cars still cluster via a recomputed coarse key. Honest: a cluster is a *hypothesis* of a shared cause
  (never "the same bug"), and `unsure` is **never** clustered — each stays a singleton routed to a human.
  Triage T1 from the SDLC research (`docs/research/sdlc-triage.md`).
- **`suggestAssertions(root, delta)` (in `deltawright/matchers`)** — turns a delta's observed state/presence
  transition into **candidate, live-verified** Playwright assertions bound to a durable selector, filling
  the oracle gap codegen leaves (it records actions but not assertions, and Playwright has no feature that
  maps an observed aria/state transition to the right assertion method). Maps `aria-expanded`→`toBeExpanded`,
  `aria-checked` on checkbox/radio→`toBeChecked` (else `toHaveAttribute`, dodging the `switch`-role trap),
  `disabled`→`toBeEnabled`/`toBeDisabled`, a `role=dialog` appearing→`toBeVisible`, a removal→`toHaveCount(0)`,
  an `aria-live` announcement→`toContainText`. `state`/`presence` assertions are independently re-read on the
  live page (`holds`): one that no longer holds is flagged `transient` (surfaced, not dropped); `text` (read
  from the region) and `actionability` (the delta's verdict) report `holds: null`; one with no verified
  durable selector is dropped; results rank holding-first. Honest by construction: DW *grounds* the author — every assertion is a labeled
  candidate from one observed transition, never authored/owned/run by DW, never a claim the behavior is
  correct/intended; Playwright's `expect` stays authoritative. Testgen A from the SDLC research
  (`docs/research/sdlc-testgen.md`).
- **`toHaveCommittedValue(intended)` (in `deltawright/matchers`)** — an input-commit integrity matcher for
  a case Playwright has no primitive for: telling a real value loss from an *intended* reformat mask, and
  catching an async debounce / autocomplete / input-mask that silently clears, truncates, or drops a typed
  value *after* `fill()`/`type()` returned success (a later submit intermittently fails while the fill site
  looks green). It waits for the field's value to stop changing (catching the debounce-then-clear *window*
  a synchronous `toHaveValue` poll can false-pass), then classifies it with the same `classifyInput` the
  live/offline arms use: a benign reformat mask (`4111 1111`→`41111111`, trim, reorder) is `transformed`
  and passes — where `toHaveValue` false-fails — while real character loss
  (`never-committed`/`truncated`/`dropped`) fails loud with the named shape. Honest by construction: a
  separate assertion that never overrides `fill()`, never repairs the value, never claims *why* the widget
  dropped it; PII-safe (shape + lengths only, never the raw value); `settled` flags a value still changing
  at the cap; a loss combined with a case/reorder transform is deliberately `transformed` (biased against
  false-failing a legit mask). `checkCommittedValue(locator, intended)` exposes the structured result.
  Hardening H1 from the SDLC research (`docs/research/sdlc-hardening.md`).

### Fixed

- **`observeEffectSettled` — a top-level removal no longer over-waits to the cap.** Closing a modal
  appended straight to `<body>` made the effect target `<body>` itself, whose rect is the whole page —
  so the region inflated to the full viewport and every later mutation reset the quiet timer, degrading
  the region-scoped settle back into global quiescence (`hitMaxWait` on any live page with unrelated
  churn). Top-level targets (`<body>` / `<html>`) are now treated as **unlocalizable**: they latch "an
  effect appeared" (never a fake no-effect) but do not seed the region or reset the timer, so the settle
  reports `region: null` and lands cleanly. A localizable follow-on effect still scopes the region
  normally. (Bug-hunt backlog, `docs/BUG-HUNT-2026-07-20.md` §C.)

### Added

- **`measureRetention` (in `deltawright/matchers`)** — the two-snapshot MEASURED cross-render signal that
  upgrades `scoreSelectors`' single-page durability *estimate*. Pass the `delta` + `scoreSelectors` result
  (snapshot A) and a `reRender`; it re-resolves each verified selector on the resulting DOM (snapshot B)
  and reports `retained` / `moved` / `ambiguous` / `lost` per selector, a `retentionRate`, and a
  `bestRetained`. Honest by construction: it measures the ONE observed re-render (never a cross-release
  guarantee), and since the `data-dw-ref` marker does not survive a re-render, identity is inferred from a
  unique semantic/layout match + geometry proximity — a jump past `positionTolerance` (default 250px) is
  surfaced as `moved` for review, never silently counted as retained. Completes R3 step 4 of the
  authoring-enhancer plan.

## [1.0.0] - 2026-07-20

**The authoring-enhancer release.** Deltawright grows from a diagnosis/triage layer into a categorical
Playwright **authoring enhancer** — a structured, deterministic model of *what changed because of the
action you just took*: where it is, whether you can act on it, and when it's ready — aimed at legacy /
poor-a11y / heavy-RPC apps where the accessibility tree degrades and `networkidle` never fires. Three
new primitives (`pageMap`, `observeEffectSettled`, `scoreSelectors`) ship as one family, plus a dual
ESM+CJS package and a four-agent bug-hunt hardening pass. Every change was two-lens reviewed
(correctness + honesty/anti-reskin) and honesty-gated.

### Changed

- **Dual ESM + CJS package (adoption fix, #B4/#C).** The library entries (`deltawright`, `deltawright/
  matchers`, `deltawright/reporter`, `deltawright/wait`, `deltawright/aggregate`) now ship BOTH an ESM
  build (`.js`) and a CJS build (`.cjs`) with per-condition `types`, so `require('deltawright')` works
  from a CommonJS Playwright config — no more `ERR_PACKAGE_PATH_NOT_EXPORTED` / dynamic-import shim. The
  CJS bundles polyfill `import.meta.url` (used to locate the pre-bundled injected observer). `deltawright/
  mcp` stays ESM-only (it uses top-level await and is the `deltawright-mcp` bin — embedders `await
  import()` it); the `deltawright` / `deltawright-mcp` bins stay native ESM. A packaging test exercises
  `require()` of every dual subpath end-to-end (incl. resolving the observer from CJS).

### Fixed

- **Repo hardening from a four-agent bug-hunt** (`docs/BUG-HUNT-2026-07-20.md`). (1) **Flaky
  timing-assertion family** — five load-sensitive `settleMs < BUSY_MS-30` assertions
  (`framework-quiescence`/`quiescence`/`wait` specs) widened to a 600ms busy window so the default
  settle clears with margin under CI load. (2) **`live-routing` client-abort exclusion** narrowed from
  `/ERR_ABORTED|aborted/i` to `/\bERR_ABORTED\b/i` — a genuine `net::ERR_CONNECTION_ABORTED` (connection
  dropped by the server) is a real backend fault and is now KEPT/routed, not silently dropped.
  (3) **`observeEffectSettled` baseline-footprint leak** — `waitForEffectSettle` now consumes the
  pre-arm footprint (symmetric with `collect`), so a later `{baseline:false}` call is not measured
  against stale background. (4) **Child-frame late-watch leak** — `actAndObserve({frames,lateWatchMs})`
  no longer starts an un-torn-down `MutationObserver` per child frame. (5) **`pageMap` reconcile**
  skips the Playwright trial for off-screen nodes (a trial auto-scrolls them in, fabricating a
  disagreement + polluting the captured scroll). (6) **MCP `serverInfo.version`** now reads the real
  package version instead of a hardcoded `0.1.0`. (7) **`release.yml`** gained a `concurrency:` group
  to prevent a duplicate-publish race. Regression tests added for (2), (3), (5).
- **CI hygiene + a trace-report edge:** added a `concurrency:` group to `ci.yml` (a rapid re-push
  cancels the stale in-flight run instead of piling up); `read-trace`'s `capText` now caps by code
  point so a cut never lands mid-surrogate and leaves a lone `�`.
- **More bug-hunt backlog resolved** (`docs/BUG-HUNT-2026-07-20.md`): (a) a **synchronous XHR** no
  longer leaks the in-flight quiescence counter — the decrement listener is attached BEFORE `send()`
  (a sync XHR's `loadend` fires during `send()`), with a `catch` undoing the increment on a sync throw;
  (b) `settleAnimations` no longer waits on **infinite-iteration or paused** animations (a spinner's
  `.finished` never resolves — it used to pin the settle to the full `animMaxMs`); (c) `pageMap` no
  longer reports a **sticky/fixed page header** (full-width, short, edge-anchored chrome) as a false
  overlay layer, and no longer **misattributes** one overlay's name to nodes in another (multiple
  overlays → the layer label is left unset rather than wrong); (d) `observeEffectSettled`'s effect
  **region is clamped to the viewport** (a top-level modal-close seeded the region from `<body>`);
  (e) `awaitQuiescence` is now honored **inside child frames** (`frames:true`); (f) `harnessBucket`'s
  5xx label requires a **status context** so an incidental latency number (`404 (took 503 ms)`) isn't
  mislabeled `5xx`; (g) doc precision for `appearedMs` (stamped at drain time) and the screenshot-diff
  region's device-pixel space on HiDPI. Regression tests added for (a), (c), (f).

### Added

- **`scoreSelectors(root, delta, opts?)` — durable-selector scoring** (`deltawright/matchers`). Phase 3
  (the byproduct) of the authoring-enhancer chapter. Layers a **durability ESTIMATE** (0–100) + grade
  (`durable`/`usable`/`brittle`/`broken`) + brittleness flags over `verifySuggestions`: tier base
  weights + the verify-status multiplier + generated-id / text-volatility detectors (Robula+ blacklist /
  Similo two-tier weighting, applied to the accessible NAME) + a heuristic-role discount + geometry /
  actionability context flags (`unstable-id`, `text-volatile`, `ambiguous`, `heuristic-role-unverified`,
  `tag-only`, `occluded`, `offscreen`, `not-actionable`). When nothing semantic verifies for a node it
  synthesizes a **delta-anchored geometry-relative fallback** — `<tag>:near(:text("<nearest verified
  anchor>"))` via Playwright's layout engine — re-verified through the same path and graded as the
  last-resort handle it is. `bestDurable` is the top verified, non-brittle candidate, or `null` (with a
  warning) rather than a brittle hand-off; assertions are re-pointed onto it. HONESTY (DW-03):
  `durability` is a SINGLE-PAGE ESTIMATE (a brittleness proxy), NEVER a claim of stability across
  releases/re-renders (the sound cross-render signal — a two-snapshot re-check — is a deliberate
  follow-up, not fabricated); Playwright's uniqueness/identity verdict stays authoritative. Additive:
  `suggest`/`verifySuggestions` are unchanged.

- **`observeEffectSettled(page, action, opts?)` — the R1 capability: region-scoped, assertion-free,
  causal effect-settle** (`deltawright/wait`). Phase 2 of the authoring-enhancer chapter. Answers "has
  *this action's* effect landed and gone still" WITHOUT a static sleep and WITHOUT global `networkidle`,
  including the case both miss: a client-side re-render with zero network. A new stateless
  `waitForEffectSettle()` mode on the injected observer waits for the FIRST non-background mutation (the
  first-effect "appeared" edge — nothing named in advance; co-occurrence with the action, not proven
  causation), seeds a REGION from that effect, then waits until
  the region goes still — only non-background mutations INTERSECTING the region reset the quiet timer, so
  background churn OUTSIDE it can't (the direct fix for both the no-network re-render miss AND the
  global-quiescence over-wait). Fuses WAAPI animation-settle + an optional `awaitQuiescence` network
  gate. NOT `networkidle` rebranded: the region comes from the observed effect and the settle is local.
  Honest by construction: no `ready`/`safe`/`settled` boolean, no retry; `effectAppeared:false` is an
  honest "no effect" (a no-effect action reports `hitMaxWait:true`, never a fake clean settle);
  `hitMaxWait` = INCONCLUSIVE; region-scoped `suspectedEarly` flags a late wave. Reuses the same buffered
  records + baseline footprints as the delta (a settle VARIANT, not a second observer). No-DOM effects
  (canvas/WebGL) honestly report `effectAppeared:false` — compose the public `diffChangedRegion` to
  localize by pixels (kept out of the lean `deltawright/wait` subpath, which stays pngjs-free).

- **`pageMap(page, opts?)` + `renderPageMap(map, opts?)` — the R2 flagship: a spatial + semantic
  "marked page map."** The first primitive of the authoring-enhancer chapter (see
  `docs/plans/dw-authoring-enhancer-plan.md`). It reads a bounded set of SALIENT nodes (interactive +
  landmark/heading) in ONE in-page pass — reusing the same per-node geometry+occlusion read the delta
  uses (`readGeometry`) via a new stateless `scan()` mode on the injected observer — and fuses the
  fields no ARIA snapshot or `boundingBox` carries: deterministic **occlusion** (`coveredBy` / apparent
  z-layer), **actionability**, and (composed after an action, via a supplied `delta`) **recency**, onto
  each node's exact geometry + coarse zone. On a poor-a11y div-soup page it distinguishes two IDENTICAL
  `button "Save"` — naming the covered one `covered-by <overlay>` where an ARIA snapshot renders them
  the same and `boundingBox` has no notion of coverage. Honest by construction (DW-02/03): verdicts are
  **geometry-derived by default** and rendered in a DISTINCT vocabulary (`reachable` / `covered-by …`)
  so a single line can never be mistaken for Playwright's judgment; `{ reconcile: true }` additionally
  runs Playwright's AUTHORITATIVE probe on interactive nodes (then the verdict reads
  `ACTIONABLE` / `NOT-actionable (…)`), Playwright wins any disagreement, and it is surfaced
  (`[geom:…]`), never hidden. Occlusion is a
  center-point hit-test that names only what was hit-tested; off-screen nodes are marked, not dropped;
  apparent z-layers are inferred from hit-tests (not a CSS `z-index` claim). ADDITIVE + STATELESS: the
  scan stamps only `data-dw-map-ref` (never `data-dw-ref`), so it never disturbs a prior delta's refs,
  and the delta/serialize paths are byte-unchanged. Exported from the main entry
  (`import { pageMap, renderPageMap } from 'deltawright'`).

## [0.9.3] - 2026-07-15

### Added

- **Reporter side-car COVERAGE guarantee — one side-car per finally-failed test.** Dogfooding the
  reporter on a 292-test suite showed it wrote side-cars for only **56 of 80** finally-failed tests: the
  passive `onTestEnd` path only sees `failed`/`timedOut` results, so a failure raised in a
  `beforeAll`/`afterAll` hook or a fixture (which never surfaces as a per-test `failed`/`timedOut`
  result) was silently uncovered. The fix in `deltawright/reporter` is a single backstop: `onEnd` now
  SWEEPS the run's test tree (`suite.allTests()`) and writes a minimal `unsure` **coverage** side-car for
  every GENUINELY finally-failed test it hasn't already diagnosed — gated on BOTH `outcome() ===
  'unexpected'` AND a real-failure FINAL result status (`failed`/`timedOut`/`interrupted`). This
  **guarantees one side-car per finally-failed test (80/80)** while correctly excluding an
  interrupted-ONLY test (its `outcome()` is `'skipped'`, not finally-failed) and a passing `test.fail()`
  (its final result is a PASS — no false failure record). The flaky-then-passed exclusion is preserved (a
  finally-green test still writes NOTHING), a `[failed, interrupted]` retry keeps its attempt-0 real
  diagnosis (never clobbered to `unsure`), a test is never double-written, and everything stays guarded
  (never breaks the run). No fabrication: a coverage record is `unsure`/`unknown` with a truthful detail
  (DW-02/03). See ADR 2026-07-15.
- **`attachDiagnosis(testInfo, delta)` — DW's diagnosis INSIDE the Playwright HTML report.** Where
  `attachDelta` attaches only the raw machine delta (a download), the new `attachDiagnosis` export
  attaches the machine `deltawright-delta` (so the reporter's rich mode still fires) AND diagnoses the
  delta right now through the SAME `triageFailure` engine, attaching a second human-readable
  `deltawright-triage` (`text/plain`) attachment — the rendered triage text — which the standard
  Playwright HTML report shows inline per test. Diagnosing through the one engine means the inline text
  can't drift from the side-car. `attachDelta` is unchanged (back-compat): the zero-edit reporter writes
  side-cars BESIDE the report; `attachDiagnosis` is the opt-in one-liner that puts DW INSIDE it. See ADR
  2026-07-15.
- **Interactive flake dashboard — per-test EXPLANATION, not just counts.** `recordFromSidecar` discarded
  the side-car's `detail`/`diagnoses`/`source`, so `flakes.html` was a static count table. `FlakeRecord`
  now RETAINS `detail`, `source`, and a `diagnoses` array (read defensively — foreign/partial side-cars
  still degrade); `TestFlakeSummary` carries a per-test `records` list; and each dashboard row is now
  EXPANDABLE — a native `<button>` toggle (keyboard-accessible: `aria-expanded` + `aria-controls`) opens
  a detail panel showing, per failure record, `cause (confidence)` · the `detail` text · the
  per-diagnosis lines `[scope] code (confidence) — detail` · flags (detached / late-wave / stale-rect) ·
  source. Vanilla inline JS/CSS, the existing theme toggle kept, self-contained (no external asset). All
  dynamic text (test IDs AND detail/diagnosis strings — user data) is HTML-escaped; the `unsure` bucket
  stays honest and separate (never fabricated, never folded into a category). See ADR 2026-07-15.

## [0.9.2] - 2026-07-15

### Added

- **Move 3 follow-ups — `awaitQuiescence` in the locator-free wait path + a JSF/PrimeFaces busy hook.**
  Two additive pieces, both gated exactly like the shipped `awaitQuiescence` (default off → byte-unchanged):
  - **Piece A — `observeConsequences` (`deltawright/wait`) now accepts `awaitQuiescence`.** The
    locator-free settle SIGNAL — the #41-validated observe-when-ready niche — can now wait for real
    network idle (in-flight XHR/fetch count 0, no framework hook busy) before it resolves, mirroring
    `actAndObserve` exactly: only when set does it `enableQuiescence()` (install the in-flight counter)
    and factor `isQuiescent()` into settle, and it surfaces `quiescent` on the observation the same
    conditional way (still bounded by `maxWaitMs`). Unset → no patching, no `quiescent` field, identical
    settle.
  - **Piece B — a JSF/PrimeFaces framework-busy hook in `frameworkBusy()`.** In addition to ExtJS
    (`Ext.Ajax.isLoading()`), the observer now recognises a busy PrimeFaces ajax queue
    (`PrimeFaces.ajax.Queue.isEmpty() === false`, or a raw `.requests` array on builds without
    `isEmpty`). Every hop is typeof/optional-chaining guarded, so an absent or differently-shaped
    framework never throws; consulted only from `isQuiescent()` (the opt-in path), so the default path
    is untouched. **Plain JSF (Mojarra/MyFaces) has no stable public idle API, so no hook is invented
    for it** — it falls back to the framework-agnostic network counter, which already catches its
    `jsf.ajax` XHRs (honesty over coverage).
  - **Honest scope:** the new framework tests are **SYNTHETIC** — mock `window.Ext` / `window.PrimeFaces`
    globals matching the public shape. This validates the hooks discharge part of Move 3's "prove the
    framework hooks" gate WITHOUT a real portal; it does **not** equal real-app validation (a real
    ExtJS/JSF app is still needed) and does **not** address GWT's zero-network `Scheduler` waves (that
    is `lateWatchMs`). The network counter remains the general path; the framework hooks are best-effort
    accelerators. See ADR 2026-07-15.
- **Live ownership-routing — opt-in `routeSignals` (v0.9 Move 2, live arm).** The live half of Move 2,
  the parallel of the offline `diagnose-trace` routing arm. When opted in, `actAndObserve` attaches four
  page-level listeners — `response` (status ≥ 400 only), `requestfailed`, `pageerror`, and `console`
  (error/warning only) — that bracket the action + settle (the listener **lifetime is the window**, so no
  timestamp math), and surfaces a `stats.routing` **`LiveRoutingReport`**: a "this failure may not be
  Deltawright's DOM-actionability class; route it elsewhere" hint. **Co-occurrence, never causation**
  (DW-03): a co-occurring uncaught `pageerror` flips `suspectedNotDomCause` (route to the app owner); a
  4xx/5xx response or a failed request flips `suspectedBackendCause` (route to backend/infra); a
  `console.error` is context, never a verdict-flip. It emits **no** taxonomy code and never overrides
  Playwright's action outcome (DW-02). Catches signals a trace would miss — the live arm yields on the
  LIVE path even when a legacy app that swallows its JS errors leaves an offline trace empty (see the
  offline-ceiling assessment). **Additive + opt-in:** off by default → ZERO listeners are attached and
  `stats.routing` is absent, so the default path is byte-unchanged; listeners are detached in a `finally`
  (via named refs + `page.off`) even when the action throws, so `page.listenerCount(...)` returns to
  baseline. **Privacy:** the report carries no raw URL or full console text — only a status, a
  query-stripped URL path, and a length-capped snippet. New exports `buildLiveRouting` (pure) +
  `LiveRoutingReport`/`LiveRoutingSignal`/`LiveSignalKind`/`CollectedLiveSignals`/`RawLiveSignal`. See
  ADR 2026-07-15.
- **Offline input-integrity arm for `diagnose-trace` (v0.9 Move 1 offline, #81).** `diagnose-trace` now
  reconstructs the Move 1 `input-not-committed` finding from a trace, with **no live browser**: for a
  value action (`fill`/`type`/`pressSequentially`) it compares the **intended** value (the action's
  `params.value`/`params.text`) to the **committed** value (the target field's `__playwright_value_` in
  the `after@<callId>` frame-snapshot), matched to the target by Playwright's `__playwright_target__`
  stamp (falling back to the selector's id/name key). It runs the **same** FP-guarded `classifyInput` the
  live arm uses (reused, not re-implemented) and surfaces a genuine character loss
  (`never-committed`/`truncated`/`dropped`) as an additive **`suspected` `input-not-committed`** line — a
  case/reorder or subtractive separator/whitespace mask is deliberately **not** flagged. No new taxonomy
  code, no SHA change, no DW-04 governance.
  - **Honest by construction (DW-02/03).** Every finding is `suspected` (reconstructed, not live-probed);
    it never fabricates — no `after@` snapshot, an unresolvable/ambiguous field, or a reference-hidden
    value all emit **nothing** (honest silence, not a guess). The wording is "typed X chars, the
    after-snapshot shows Y — suspected input-drop," **never** "Playwright's fill failed."
  - **Complement, not replacement.** The `after@` snapshot is captured right after the action returns, so
    it can predate a **deferred** async drop (the debounce-then-clear pathology) that the **live** arm
    (post-settle read) catches — the report states this limit on every finding. Low yield on
    timeout-dominated corpora where the failure is not a value-assertion.
  - **Privacy.** Only `{ shape, intendedLen, committedLen }` are stored; the raw value is compared
    in-memory and never printed (mirrors the live arm). Additive: a clean / non-value trace's report is
    byte-unchanged. See ADR 2026-07-15.

## [0.9.1] - 2026-07-14

The v0.9 live-path pivot — after the offline arms (0.9.0) were measured at only +1 point on a real
backend-timeout corpus (its opaque failures are offline-opaque), the remaining value is acting/observing
when the app is actually ready.

### Added

- **Network-idle quiescence — opt-in `awaitQuiescence` (v0.9 Move 3).** The observer installs an
  in-flight `XMLHttpRequest`/`fetch` counter (monkey-patched only when opted in, so the default path
  leaves native fetch/XHR untouched); with `awaitQuiescence`, `waitForSettle` resolves only once the DOM
  is quiet **and** the app is network-idle (still bounded by `maxWaitMs`), and reports `quiescent`
  (`false` at a cap = the app was still requesting). Framework idle hooks (`Ext.Ajax.isLoading`) ride on
  top best-effort. Read-only — never fires events or forces loads; default off → the settle path is
  byte-unchanged. Improves the observe-consequences niche on RPC-driven legacy apps; does **not** catch
  GWT's zero-network `Scheduler` waves (that is `lateWatchMs`) and does not change actionability verdicts.
  Framework-agnostic first (GWT-RPC/ExtJS/JSF all issue XHR/fetch); accurate for requests made through
  the patched globals (not a reference captured before the patch, or a child frame). See ADR 2026-07-14.

## [0.9.0] - 2026-07-14

The v0.9 reframe: Deltawright as the honest cross-class cause **classifier/router** for agents — it
names which failures are its DOM-actionability class, and, just as valuably, which are not.

### Added

- **Post-settle input-integrity — `input-not-committed` (Move 1).** After a value-bearing action
  (`fill`/`type`) that Playwright reports as **success**, Deltawright re-reads the field's committed
  value at the existing post-settle read point and flags a silent character loss — the async
  debounce-then-clear a synchronous post-fill check structurally cannot see (e.g. a GWT SuggestBox that
  clears the field after its RPC returns). A loss requires a dropped **letter or number** (Unicode-aware,
  for non-English targets); a case/reorder mask or a subtractive separator/whitespace mask
  (`4111 1111` → `41111111`) is deliberately **not** flagged (the false-positive guard). New taxonomy
  code `input-not-committed` (new `outcome-integrity` category), always `suspected` (a value comparison,
  never an override of Playwright's success — DW-02/03). Opt-in `inputIntegrity` on `actAndObserve`
  (~zero added latency) + a new char-by-char `type` MCP action. **Privacy:** only lengths + shape are
  stored, never the raw value.
- **Offline ownership-routing (Move 2).** `diagnose-trace` now reads the trace's own error signals and
  surfaces them as **routing hints** — co-occurrence, never causation (no taxonomy code, no verdict):
  - **In-page:** window-correlated `console`/`pageError`; an uncaught JS error with no DOM cause →
    `suspectedNotDomCause` (route to the app owner).
  - **Harness:** test-scoped backend-error lines from the runner's `stdout`/`stderr` (context-anchored
    HTTP 4xx/5xx / gateway / `ECONN*`, not a bare number) → `suspectedBackendCause` (route to
    backend/infra).
  Both are additive (a trace with no such events renders a byte-unchanged report) and suppressed when
  Deltawright names a DOM cause. **Honest scope:** on a corpus whose failures don't carry these signals
  (e.g. legacy apps that swallow their JS errors and don't log backend faults as HTTP-status lines),
  offline routing adds little — it is a correct, general capability whose yield is corpus-dependent, not
  a universal win.

### Changed

- The root-cause taxonomy grows to **19 codes** (`input-not-committed` under the new `outcome-integrity`
  category). The frozen DW-04 lock, the canonical spec, and the accuracy corpus were updated in
  lock-step; the three accuracy floors (DW-02 100%, confirmed-precision ≥95%, silent-miss ≤5%) stay green.

## [0.8.0] - 2026-07-14

### Added

- **`deltawright diagnose-trace <trace.zip>`** (the v0.8 flagship, #9): read a Playwright trace
  **offline** — no re-run, no browser — and explain the failing action's root cause. It extracts the
  failed action's method/selector, terse error, and retry **call-log** (where Playwright records the
  actionability cause, e.g. `intercepts pointer events` / `element is not enabled`), reconstructs a
  synthetic delta, and runs the **same shared `diagnose()` engine** the live primitive and the reporter
  use. "The agent reads your failing run."
  - **Honest by construction (DW-02/03).** Everything is reconstructed, not live-probed, so every
    offline cause is **clamped to `suspected`** — never `confirmed` (a dedicated, load-bearing test
    asserts no `confirmed` escapes). A non-actionability failure (assertion / app error) or an
    unresolved locator stays **`unsure`** — a cause is never fabricated (it reuses the reporter's exact
    classification, so the offline diagnosis and the live reporter can't drift).
  - **Dependency-free trace reading.** The `trace.zip` is unzipped with only Node's built-in `zlib`
    (its output checked byte-for-byte against system `unzip` during development); no new runtime
    dependency, and `playwright-core` internals
    are never imported. Merges the `test.trace` + `0-trace.trace` split that `@playwright/test` traces
    use. A **version guard** hard-refuses any trace `version` outside the validated set (v8) rather
    than mis-parsing a shifted format.
  - Scope: the error-string-grounded path only. Geometry, the live verdict, and observer stats are
    live artifacts absent from a trace, so the geometry-grounded codes and stats codes are out of
    reach by design — DOM-snapshot / geometry reconstruction is a deferred follow-up.
  - Reuse-only, engine untouched: the accuracy floors (DW-02 / confirmed-precision / silent-miss) are
    unchanged and still gated. Adds a shared `capConfidence` primitive and extracts the
    error→synthetic-delta helper (`syntheticDelta` + the actionability/detached guards) into
    `src/host/synthetic-delta.ts` so the reporter and the trace reader share one classification.

## [0.7.5] - 2026-07-11

### Added

- **Accessibility state surface** (Wave-2 #8): a delta node now carries the **direction** of an ARIA
  state toggle and a live-region annotation — two additive, default-absent fields. `stateChanges`
  gives the old→new **values** for allowlisted state attributes (`aria-expanded`/`-selected`/
  `-pressed`/`-checked`/…, `disabled`, `open`, …), so "aria-expanded changed" becomes
  "aria-expanded false→true" (the menu is now open) — the direction the mutation delta's attribute
  **names** alone couldn't express. `ariaLive` marks a change inside an `aria-live` /
  `role=status|alert|log` region (a change assistive tech would announce). The serializer renders
  `state:aria-expanded=false→true` and `live:polite` additively. **Additive + safe:** annotation only
  (no verdict/geometry change — DW-02), never relabels role/name (DW-03), no checksum change, and the
  default serialized delta is byte-unchanged. It deliberately does **not** diff the full a11y tree or
  swap in Playwright's accessible-name algorithm (which would let a second naming pass relabel a
  node). ADR 2026-07-11.

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

[Unreleased]: https://github.com/mstomar698/deltawright/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/mstomar698/deltawright/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/mstomar698/deltawright/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/mstomar698/deltawright/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mstomar698/deltawright/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mstomar698/deltawright/compare/v0.6.0...v0.8.0
[0.6.0]: https://github.com/mstomar698/deltawright/compare/v0.1.0...v0.6.0
[0.1.0]: https://github.com/mstomar698/deltawright/releases/tag/v0.1.0
