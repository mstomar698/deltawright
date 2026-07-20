# R1 — Wait-free readiness: "the action's own effect has landed AND stopped changing"

> Research block R1 of the DW enhancer charter (`00-RESEARCH-CHARTER.md`). **The crux question.**
>
> **How can DW know an action's effect has *landed and stabilized* — without a static sleep and without
> global `networkidle` — including the case Playwright's own signals miss: a client-side re-render with
> zero network activity?**

All framework names below (Playwright, GWT, Cypress, …) are generic technical terms; nothing here is
product- or client-specific.

---

## 0. The problem, stated precisely

Three ways to decide "the page has reflected my action, act now":

| Mechanism | Failure mode observed in the field |
|---|---|
| **Static sleep** (`waitForTimeout`) | Dead time when the app is fast; too short when it's slow. Pure guess, uncorrelated with the actual effect. |
| **Global `networkidle`** | On a legacy RPC/GWT app it **OVER-waits** (background polling / long-lived sockets / analytics beacons mean the network never idles for 500 ms) *or* **UNDER-waits** (returns during a network lull *before* a client-side re-render that made no request). |
| **`waitForSelector` / `expect(locator)`** | Requires you to **name the expected end-state in advance**. Works only when you already know exactly which element/text will appear. Silent when the effect is a re-layout, a value commit, a canvas repaint, or a subtree swap you didn't predict. |

The specific real-world regression that motivates R1: a test read the screen **after a network lull but
before a no-network client re-render**, so `networkidle` returned early and the assertion ran against the
pre-render DOM. Neither `networkidle` (no network to wait on) nor a naive sleep (unknowable duration)
protects against this, and `waitForSelector` only helps if you can enumerate the exact post-render locator.

**The gap DW should fill:** a signal that is (a) **causal** — keyed to *the action's own effect*, not to
unrelated global activity; (b) **assertion-free** — derived from *what actually changed*, so the author
does not have to predict the end-state; and (c) **background-churn-immune** — the effect region going
still is what matters, not the whole page or the whole network.

---

## 1. Prior-art survey

### 1.1 Playwright's own auto-wait / actionability internals

Before every action Playwright runs an actionability retry loop (~every 100 ms, up to a timeout) that
checks: **attached, visible, stable, enabled, receives events (not covered)**. "Stable" is defined
precisely: an element is stable when **its bounding box is unchanged across two consecutive animation
frames**.
- <https://playwright.dev/docs/actionability>

Two limits matter for R1:

1. **It is per-target and pre-action.** It stabilizes the *one element you're about to click*, *before*
   the click. It says nothing about whether the *consequence* of the click has landed and settled.
2. **It races a mid-action re-render.** The "stable for 2 frames" check can pass on a DOM node that a
   framework then unmounts and replaces (React reconciles by component identity, not DOM identity). A state
   update from validation / focus / a mount effect rebuilds the parent, the old node detaches, and the
   click lands on a stale handle — `"Element is not attached to the DOM"`, ~5 % on slow CI. **Crucially
   this happens with no network activity, so `networkidle` gives no protection.** Recommended mitigation is
   to anchor locators to a stable parent and let Playwright re-query — but that is a *retry* fix, not a
   *readiness* signal.
   - <https://mergify.com/blog/playwright-auto-wait-element-rerenders>

Playwright's **`toHaveScreenshot()`** contains a genuinely relevant idea: it **retries the screenshot
until two consecutive captures are byte-identical** (animations disabled by default), i.e. a *visual
settle* rather than a network settle. It is viewport/element-scoped and baseline-oriented, but the
"two-consecutive-identical" primitive is directly reusable — see §1.6.
- <https://playwright.dev/docs/test-snapshots> · <https://qaskills.sh/blog/playwright-visual-regression-testing-guide>

**Why `networkidle` is discouraged** (Playwright's own guidance now flags it; Biome even lints it):
it waits for ~500 ms with no in-flight requests, which SPAs with polling/sockets/beacons never reach
(over-wait), and it is blind to client-side state updates that fire no request (under-wait). The official
recommendation is to wait on an **application-visible readiness signal** (e.g. `expect(locator).toBeVisible`)
instead — which again pushes the "name the end-state" burden back onto the author.
- <https://github.com/microsoft/playwright/issues/22897>
- <https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-networkidle-misuse>
- <https://biomejs.dev/linter/rules/no-playwright-networkidle/>

### 1.2 Consequence / assertion-retry waiting (Cypress, TestCafe, Selenium, Testing-Library)

The dominant "smart wait" pattern across tools is **retry the assertion until it passes** — a
*consequence-based* wait. The tester encodes the expected end-state, and the tool polls.

- **Cypress retry-ability** — commands carry built-in assertions and re-run "from the top" until they pass
  or time out; the tool re-queries the DOM each retry. It explicitly wrestles with the **detached-DOM**
  problem: if the page re-renders between two assertions, the cached subject is stale; the fix is to break
  the chain or use a `.should(cb)` callback that re-queries.
  - <https://docs.cypress.io/app/core-concepts/retry-ability> · <https://github.com/cypress-io/cypress/issues/8074>
- **TestCafe smart waiting** — waits for selectors to appear/become visible, and the **Smart Assertion
  Query Mechanism** recomputes the actual value until it matches the expected value or times out; it also
  auto-waits a bounded window (≈3 s) for XHR/fetch before an action.
  - <https://testcafe.io/documentation/402827/guides/advanced-guides/built-in-wait-mechanisms>
- **Selenium `ExpectedConditions` / `WebDriverWait`** — explicit-wait polling (default 500 ms) over
  prebuilt or custom conditions (`attributeToBe`, custom attribute-change predicates, a "redraw" wrapper to
  survive `StaleElementReferenceException`). Entirely author-supplied conditions.
  - <https://www.selenium.dev/selenium/docs/api/java/org/openqa/selenium/support/ui/ExpectedConditions.html>
- **Testing-Library `waitFor`** — the most architecturally interesting: it wraps a **MutationObserver**
  and **re-runs the callback on every DOM mutation** (plus an interval), resolving when the callback stops
  throwing. This is *observer-driven consequence waiting* — but the consequence is still a user-supplied
  assertion.
  - <https://testing-library.com/docs/dom-testing-library/api-async/>

**Common limitation for R1:** every one of these requires the author to **declare the expected
consequence** (a locator, a value, a predicate). None of them can say "wait for *whatever this action
changed* to stop changing" without being told what to look for. That is exactly the assertion-free gap DW
is positioned to fill, because DW already *computes what changed* (the delta).

### 1.3 Visual-stability detection (Applitools)

- **`MatchTimeout`** — Eyes waits up to N seconds for the screenshot to *stabilize toward the baseline*;
  it captures immediately, compares to baseline, and retries until match or timeout (so a page that settles
  in 1 s continues after 1 s even if the timeout is 10 s). This is baseline-anchored visual sync.
  - <https://help.applitools.com/hc/en-us/articles/360006915352-Match-Timeout>
- **`waitBeforeCapture`** — an explicit "delay after the DOM is stable" hook (ms, or wait for a
  selector's presence/absence, or a custom async fn). Applitools' own guidance says most frameworks already
  have adequate animation/loading handling and to prefer those.
  - <https://applitools.com/blog/handling-animations-and-loading-artifacts-in-visual-testing/>

**Limitation for R1:** visual stability here is **baseline-dependent** and **whole-target-scoped**. It
answers "does the capture match the golden image / has the whole shot gone still," not "has *the region my
action perturbed* gone still." On a page with background churn (a clock, a ticker, a spinner elsewhere),
a whole-viewport visual settle never converges — the same over-wait failure as `networkidle`.

### 1.4 Vision-based AI browser agents (Skyvern, Stagehand, browser-use)

- **Skyvern** treats "the DOM is a lie" and re-reads the page **visually** (screenshot → vision model)
  every step; readiness is implicit — each step re-evaluates the current pixels, so there is no explicit
  settle signal, just a fresh look each turn (expensive, model-latency bound).
  - <https://github.com/skyvern-ai/skyvern>
- **Stagehand / browser-use** are DOM/a11y-driven on top of Playwright; they inherit Playwright's
  auto-wait and re-invoke the LLM to re-map when a cached action fails on a changed DOM. Readiness is
  "Playwright says actionable" + LLM re-mapping on failure.
  - <https://github.com/browserbase/stagehand> · <https://dev.to/stevengonsalvez/browser-tools-for-ai-agents-part-2-the-framework-wars-browser-use-stagehand-skyvern-4gn>

**Takeaway:** the frontier agent answer to "is it ready?" is either *re-screenshot-and-reason every step*
(vision, slow, no explicit settle) or *lean on Playwright auto-wait + retry-on-failure* (DOM). Nobody
publishes a cheap, explicit, **causal effect-settled** signal. That is open space.

### 1.5 Browser platform primitives for "the engine is idle / done rendering"

These are the raw signals DW can compose in-page (all Chromium-first, which fits DW's Chromium-only scope):

- **MutationObserver settle** — the classic "no mutations for a quiet window" heuristic. DW already uses
  this (§3). Well-understood weakness: it cannot by itself tell an *effect* mutation from *background*
  mutation.
- **Long Animation Frames API (LoAF)** — `PerformanceObserver` with
  `observe({ type: 'long-animation-frame', buffered: true })` reports any animation frame whose render took
  **> 50 ms**. Each entry carries `startTime`, `duration`, `renderStart`, `styleAndLayoutStart`,
  `blockingDuration`, `firstUIEventTimestamp`, and a `scripts[]` array (each script ≥ 5 ms with
  `sourceURL`/`sourceFunctionName`, `forcedStyleAndLayoutDuration`, etc.). LoAF is a direct **"the main
  thread is busy rendering right now"** signal — a client-side re-render that makes no network request
  *still shows up* as script + style/layout work in a LoAF entry. Chrome 123+.
  - <https://developer.chrome.com/docs/web-platform/long-animation-frames>
  - <https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming>
  - <https://github.com/w3c/long-animation-frames>
- **`requestIdleCallback`** — fires when the main thread has idle time after input + rendering; a coarse
  "the engine has nothing queued" signal (deadline-based; can starve on a busy thread).
- **`requestAnimationFrame` / double-rAF** — `rAF(() => rAF(cb))` guarantees a callback *after* the next
  layout+paint; the standard way to know "a render has actually happened since I scheduled this."
  - <https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame>
  - <https://dev.to/dhwang/requestanimationframe-vs-requestidlecallback-1m8c>
- **Web Animations API** — `element.getAnimations()` returns running CSS/WAAPI animations; awaiting their
  `.finished` promises tells you an *animated* effect has completed. **DW already does this** in
  `settleAnimations` (§3), scoped to the changed subtree.

**Synthesis of §1.5:** the platform gives three orthogonal "engine done" signals —
**structural quiet** (MutationObserver), **paint/animation done** (rAF + WAAPI), and **main thread idle**
(LoAF / `requestIdleCallback`). None is individually sufficient (structural-quiet misses a repaint with no
mutation; rAF misses a pending microtask that will mutate next tick; LoAF misses a pure-CSS transition with
no long task). Their **conjunction, scoped to the effect region,** is the interesting composite nobody has
packaged.

---

## 2. Candidate approaches

| # | Approach | Catches no-network re-render? | Immune to background churn? | Assertion-free? | Verdict |
|---|---|---|---|---|---|
| A | Static sleep | — | — | yes | Discard (baseline). |
| B | Global `networkidle` | **no** | **no** | yes | Discard — the failure we're replacing (HARD CONSTRAINT: this is the rebranded-Playwright trap). |
| C | `waitForSelector`/`expect(locator)` on the predicted end-state | yes (if predicted) | yes | **no** | Not DW's job — this *is* Playwright, and it needs the author to know the answer. |
| D | Whole-viewport visual settle (2-consecutive-identical screenshots) | yes | **no** | yes | Half-right; background churn (clocks/tickers/spinners) never converges. |
| E | Global MutationObserver quiet (DW's current `waitForSettle`) | yes | **partly** (baseline-churn filter) | yes | DW today; the known GWT weakness is *global* scope — background structural churn resets the timer. |
| F | **Region-scoped, causal effect-settle** (compose delta-region + region-scoped MO quiet + WAAPI + optional region pixel cross-check + optional LoAF/network gate) | **yes** | **yes** (region + baseline footprints) | **yes** (region derived from the delta) | **Recommended — see §6.** |

Approach **F** is the only candidate that is simultaneously causal, assertion-free, and
background-churn-immune. It is a *composition of DW primitives*, not a new engine.

---

## 3. How DW's existing primitives enable approach F

DW already owns every ingredient; F is a re-composition, not new machinery. (Verified against current
source, not just memory.)

- **`src/injected/observer.ts` — coalescing MutationObserver + baseline churn learning.** The observer
  tracks `lastMutationAt` and `lastStructuralAt`, and distinguishes **structural** (element add/remove)
  from **non-structural** (attr/text) churn. `sampleBaseline` runs a short pre-arm window that learns which
  `(element, channel)` pairs already churn (`bgText`/`bgAttr`) **and recurring element-insertion signatures**
  (`bgInsert`, `parent>tag.class|role`, count ≥ 2). `coalesce` then builds the net delta **excluding** those
  background footprints. → DW *already knows how to subtract background churn from an effect*. This is the
  single most important asset for beating `networkidle`/global-quiescence on GWT.
- **`waitForSettle(opts)`** — the existing bounded settle: once a structural change is seen it waits for
  **structural** quiet for `quietMs`; else any-quiet; else the `maxWaitMs` cap. Ticker attr/text churn no
  longer waits out the cap. **Gap for F:** `lastStructuralAt` is **global** — *any* structural change
  anywhere resets it, so background structural churn (toasts, virtualized rows, a re-inserting GWT cell)
  still defeats it. F's core upgrade is to make this timer **region-scoped**.
- **`settleAnimations(roots, animMaxMs)`** — already awaits `getAnimations().finished` for the **changed
  subtree**, raced against a cap. This is the WAAPI "animated effect done" signal, *already region-scoped*.
- **`enableQuiescence()` / `isQuiescent()`** (opt-in Move 3) — a framework-agnostic in-flight XHR/fetch
  counter + guarded framework idle hooks (ExtJS `Ext.Ajax.isLoading`, PrimeFaces queue). This is the
  **optional** network gate — used only when the caller asks, and honestly labeled. It is *not* the
  primary signal (that would be networkidle rebranded); it's an accelerator.
- **`readGeometry`** — per-changed-node `rect` + `coveredBy` + root-aware `elementFromPoint`. → gives the
  **bounding rectangle of the effect** for free (union of changed-node rects), which is what "region" means.
- **`diffChangedRegion(before, after)`** (`src/host/screenshot-diff.ts`) — pixel bounding-box of change
  between two screenshots, with `channelThreshold`/`minPixels` noise floors. → the **pixel cross-check** and
  the **no-DOM-mutation fallback** (canvas/WebGL/text reflow that mutates no node).
- **Gap-E late-watch (#49)** — a *separate* observer that flags a structural wave arriving **after** the
  settle point (`suspectedEarly`), without touching the frozen delta. → F's honesty signal that the settle
  may have been early.
- **Anchor latching** — the observer latches the trusted-event target element as an anchor. → a
  causality seed: the effect region can be *rooted at the element the action actually touched*, tightening
  "which mutations are the effect."

**What must be built (small):** (1) a **region filter** so the structural-quiet timer only resets on
mutations whose target intersects the effect region; (2) a **first-non-background-mutation** edge to mark
"effect appeared" and seed the region; (3) optional **LoAF observer** as a main-thread-busy gate; (4)
optional **region-scoped** pixel cross-check (clip `diffChangedRegion` to the effect rect). Everything else
exists.

---

## 4. Honest differentiation check (genuinely-new vs Playwright-rebranded)

Per the charter's hard constraint, each idea is tested: *is this just Playwright with a nicer name?*

| Idea | Rebranded? | Honest verdict |
|---|---|---|
| Wait for network idle | **YES — `networkidle`.** | **Discard.** The optional `awaitQuiescence` gate is defensible *only* as a secondary, opt-in accelerator with an honest label, never the primary signal. On its own it is the exact thing we're replacing. |
| Wait for a named element/text/value | **YES — `waitForSelector`/`expect(locator).toPass`.** | **Discard as a DW primitive.** This is Playwright's job and it needs the author to predict the end-state. DW composes *with* it, doesn't reship it. |
| "Element stable for 2 frames before acting" | **YES — Playwright actionability.** | **Discard.** DW must not reimplement actionability (non-negotiable #2); Playwright's verdict is authoritative. F is *post-action effect* settle, a different phase. |
| Whole-viewport 2-consecutive-identical screenshots | Partly (`toHaveScreenshot`). | **Discard whole-viewport.** Reuse the *technique* only when **clipped to the effect region** — that scoping is the new part. |
| MutationObserver quiet window | Generic (Testing-Library, everyone). | Not novel alone. |
| **Region-scoped, assertion-free, causal effect-settle** (F) | **NO.** | **Genuinely new.** No surveyed tool waits for *"whatever this action changed" to stop changing* **without being told what to expect** and **while ignoring background churn**. Consequence-based tools (Cypress/TestCafe/Testing-Library) all require a declared consequence; visual tools (Applitools/`toHaveScreenshot`) are whole-target + baseline-bound; `networkidle` is global + network-only. The novelty is precisely the **composition**: *the delta supplies the region → the region scopes the settle → the settle fuses structural-quiet + animation-done + (optional) pixel-stable + (optional) network/main-thread-idle → the result is a labeled signal, never a `ready` boolean.* |

**Sharp one-line differentiation:** Playwright waits on things you must **name** (a selector, the network);
DW's proposal waits on the thing the action **did**, which DW can *see* because it already computes the
delta — and it stays still *locally*, so background churn elsewhere can't fool it. That is the
screenshot-vs-snapshot gap expressed as a readiness signal: a human watching the screen waits for *the part
that changed* to stop moving, not for the whole page or the network.

---

## 5. Feasibility + risks

**Feasibility: high.** ~80 % is re-wiring existing observer/geometry/screenshot-diff/animation code; the
new surface is a region-intersection predicate, a first-effect edge, and an optional LoAF observer.
Chromium-only is fine (DW's stated scope). All new signals degrade to the current behavior when off.

**Risks & mitigations:**

1. **Causal attribution is co-occurrence, not proof (honesty contract).** "The first non-background
   mutation after the action = the effect" is a heuristic. A background wave can coincide.
   → *Mitigate:* seed the region at the **anchor element** DW already latches; subtract **baseline
   footprints** (`bgInsert`/`bgText`/`bgAttr`); and **label the region `suspected-effect`, never
   `caused-by`.** The output must be a *signal* (like `settleMs`/`hitMaxWait`), never a causal claim.
2. **GWT / legacy background churn that re-inserts elements every tick reads as structural** (the known
   `waitForSettle` residual). If such churn lands *inside* the effect rect, region-scoping alone won't
   exclude it. → *Mitigate:* the `bgInsert` recurrence-footprint filter already quarantines repeated
   insertion signatures; region-scoping handles churn *outside* the rect; document that churn co-located
   with the effect degrades to the `maxWaitMs` cap with `hitMaxWait: true` (honest inconclusive), never a
   false "settled."
3. **No-effect actions** (the action changes nothing observable, or the effect is a repaint DW can't
   localize). → *Mitigate:* bounded by `maxWaitMs`; if no non-background mutation and (optional) no pixel
   change appear, return `effectAppeared: false` — an **honest "I observed no effect,"** not a fake ready.
   The optional viewport pixel-diff fallback (existing `screenshotFallback`) catches canvas/WebGL/no-DOM
   effects.
4. **The effect region moves/grows while rendering** (a modal expands, a list streams in). → *Mitigate:*
   re-derive the region each tick as the **union** of intersecting changed-node rects (the same union
   pattern DW already uses); the timer resets while the region is still growing, which is correct.
5. **Pixel cross-check cost.** Screenshots are expensive; per-tick full-viewport diffs would be pathological.
   → *Mitigate:* pixel cross-check is **opt-in**, **clipped to the effect rect**, and taken at most twice
   (the 2-consecutive-identical check) *after* DOM+animation quiet — not polled. Default path takes zero
   screenshots.
6. **LoAF blind spots / support.** LoAF only fires for frames > 50 ms and needs Chrome 123+; a pure-CSS
   transition with no long task won't appear. → *Mitigate:* use LoAF strictly as a **one-way accelerator**
   ("a LoAF is in flight ⇒ definitely not settled yet"); never require a LoAF to *declare* settled. Feature-
   detect and skip silently where unsupported.
7. **Over-trust.** The biggest product risk is the signal being read as a guarantee. → *Mitigate:* mirror
   the `deltawright/wait` contract exactly — **no `ready`/`safe`/`settled` boolean, no retry knob**; expose
   `hitMaxWait` + `suspectedEarly` as honesty signals; name it `observe…`, not `waitUntilReady`.

---

## 6. Recommended direction + minimal prototype sketch

**Recommendation: build approach F as `observeEffectSettled` (a.k.a. `actAndSettle`) — a region-scoped,
assertion-free, causal effect-settle signal that composes DW's delta + region-scoped MutationObserver +
Web-Animations settle + an optional clipped pixel cross-check, with LoAF/network only as opt-in
accelerators.** It is the one candidate that clears the HARD CONSTRAINT: it is neither `networkidle` nor
`waitForSelector` rebranded, because the region comes *from the observed delta* (nothing named in advance)
and the settle is *local* (background churn can't reset it).

Ship it two ways: (1) a standalone `deltawright/wait` export (locator-free, no reconcile — cheap); (2) an
option on `actAndObserve` so the returned delta is *already effect-settled* (the reconcile then runs on a
stable DOM, fixing the mid-action-re-render staleness class from §1.1).

### 6.1 API shape (honest by construction — no `ready` boolean)

```ts
// deltawright/wait  (composes existing primitives; opt-in signals default OFF = today's behavior)
export interface EffectSettleOptions {
  quietMs?: number;        // region must see no non-background effect mutation for this long (default 120)
  maxWaitMs?: number;      // hard cap; on hit → hitMaxWait:true (default 2000)
  animMaxMs?: number;      // cap for WAAPI settle in the region (default 1000)
  appearTimeoutMs?: number;// how long to wait for the effect to APPEAR before giving up (default = maxWaitMs)
  useLoaf?: boolean;       // main-thread-busy accelerator (Chrome 123+, feature-detected). default false
  pixelStable?: boolean;   // clip diffChangedRegion to the effect rect; require 2 consecutive identical. default false
  awaitQuiescence?: boolean;// optional network-idle gate (existing Move-3 hook). default false
  region?: 'anchor' | 'delta'; // seed region at the latched anchor, or the union of all effect nodes. default 'delta'
}

export interface EffectSettleObservation {
  effectAppeared: boolean;         // false = no non-background change observed (honest "no effect"), not "ready"
  appearedMs: number | null;       // arm→first non-background effect mutation
  settledMs: number;               // arm→region went still (or the cap)
  region: { x: number; y: number; width: number; height: number } | null; // suspected-effect rect (co-occurrence, not causation)
  hitMaxWait: boolean;             // capped, not quiet → treat as INCONCLUSIVE
  suspectedEarly: boolean;         // gap-E: a late wave hit the region after settle
  signals: {                       // which gates were satisfied (evidence, not a verdict)
    structuralQuiet: boolean;
    animationsSettled: boolean;
    mainThreadIdle?: boolean;      // only if useLoaf
    pixelStable?: boolean;         // only if pixelStable
    networkIdle?: boolean;         // only if awaitQuiescence
  };
  observed: boolean;               // false if injection blocked (strict CSP / non-Chromium)
}

export function observeEffectSettled(
  page: Page, action: Action, opts?: EffectSettleOptions,
): Promise<EffectSettleObservation>;
```

Note: **no `ready`/`safe` field and no retry** — same discipline as the existing `deltawright/wait` module.
The caller decides what to do with `hitMaxWait` / `suspectedEarly`.

### 6.2 Algorithm (in-page, extends `waitForSettle`)

```
armObserver(); sampleBaseline()          // learn bg footprints (bgInsert/bgText/bgAttr) — existing
t0 = now
run action                               // existing

// PHASE 1 — effect APPEARS (the causal edge, assertion-free)
appeared = await firstEffectMutation(appearTimeoutMs)
  // = first coalesced mutation NOT in the baseline footprints
  //   (structural preferred; attr/text on a non-bg (el,channel) also counts)
if (!appeared):
   if (pixelStable-or-screenshotFallback):
       region = diffChangedRegion(beforeShot, screenshot())   // canvas/no-DOM effect
       if (region == null) return { effectAppeared:false, ... }   // honest "no effect"
   else return { effectAppeared:false, ... }
region = (opts.region=='anchor') ? rect(latchedAnchor) : unionRect(appeared.touchedNodes)

// PHASE 2 — effect region STABILIZES (region-scoped, background-churn-immune)
lastEffectAt = appeared.at
loop every min(quietMs,25) until t0+maxWaitMs:
   // only mutations whose target intersects `region` and are NOT background reset the timer:
   for m in newCoalescedMutations():
       if (!isBackground(m) && rect(m.target) intersects region):
           region = union(region, rect(m.target)); lastEffectAt = now
   structuralQuiet     = now - lastEffectAt >= quietMs
   animationsSettled   = settleAnimations(region.roots, animMaxMs) done      // existing WAAPI settle
   mainThreadIdle      = !useLoaf     || noLoafInLast(quietMs)                // LoAF accelerator
   networkIdle         = !awaitQuiesc || isQuiescent()                       // existing Move-3 hook
   pixelStableOK       = !pixelStable || twoConsecutiveIdentical(clip(screenshot, region))
   if (structuralQuiet && animationsSettled && mainThreadIdle && networkIdle && pixelStableOK):
       startLateWatch(region)          // gap-E, existing — sets suspectedEarly if a late wave hits region
       return { effectAppeared:true, settledMs: now-t0, region, hitMaxWait:false, signals:{…} }
// cap hit:
return { effectAppeared:true, hitMaxWait:true, ... }   // honest INCONCLUSIVE, never a fake "settled"
```

Key deltas from today's `waitForSettle`:
1. **Region-scoped timer** — background structural churn *outside* the region no longer resets settle (the
   direct fix for the GWT over-wait weakness).
2. **First-effect edge** — a causal "appeared" timestamp + honest "no effect observed," instead of an
   unscoped global quiet.
3. **Signal fusion** — structural-quiet ∧ animations-done ∧ (opt) main-thread-idle ∧ (opt) pixel-stable ∧
   (opt) network-idle, each surfaced as *evidence*, so a no-network client re-render is caught by
   structural/pixel/LoAF even when network is silent.

### 6.3 Validation plan (before claiming the win)

- **Synthetic lab** (extend `dw-testgen-lab`): (a) a **no-network client re-render** fixture — assert F
  settles *after* the re-render where `networkidle` returns before it; (b) a **background-churn** fixture
  (a 250 ms ticker + a delayed real effect) — assert F settles on the effect and is *not* reset by the
  ticker, where global `waitForSettle`/whole-viewport visual settle over-wait to the cap; (c) a
  **canvas/no-DOM** fixture — assert the pixel fallback localizes the region; (d) a **no-effect** action —
  assert `effectAppeared:false`, not a fake settle.
- **Honesty gates:** F must never emit `hitMaxWait:false` on the background-churn-only (no-effect) case,
  and must expose `suspectedEarly` on a late wave. Add these as accuracy floors alongside the existing
  DW-02 / precision / silent-miss gates.

---

## 7. One-paragraph synthesis

The field has three separate "is it ready?" families — **global network settle** (`networkidle`: over/under-
waits, blind to no-network re-renders), **consequence-retry** (Cypress/TestCafe/Selenium/Testing-Library:
need a *declared* end-state), and **visual settle** (Applitools/`toHaveScreenshot`: whole-target,
baseline-bound, defeated by background churn). DW is uniquely positioned to fuse them into something none of
them is: a **region-scoped, assertion-free, causal effect-settle** — because DW *already computes the delta*
(so it knows the region without being told) and *already subtracts background churn* (so local settle beats
global quiescence on legacy/GWT). Build it as `observeEffectSettled`, honest by construction (no `ready`
boolean, `hitMaxWait`/`suspectedEarly` surfaced), composing the existing observer + geometry +
`diffChangedRegion` + WAAPI settle, with LoAF and network-idle as opt-in accelerators only.

---

### Sources
- Playwright actionability / auto-wait — <https://playwright.dev/docs/actionability>
- Playwright visual snapshots (2-consecutive-identical) — <https://playwright.dev/docs/test-snapshots> · <https://qaskills.sh/blog/playwright-visual-regression-testing-guide>
- Auto-wait re-render race (no-network) — <https://mergify.com/blog/playwright-auto-wait-element-rerenders>
- `networkidle` discouraged — <https://github.com/microsoft/playwright/issues/22897> · <https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-networkidle-misuse> · <https://biomejs.dev/linter/rules/no-playwright-networkidle/>
- Cypress retry-ability + detached DOM — <https://docs.cypress.io/app/core-concepts/retry-ability> · <https://github.com/cypress-io/cypress/issues/8074>
- TestCafe built-in waiting — <https://testcafe.io/documentation/402827/guides/advanced-guides/built-in-wait-mechanisms>
- Selenium ExpectedConditions — <https://www.selenium.dev/selenium/docs/api/java/org/openqa/selenium/support/ui/ExpectedConditions.html>
- Testing-Library `waitFor` (MutationObserver-driven) — <https://testing-library.com/docs/dom-testing-library/api-async/>
- Applitools MatchTimeout / waitBeforeCapture — <https://help.applitools.com/hc/en-us/articles/360006915352-Match-Timeout> · <https://applitools.com/blog/handling-animations-and-loading-artifacts-in-visual-testing/>
- Long Animation Frames API — <https://developer.chrome.com/docs/web-platform/long-animation-frames> · <https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming> · <https://github.com/w3c/long-animation-frames>
- requestIdleCallback / requestAnimationFrame — <https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame> · <https://dev.to/dhwang/requestanimationframe-vs-requestidlecallback-1m8c>
- AI browser agents (vision vs DOM readiness) — <https://github.com/skyvern-ai/skyvern> · <https://github.com/browserbase/stagehand> · <https://dev.to/stevengonsalvez/browser-tools-for-ai-agents-part-2-the-framework-wars-browser-use-stagehand-skyvern-4gn>

_DW primitives referenced (current source, verified): `src/injected/observer.ts` (`waitForSettle`,
`sampleBaseline`/`bgInsert`, `settleAnimations`, `enableQuiescence`/`isQuiescent`, gap-E late-watch, anchor
latching); `src/host/screenshot-diff.ts` (`diffChangedRegion`); `src/host/actAndObserve.ts`
(`screenshotFallback` region node); `src/wait/index.ts` (`observeConsequences` honesty contract)._
