# Deltawright — Authoring-Enhancer Plan

**The single base plan for DW's next chapter**, derived from the enhancer research (`docs/research/` —
charter, 4 cited blocks, `META-SYNTHESIS.md`) and a week of dogfooding (`docs/research/00-FINDINGS-BACKLOG.md`).
Read this first next session: the direction is **decided**, not open — this plan says what to build, in what
order, and where to start. Do not re-litigate the direction; execute from it.

---

## 0. Goal (north star)

> **Turn Deltawright from a narrow diagnosis tool into a categorical Playwright *authoring enhancer* by
> shipping ACTION-GRANULARITY primitives — a structured, deterministic model of *what changed because of the
> action you just took*: where it is, whether you can act on it, and when it's ready — on exactly the
> legacy / poor-a11y / heavy-RPC apps where the accessibility tree degrades and `networkidle` never fires.**

This is the one thing Playwright is not, that no competitor ships, and that DW is already half-built to do.
It is achieved **without copying a single Playwright method**.

---

## 1. What the research decided (the base — compressed)

- **The un-owned territory is ACTION GRANULARITY.** Every incumbent works at whole-page or target-element
  granularity; none attributes a settle, a representation, or a change to *the specific action that caused
  it*. DW's `actAndObserve` (the action-scoped, geometry-annotated delta) is the asset no competitor has
  (Playwright-MCP re-mints refs to *prevent* diffing; AI agents re-serialize the whole page each step).
- **One engine, three surfaces** (all on the existing delta + geometry + observer + screenshot-diff):

  | Surface | Role | Rank |
  |---|---|---|
  | **`pageMap()`** — spatial+semantic "marked page map" | the *picture* (what's where, what covers what, what just changed) | **🥇 flagship** |
  | **`observeEffectSettled()`** — region-scoped causal effect-settle | the *readiness* (has this action's effect landed & gone still) | 🥈 capability |
  | **`scoreSelectors()`** — durability score + flags + geometry fallback | the *durable handle* (byproduct) | 🥉 byproduct |

- **They compose:** *see what changed → know when it's ready → get a durable handle.* That is "better,
  smoother, richer test authoring," expressed entirely as what Playwright lacks.
- **Sweet spot / wedge:** legacy/poor-a11y/heavy-RPC apps. There the a11y tree degrades (~19-pt agent-success
  drop; ~95.9% of pages have a11y conformance errors) and `networkidle` never settles — but geometry,
  hit-testing, and the delta never degrade. That asymmetry is the whole opportunity.

---

## 2. The build — phases, deliverables, reuse-vs-new

### Phase 1 — `pageMap` (flagship + substrate) — **START HERE**
A bounded, salient-node spatial map produced in one in-page pass. **Leads with** the fields nobody else
exposes — occlusion (`coveredBy` / apparent z-layer), actionability-reconciliation (geometry-vs-Playwright
disagreement), recency (added/removed/changed + where) — and **borrows** role/name from Playwright's ARIA
snapshot (never re-derives the a11y tree).
- **Deliverables:** `pageMap(page, opts)` host primitive + `renderPageMap()` serializer + a `scan(scope)`
  mode in the injected observer + a `PageMap`/`PageMapNode` schema (draft in `docs/research/02-spatial-page-model.md §6.2`).
- **Reuse (already built + live-validated):** per-node geometry read (`rect`, `elementFromPoint` occlusion,
  `hitSelf`, `offscreen`), `annotateActionability` reconciliation, the delta's `kind` for recency, `serialize.ts` patterns.
- **New (small):** the full-page salient-node scan (interactive + recently-changed + landmarks, **capped**),
  apparent-z-layer grouping from `coveredBy` chains, coarse zone tags, the serializer.
- **Validation (lab):** a fixture where an overlay occludes a look-alike control on a div-soup / poor-a11y
  page → the map must name the *covered* control as NOT-actionable with `covered-by <overlay>`, where an
  ARIA snapshot + `boundingBox` cannot.

### Phase 2 — `observeEffectSettled` (the differentiated capability)
The delta supplies the effect **region**; a region-scoped MutationObserver quiet-timer means background churn
*outside* the region can't reset the settle. Fuse structural-quiet + WAAPI animation-done + optional clipped
pixel-stability; LoAF / network-idle are **opt-in accelerators only**. Honest by construction: no `ready`
boolean; surface `hitMaxWait` / `suspectedEarly` / `effectAppeared:false`.
- **Deliverables:** `observeEffectSettled(page, action, opts)` (standalone `deltawright/wait` export) + an
  option on `actAndObserve` so the returned delta is already effect-settled (fixes the mid-action-re-render
  staleness class). API + algorithm in `docs/research/01-wait-free-readiness.md §6`.
- **Reuse:** `waitForSettle`, `sampleBaseline`/`bgInsert` background-footprint subtraction, `settleAnimations`
  (WAAPI), `enableQuiescence`/`isQuiescent` (opt-in net gate), gap-E late-watch, anchor latching, `diffChangedRegion`.
- **New:** region-intersection predicate on the quiet-timer, a first-effect edge, optional LoAF observer,
  optional region-clipped 2-consecutive-identical pixel check.
- **Validation (lab):** (a) no-network client re-render (settles *after* it where `networkidle` returns
  before); (b) background ticker + a delayed real effect (settles on the effect, not reset by the ticker,
  where global quiescence / whole-viewport visual settle over-wait to the cap); (c) canvas/no-DOM effect
  (pixel fallback localizes it); (d) no-effect action (honest `effectAppeared:false`, never a fake settle).

### Phase 3 — `scoreSelectors` (byproduct, lowest priority)
Durability score (0–100) + grade + brittleness flags over `verifySuggestions` output (Robula+ blacklist +
Similo two-tier weights), plus a delta-anchored, occlusion-checked geometry-relative fallback when nothing
semantic verifies. **Durability is an ESTIMATE** — never "stable across releases"; optional `measureRetention()`
two-snapshot mode upgrades the estimate to a measured number. API/algorithm in `docs/research/03-durable-selectors.md §6`.
- Also fixes the known `suggest()` container-fallback (I7 / #A): derive a name from the salient text descendant.

### Cross-cutting (do alongside, not after)
- **Fix ESM/CJS friction (#B4 / #C)** — `ERR_PACKAGE_PATH_NOT_EXPORTED` blocks adoption of *all* of the
  above. Add a CJS entry or a documented loader.
- **Packaging / DX (E1)** — the ergonomic wrappers (`dwFill`/`toHaveCommittedValue`/`dwClick`) become natural
  once `observeEffectSettled` + `pageMap` exist; ship them as the friendly surface over the primitives.

---

## 3. ▶ Where to start next session (the immediate goal)

**Design + prototype `pageMap` (Phase 1 MVP).** Concretely:
1. Finalize the `PageMap` / `PageMapNode` schema (start from `02-spatial-page-model.md §6.2`; decide precise-
   rect vs coarse-zone rendering; decide `aria-ref` interop — see §6 open questions).
2. Add a bounded `scan(scope)` to the injected observer that runs the existing per-node geometry+occlusion+
   actionability read over salient nodes (cap the set; set `capped`).
3. Implement `renderPageMap()` — occlusion/layer/actionability/recency lead, role/name annotate, honesty
   flags always shown.
4. Build the Phase-1 lab fixture (overlay occluding a look-alike control on a poor-a11y page) and prove the
   map names the covered control where an ARIA snapshot + `boundingBox` can't.
5. Only then move to Phase 2.

Keep everything **additive** (default paths byte-unchanged, full suite as regression guard) and **honest**
(observe/label, never fabricate; Playwright's verdict authoritative).

---

## 4. Success criteria

- **Per phase:** the adversarial lab fixture passes AND demonstrates a capability Playwright/competitors
  lack (occlusion-named actionability for Phase 1; effect-settle beating networkidle + global-quiescence for
  Phase 2; a flagged geometry handle beating codegen's confident `nth-child` for Phase 3).
- **Honesty gates** (add as accuracy floors): `observeEffectSettled` never emits `hitMaxWait:false` on a
  no-effect / background-churn-only case; `pageMap` never claims occlusion beyond what was hit-tested;
  `scoreSelectors` never labels a single-page estimate as cross-release stability.
- **North-star proof:** a short authoring demo where the three surfaces compose to write a test on a
  poor-a11y/heavy-RPC fixture more smoothly than vanilla Playwright — the "richer authoring" claim, shown.

---

## 5. Constraints — the anti-reskin firewall (non-negotiable)

- No generic "is the page ready" quiescence (Waitless/Applitools/Testing-Library own it → `networkidle`
  rebranded). Only the **action-scoped, noise-excluding** variant.
- No reimplementing `waitForSelector` / `networkidle` / `expect`-polling. Compose *with* them; net-idle is an
  opt-in accelerator, never primary.
- `pageMap` must **not** lead with role+name+hierarchy (= ARIA-snapshot reskin). Lead with occlusion +
  actionability + recency; borrow semantics from Playwright.
- No general self-healing-locator engine (Testim/mabl/Katalon/Reflect are years ahead).
- No pixels-only / vision page model (computer-use agents own pixels; DW's edge is structured determinism).
- Don't sell `suggest()`/`scoreSelectors` as a test generator.
- Don't reimplement Playwright actionability (the pre-action stable-for-2-frames check); DW's is *post-action*
  effect settle. Playwright's verdict stays authoritative (DW-02); never fabricate/retry/suppress (DW-03).

---

## 6. Open questions to resolve during design

- **Causal attribution honesty (Phase 2):** "first non-background mutation = the effect" is a heuristic —
  is anchor-latch + baseline-footprint subtraction enough? Label the region `suspected-effect`, never `caused-by`.
- **GWT residual (Phase 2):** churn co-located *inside* the effect region still degrades to `hitMaxWait` —
  accept honest-inconclusive, or add a second mechanism?
- **Occlusion fidelity (Phase 1):** center-point hit-test misses partial overlap — sample more points or
  label scope honestly?
- **`aria-ref` interop (Phase 1) — likely the biggest distribution lever:** should `pageMap` refs
  interoperate with Playwright's `[ref=eN]` so DW slots *into* the Playwright-MCP agent workflow rather than
  competing with it?
- **Naming/versioning:** is this the DW **v1.0** chapter? Decide before the first release.

---

## 7. Folded-in backlog (rides along — from `docs/research/00-FINDINGS-BACKLOG.md`)

- **Serves Phase 1:** I7/#A suggest()-on-containers; the geometry/covered-by strengths (F — keep).
- **Serves Phase 2:** E2 `dwWaitForVisible`; I3 backend-not-ready route (`hitMaxWait && !quiescent`); I1
  HTTP-200-body detection.
- **Serves Phase 3:** E3 durable selectors; the `verifySuggestions` seed.
- **Cross-cutting:** #B4/#C ESM fix; E1 `dwFill`/`toHaveCommittedValue`/`dwClick` wrappers.
- **Diagnosis-layer polish (DW's proven strength — keep, separate track):** B1 not-visible over-labeling, B2
  route window-scoping, I5 console-scan, I6 diagnose-trace waited-for-absent hint, B3 double-code dedup.
- **Deferred, separate:** healthy-environment value-run re-run (§G).

---

## 8. Pointers

- Research (the "why"): `docs/research/00-RESEARCH-CHARTER.md`, `01-wait-free-readiness.md`,
  `02-spatial-page-model.md`, `03-durable-selectors.md`, `04-competitive-gap.md`, `META-SYNTHESIS.md`.
- Findings/backlog: `docs/research/00-FINDINGS-BACKLOG.md`.
- Current code seeds: `src/injected/observer.ts` (scan/settle/baseline/animations), `src/host/actionability.ts`
  (geometry/`annotateActionability`), `src/host/screenshot-diff.ts` (`diffChangedRegion`),
  `src/host/actAndObserve.ts` (delta), `src/matchers/verify-suggest.ts` (`verifySuggestions`),
  `src/host/serialize.ts` (renderers), `src/wait/index.ts` (`observeConsequences` honesty contract).
- Memory: `deltawright-enhancer-research` (state + this plan's summary).
