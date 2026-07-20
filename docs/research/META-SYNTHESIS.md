# Deltawright enhancer research — META-SYNTHESIS

**Compiled 2026-07-20** from the four research blocks (`01-wait-free-readiness`, `02-spatial-page-model`,
`03-durable-selectors`, `04-competitive-gap`). This is the decision layer: the one thing DW should own, the
ranking, the unified product shape, the honest do-NOT list, and the build sequence to replan from.

---

## 1. The through-line (all four blocks converge on ONE sentence)

> **Every incumbent — test frameworks, visual/AI tools, browser agents — operates at *whole-page* or
> *target-element* granularity. Not one attributes a settle signal, a representation, or a change to *the
> specific action that caused it*. DW's categorical, un-owned difference is ACTION GRANULARITY.**

The physical asset that embodies it already exists and ships today: **`actAndObserve` — the action-scoped,
geometry-annotated delta.** R4's adversarial survey confirmed no competitor has it (Playwright-MCP even
re-mints element refs after every action, *structurally preventing* diffing; Skyvern's only delta is a
narrow dropdown detector; every AI agent re-serializes the whole page each step). This is the flagship
claim, and R1/R2/R3 are three expressions of it:

- **R2** = the delta's/​page's **spatial picture** (what is where, what covers what, what just changed).
- **R1** = the delta's **readiness half** (has *this action's* effect landed and gone still).
- **R3** = the delta's **selector byproduct** (a durable, scored handle for the changed node).

One engine — delta + geometry (`coveredBy`/`hitSelf`/z-order) + injected observer + `diffChangedRegion` —
three surfaces. And all three aim at the **same sweet spot**: legacy / poor-a11y / heavy-RPC apps where the
accessibility tree degrades (~19-pt agent-success drop; ~95.9% of pages have a11y conformance errors) and
`networkidle` never fires — exactly where DW's *structured determinism* beats both vision and the AX tree.

---

## 2. Ranking (empty-niche × already-owned × feasibility)

| Rank | Direction | Verdict | Why |
|---|---|---|---|
| **1 — flagship** | **R2 — spatial+semantic page model** (`pageMap` / "marked page map") | **Cleanest, emptiest gap; DW already owns the primitive.** | Field splits into pixels-only (computer-use, OmniParser, Skyvern) vs semantic-tree-only (ARIA snapshot, Stagehand) — **nobody exposes structured role/name + geometry + occlusion/covered-by + z-order**. The two tools that internally compute occlusion (Playwright, browser-use) **hide it**. It's a *packaging* problem, not discovery — lowest risk. It is the **substrate** R1 and R3 both need. |
| **2 — the differentiated capability** | **R1 — action-scoped effect-settle** (`observeEffectSettled`) | **Real gap, but only the *action-scoped* slice.** | The multi-signal-quiescence *primitive* is already commoditized (Waitless OSS, Applitools, Testing-Library). DW must NOT ship generic "is the page ready." The un-owned slice = **region-scoped, assertion-free, causal effect-settle that ignores ambient RPC/animation churn** — the direct fix for the client-side-re-render miss AND DW's own GWT over-wait weakness. Execution risk (never-settle) is the real challenge; region-scoping is the answer. |
| **3 — byproduct only** | **R3 — durable selector intelligence** (`scoreSelectors`) | **Mostly solved; a narrow legacy sub-gap.** | Uniqueness-of-a-role/text-selector **IS Playwright codegen** — reinventing it violates the charter. AI agents already sidestep id-churn by re-deriving identity each run. The only real gap: a **transparent durability score + brittleness flags + delta-anchored, occlusion-checked geometry-relative fallback** for unstable-id/poor-a11y apps. Ship as a thin layer on the existing `verifySuggestions`; never a flagship; durability is an **estimate**, never "stable across releases." |

---

## 3. The unified product shape (one primitive family, not three features)

All three sit on `actAndObserve`'s delta + the geometry/observer engine. Proposed surfaces (names from the
blocks):

- **`pageMap(page, opts)` + `renderPageMap()`** *(R2, flagship)* — a bounded, salient-node spatial map that
  **leads with** occlusion (`coveredBy`/apparent z-layer), actionability-reconciliation (geometry-vs-Playwright
  disagreement), and recency (what changed + where); **borrows** role/name from Playwright's ARIA snapshot
  (never re-derives the a11y tree). Reads like a screenshot; deterministic; offline; token-cheap.
- **`observeEffectSettled(page, action, opts)`** *(R1)* — the delta supplies the effect **region**; a
  region-scoped MutationObserver quiet-timer (background churn *outside* the region can't reset it) fuses
  structural-quiet + WAAPI animation-done + optional clipped pixel-stability, with LoAF / network-idle as
  **opt-in accelerators only**. Honest by construction: no `ready` boolean; surfaces
  `hitMaxWait`/`suspectedEarly`/`effectAppeared:false`.
- **`scoreSelectors(root, delta, opts)`** *(R3, byproduct)* — durability score (0–100) + grade + brittleness
  flags over `verifySuggestions` output (Robula+ blacklist + Similo two-tier weights), plus a delta-anchored
  geometry-relative fallback when nothing semantic verifies. Optional `measureRetention()` two-snapshot mode
  to upgrade the *estimate* to a *measured* retention number.

**These compose:** `pageMap` after `observeEffectSettled` = a stable, effect-settled picture (fixes the
mid-action-re-render staleness class); `scoreSelectors` reads the same delta to hand back a durable handle
for anything in the map. That composition — *see what changed, know when it's ready, get a durable handle* —
is the "better/smoother/richer test authoring" the charter asked for, expressed as what Playwright lacks.

---

## 4. The honest do-NOT list (the anti-reskin firewall)

Directly from the blocks' differentiation checks — violating these turns the work into "Playwright rebranded":

- **Do NOT ship generic multi-signal "is the page ready" quiescence.** Waitless/Applitools/Testing-Library
  already ship it; un-scoped, it's `networkidle` rebranded. Only the **action-scoped, noise-excluding** variant is defensible.
- **Do NOT reimplement `waitForSelector` / `networkidle` / `expect`-polling.** Playwright owns these (and lints teams off `networkidle`). Compose *with* them; the network-idle gate is an opt-in accelerator, never the primary signal.
- **Do NOT lead the page model with role+name+hierarchy.** That IS the ARIA snapshot → reskin → discard. Lead with occlusion + actionability + recency; borrow semantics from Playwright.
- **Do NOT build a general self-healing-locator engine.** Testim/mabl/Katalon/Reflect are years ahead; AI agents solve churn differently. DW would be a worse me-too.
- **Do NOT chase a pixels-only / vision page model.** Computer-use agents own pixels; DW's edge is *structured, deterministic* geometry.
- **Do NOT sell `suggest()` as a test generator.** It degrades to `page.locator('div')` on the dominant node shape. Fix it as an R3/R2 byproduct (name from the salient text descendant + geometry); don't headline it.
- **Do NOT reimplement Playwright actionability** (the "stable for 2 frames" pre-action check). R1 is *post-action effect* settle — a different phase; Playwright's verdict stays authoritative (DW-02).

---

## 5. Recommended build sequence

1. **R2 first — `pageMap`** (the substrate + the flagship). Extend the injected observer with a bounded
   `scan(scope)` over salient nodes (interactive + recently-changed + landmarks) reusing the existing
   per-node geometry/occlusion/actionability read; add `renderPageMap()`. ~all hard parts already built +
   live-validated; the new surface is coverage + a serializer.
2. **R1 next — `observeEffectSettled`** (the differentiated capability, built on R2's region machinery).
   Region-scope the existing `waitForSettle` timer; add a first-effect edge + signal fusion + optional LoAF.
   ~80% re-wiring of existing observer/geometry/screenshot-diff/animation code.
3. **R3 as a byproduct — `scoreSelectors`** on top of `verifySuggestions`. Pure post-processing + one
   geometry-relative synthesis; lowest priority, highest honesty-risk (label durability an estimate).

**Validate each in the synthetic lab (`dw-testgen-lab`) before claiming a win**, with adversarial fixtures:
R1 — a no-network client re-render (beats `networkidle`) + a background-ticker + a real effect (beats global
quiescence) + a no-effect action (honest `effectAppeared:false`); R2 — an overlay occluding a look-alike
control (map names the covered one) on a poor-a11y/div-soup fixture; R3 — a generated-id/unstable DOM (score
flags it brittle, offers a flagged geometry-relative handle) vs codegen's confident `nth-child`.

---

## 6. Open questions for the fresh deep-think session

- **R1 causal attribution is co-occurrence, not proof** — "first non-background mutation = the effect" is a
  heuristic. Is anchoring at the latched trusted-event target + baseline-footprint subtraction enough, or is
  a stronger causal link needed? (Honesty: label the region `suspected-effect`, never `caused-by`.)
- **R1 residual GWT risk:** churn *co-located inside* the effect region still defeats region-scoping →
  degrades to `hitMaxWait`. Is that honest-inconclusive behavior acceptable, or worth a second mechanism?
- **R2 occlusion is a center-point hit-test** — misses partial overlap. Sample more points, or label scope
  honestly and stop there?
- **Interop:** should `pageMap` refs interoperate with Playwright's `aria-ref` (`[ref=eN]`) so DW slots into
  the Playwright-MCP agent workflow rather than competing with it? (Likely yes — biggest distribution lever.)
- **Packaging (E1/#B/#C in `00-FINDINGS-BACKLOG.md`):** the ESM-only friction (`ERR_PACKAGE_PATH_NOT_EXPORTED`)
  will block adoption of ALL of the above — fix it alongside, not after.

---

## 7. Bottom line

**Build the action-scoped page model (`pageMap`, R2) as the flagship, with the action-scoped effect-settle
(`observeEffectSettled`, R1) as its readiness half, and durable-selector scoring (`scoreSelectors`, R3) as a
byproduct — one primitive family on DW's existing delta+geometry+observer engine, aimed at legacy/poor-a11y/
heavy-RPC apps where the a11y tree degrades and `networkidle` never fires.** That is the single defensible,
un-owned, already-half-built thing DW can be that Playwright is not: *a structured, deterministic model of
what changed because of the action you just took — where it is, whether you can act on it, and when it's
ready — on exactly the apps everyone else struggles with.* This turns DW from a narrow diagnosis tool into a
categorical authoring enhancer, without copying a single Playwright method.
