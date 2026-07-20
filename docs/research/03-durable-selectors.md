# R3 — Durable / Unique Selector Intelligence

**Research area:** generate selectors from the LIVE page that are (1) verified **unique** on the current
page, (2) scored for **durability** across re-renders, and (3) honestly **flagged** when brittle — with a
special eye to **legacy apps** (GWT / JSF / ExtJS-style) that have auto-generated, unstable `id`s and poor
accessibility, where role + accessible-name alone are insufficient.

**Status:** research + design. DW already ships a *seed* of this — `verifySuggestions` (single-page
uniqueness + same-element identity + honest warnings). This report surveys the prior art, defines the
scoring algorithm that turns that seed into a **durability recommender**, and does an honest check of
whether that is genuinely beyond Robula+, Healenium, and Playwright codegen — or reinventing them.

**Hard constraint (restated):** *do not just wrap Playwright's selector engine and call it DW.* The thing
that must be net-new is **verified uniqueness + a transparent durability score + honest brittleness flags**,
plus a **delta-anchored geometry-relative fallback** for the legacy case where nothing semantic resolves.

---

## 1. Prior-art survey

The problem — "given a target element, produce a locator that keeps resolving to the *right* element after
the page evolves" — has ~15 years of literature. It splits into two families that are often conflated:

- **Authoring-time locator *generation*** (Robula+, codegen): from a *single* page state, emit one good
  locator. No knowledge of the future.
- **Runtime *relocalization* / self-healing** (Similo, Healenium, Testim/mabl/Functionize): given a
  *stored fingerprint* from a prior run and a *changed* current page, find the element again and swap the
  locator. Needs a baseline (a previous release) to heal against.

DW's R3 lives in the **authoring-time generation** family (one live page, no prior release), but should
*borrow the stability models* the healing family invented. Keeping that split straight is the whole
differentiation argument in §4.

### 1.1 Robust XPath generation — ROBULA / Robula+ (Leotta, Stocco, Ricca, Tonella)

Robula+ is the canonical "generate one robust locator from one page" algorithm. It starts from the most
general XPath (`//*`) and **greedily specializes** it until it matches the target *uniquely*, choosing at
each step the specialization heuristically most likely to survive page evolution. The transformation set:

- `transfConvertStar` — replace a `*` step with the element's concrete tag name.
- `transfAddId`, `transfAddText`, `transfAddAttribute`, `transfAddPosition` — add a predicate constraining
  by `id`, text, an attribute/value pair, or the element's positional index among siblings.
- `transfAddAttributeSet` — add predicates drawn from the *powerset* of the element's attributes.
- `transfAddLevel` — prepend a new `*` step (climb one ancestor level).

Robula+ improves on the original ROBULA with three heuristics that matter directly to DW's scorer: (a) an
**attribute-priority** ranking that prefers attributes empirically shown to be stable across releases; (b)
an **attribute blacklist** that excludes intrinsically fragile attributes; and (c) using **text** as an
anchor when it is a reliable signal. Reported robustness: XPath locators from Robula+ reduced locator
fragility by **~90% vs absolute XPath** and **~63% vs Selenium IDE** locators.
- Paper (JSEP 2016): https://onlinelibrary.wiley.com/doi/10.1002/smr.1771 · PDF:
  https://tsigalko18.github.io/assets/pdf/2016-Leotta-JSEP.pdf
- Project page + earlier ROBULA: https://sepl.dibris.unige.it/ROBULA.php
- Reference implementation (browser, TS): https://github.com/cyluxx/robula-plus

**Take-away for DW:** Robula+'s *attribute-robustness ranking + blacklist + positional penalty* is exactly
the missing **durability score** for DW's structural (css/xpath) fallback tier. But Robula+ is
**XPath-only** — no role / accessible-name tier, no geometry — and emits a *single* locator with **no score
and no brittleness signal** exposed to the author. It also verifies uniqueness only on the *current* page
(same limit DW has), and its "robustness" is validated *post-hoc against a second release*, not predicted
at author time.

### 1.2 Similarity-based relocalization — Similo / VON Similo / VON Similo LLM (Nass, Alégroth, Feldt)

Similo reframes locators as a **multi-parameter fingerprint** and heals by **weighted similarity**, not by
one selector. It records **14 locator parameters** per element — tag, id, name, class, visible text, href,
alt, absolute XPath, id-relative XPath, `isButton`, location (x,y), area (w×h), shape (w/h), and
**neighbor texts** — and, on a changed page, scores every candidate element by a weighted sum of
per-parameter comparisons (equality for tag/id/name/isButton; normalized Levenshtein for text-ish
params; Euclidean for area/shape; word-overlap for neighbor texts). Weights are a deliberately-simple
**two-tier stability model**: **1.5** for parameters that stay stable across releases (tag, id, name,
visible text, neighbor texts) and **0.5** for the volatile rest (href, alt, XPath variants, isButton,
location, area, shape). The highest-scoring candidate wins; it can also return a *ranked list*.

Reported robustness (598 elements / 40 sites): Similo failed on **12%** vs the best single-locator
Robula+ at **35%** and absolute XPath at **79%** — i.e. a large edge from *combining many weak signals*.
- Similo (arXiv): https://arxiv.org/abs/2208.00677 · TOSEM 2023: https://dl.acm.org/doi/10.1145/3571855

**VON Similo** ("Visually Overlapping Nodes") adds the insight most relevant to DW's geometry: a single
*visual* element is often *many* overlapping DOM nodes; if you treat **any** node in the visual stack as a
valid match, robustness rises because only a subset of the stack has to survive a change.
- VON Similo (arXiv): https://arxiv.org/abs/2301.03863

**VON Similo LLM** (Nass 2024) puts an LLM on top to pick among the **top-10** ranked candidates,
reducing failures from 70→40 over 804 element pairs on 48 apps (~43% fewer) — at GPT-4 cost/latency.
- arXiv: https://arxiv.org/abs/2310.02046 · Wiley STVR 2024:
  https://onlinelibrary.wiley.com/doi/10.1002/stvr.1893
- 2025 comparative extension across Robula+/Similo/VON variants:
  https://arxiv.org/html/2505.16424

**Take-away for DW:** Similo's **weighted, multi-signal stability model** is directly reusable as DW's
**durability scoring function**, and VON Similo's overlap-redundancy insight maps onto DW's `coveredBy` /
z-order geometry. *But* Similo is a **runtime healer**: it needs a stored fingerprint from a **previous
release** to compare against. DW's R3 has only *one* live page and must *emit a locator now* — a different
problem. The models transfer; the mechanism does not compete.

### 1.3 Self-healing at runtime — Healenium and the commercial tools

**Healenium** (open source, Selenium/Appium) heals *at execution time*: when a locator throws
`NoSuchElement`, it runs a **modified weighted Longest-Common-Subsequence tree comparison** between the
stored DOM path of the last-good element and the current DOM, scores candidate subsequences (weighting
tag/id/class/value/other attributes), picks the best, generates a **new CSS locator**, acts, and **persists
the healed locator** (PostgreSQL backend keyed on DOM page + method/class) as the next baseline.
- How it works: https://healenium.io/docs/how_healenium_works · repo:
  https://github.com/healenium/healenium-web
- Overview: https://medium.com/geekculture/healenium-self-healing-library-for-selenium-test-automation-26c2358629c5

**Commercial** self-healing generalizes this to ML over many attributes: **Testim** scores element
attributes (text, position, class, id, structure) with a model that adapts to test history; **mabl**
captures 35+ element attributes plus visual context and DOM position; **Functionize** blends
locator-weighting with computer vision / NLP to survive full DOM rewrites and canvas UIs.
- mabl: https://www.mabl.com/auto-healing-tests · survey:
  https://getautonoma.com/blog/ai-self-healing-test-automation ·
  https://www.shiplight.ai/blog/best-self-healing-test-automation-tools

**Take-away for DW:** all of these are **runtime, baseline-dependent** healers — they *repair* an existing
test when it breaks. They **presuppose** a locator already exists and a prior-good fingerprint is stored.
DW R3 is upstream: *produce* the durable locator (and, optionally, the multi-signal fingerprint a future
healer would need). Complementary, not competitive.

### 1.4 Geometry-relative locators — Selenium 4 "relative/friendly" locators

Selenium 4 added `above()/below()/toLeftOf()/toRightOf()/near()` (default 50px radius), computed from
`getBoundingClientRect()` — locate an element by its spatial relation to a known anchor. Universally
documented as **fragile**: they break on layout shift, responsive re-flow, and overlap, and `near()`
returns the *first* DOM match satisfying the geometric predicate, so ambiguity is common. Best-practice
guidance: anchor on a *stable* element, take the *smallest* geometric hop, and fall back to CSS/XPath the
moment it turns flaky.
- BrowserStack: https://www.browserstack.com/guide/relative-locators-in-selenium ·
  Angie Jones: https://angiejones.tech/selenium-4-relative-locators/

**Take-away for DW:** this is the model for DW's **last-resort geometry tier** — but Selenium's version is
"blind" (no notion of which element the user *acted on*, no occlusion check). DW has the **delta** (it
*knows* the changed target) and full geometry (`rect`, `coveredBy`, `offscreen`, hit-test), so it can pick
a **verified-unique, non-occluded anchor** and emit a *flagged* relative locator only when semantics fail.

### 1.5 Playwright codegen / `getByRole` philosophy + the internal selector generator

Playwright's authoring guidance is DW's baseline to beat. Codegen and the docs prioritize **user-facing,
accessibility-first** locators: `getByRole` first (≈95% of cases), then text/label, then `data-testid`,
then CSS/XPath as a last resort; the philosophy is to decouple tests from DOM structure so refactors don't
break them.
- Locators + priority: https://playwright.dev/docs/locators · Best practices:
  https://playwright.dev/docs/best-practices · Codegen: https://playwright.dev/docs/codegen

The internal generator (`packages/injected/src/selectorGenerator.ts`) already does **uniqueness-driven
scoring** — lower score is better:
`kTestIdScore=1` ≪ `kRoleWithNameScore=100` < `kPlaceholderScore=120` < `kLabelScore=140` <
`kAltTextScore=160` < `kTextScore=180` < `kTitleScore=200` < `kCSSIdScore=500` ≪ `kNthScore=10000` ≪
`kCSSFallbackScore=1e7`, with an exact-match penalty and a length penalty, it **rejects** selectors
matching 6+ elements, and it **improves** a non-unique candidate until it uniquely identifies the target.
- Generator source: https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts
- Extracted as a standalone lib (evidence the heuristics are portable):
  https://github.com/kolodny/playwright-injected

**This is the crux of the hard constraint.** Codegen *already* emits role/text/testid/css **and** enforces
uniqueness. So "propose a unique role/text selector" is **not** differentiated — it *is* codegen. What
codegen does **not** do:
1. Expose a **durability score** or **brittleness flags** — it silently picks one selector and hides the
   trade-off (a confident `nth-child` on a legacy page reads exactly like a durable `getByRole`).
2. Offer any **geometry-relative** fallback.
3. Use an **action delta** — codegen keys off *click coordinates* at record time, not a semantic diff of
   what actually changed; DW knows the *effect* of the action, not just where the mouse went.
4. Apply a **Robula+/Similo-style attribute-stability model** to the structural fallback — codegen's CSS
   fallback is length/uniqueness-scored, not *stability*-scored, so on unstable-id apps it still emits
   volatile ids or `nth-child`.

Note a DW *disadvantage* to be honest about: codegen's `getByRole` uses Playwright's **real ARIA
accessible-name/role algorithm**, whereas DW's observer role/name are **heuristic reads** (implicit-role
map + `aria-label→placeholder→text`). DW must *verify* its role candidates against the live page (it does)
and must not present a heuristic role read as authoritative.

### 1.6 How the research *measures* durability (so DW can score honestly)

The fragility literature measures robustness **against real release pairs**, which is the honesty anchor
DW must respect:
- **Retention across versions:** take an old page + a new page of the same app, and count how many
  generated locators still resolve to the correct element on the new version (Robula+, Similo evaluations).
- **GUI-change taxonomies / benchmarks:** classify layout/DOM change *types* and measure robustness per
  change class rather than in aggregate.
  https://www.sciencedirect.com/science/article/pii/S0164121223003278
- **Reproducible break datasets:** curated real locator breaks for benchmarking (ReproBreak).
  https://arxiv.org/pdf/2605.12158
- **Fragility prediction:** learn to predict which locators/tests are fragile *before* they break.
  https://dl.acm.org/doi/10.1145/3661167.3661179 ("Towards Predicting Fragility in End-to-End Web Tests")
- **UI-flaky-test analyses:** empirical breakdowns of what makes UI tests flaky (selectors are a top
  cause). https://arxiv.org/pdf/2103.02669

**Hard implication for DW's honesty rule:** true cross-render/cross-release durability is only *verifiable*
with **two** page states. DW sees **one**. Therefore DW's "durability score" is an **estimate/proxy**
(attribute-stability + uniqueness + semantics), and DW must label it as such — never claim "stable across
releases," only "verified unique now + estimated durable." This is consistent with the existing
`verifySuggestions` scope note, which already refuses to claim cross-render stability.

### 1.7 The legacy pain point (GWT / JSF / ExtJS-style)

DW's differentiator lives where everyone else degrades: frameworks that emit **auto-generated, per-render
`id`s** (e.g. ExtJS `textfield-1012-inputEl`, `button-1016-btnInnerEl`; GWT `gwt-uid-N`; hashed
CSS-module class names) and thin/absent ARIA. Here `getByRole`/`getByTestId` frequently have nothing to
grab, and both codegen and Robula+ collapse to volatile ids or positional `nth-child`/XPath.
- ExtJS locator pain: https://yizeng.me/2017/01/15/tips-for-locating-elements-in-ext-js-applications-with-selenium-webdriver/ ·
  https://croz.net/extjs-testing/

This is precisely the regime where a **durability score that penalizes generated ids**, a **text/label
tier**, and a **delta-anchored geometry-relative fallback** — all with **honest brittleness flags** — beat
a confidently-wrong `nth-child`.

---

## 2. Candidate algorithms

Four buildable options, ordered by how much they respect the hard constraint.

**A. Uniqueness-only (status quo `verifySuggestions`).** Round each `suggest()` candidate through the live
page: `count()` for uniqueness + `.and([data-dw-ref])` for same-element identity; promote a verified-unique
candidate to `bestVerified`. *Verdict:* good and already shipped, but by itself it is ~codegen's uniqueness
step with honest statuses bolted on. Necessary substrate, **not** sufficient differentiation.

**B. Tiered durability scorer (recommended core).** Keep tiers but replace the ordinal tier rank with a
**numeric durability score** that fuses: tier base + attribute-stability (Robula+ blacklist / Similo
two-tier weights) + verified uniqueness + heuristic-role discount + text-volatility penalty + structural
penalty (depth / nth-child / positional). Output a 0–100 score, a grade (`durable`/`usable`/`brittle`),
and explicit flags. *Verdict:* this is the missing layer; cheap; reuses existing verification round-trips.

**C. Delta-anchored geometry-relative tier (recommended add-on for legacy).** When no attribute/role/text
candidate verifies unique, synthesize a **relative** locator (`near`/`left-of`/`above` a *verified-unique,
non-occluded* anchor) from the delta's `rect` + `coveredBy` + hit-test. Emit it **only** as a
last-resort, always heavily flagged `geometry-relative`. *Verdict:* DW-native (delta + geometry), fills the
gap Selenium's blind relative locators and codegen both leave. Must never be the default.

**D. Multi-signal fingerprint export (optional, out of R3 scope).** Emit a Similo-style fingerprint
(role, name, text, neighbor-texts, rect, stable attrs) so a *downstream* healer can relocalize later.
*Verdict:* valuable but it is the *healing* problem (§1.2–1.3); note it, don't build it here.

**Recommendation:** **B + C on top of A**, borrowing Robula+'s attribute model and Similo's weighting.
Explicitly *not* re-implementing runtime healing (Similo/Healenium) or codegen's engine.

---

## 3. How DW's geometry + delta + `verifySuggestions` enable this

DW holds three signals no authoring-time competitor has together on a single live page:

1. **The action delta (`actAndObserve`).** DW knows the *exact set of nodes that changed as a result of the
   action* — including `kind` (added / attr / text), `parentRef` nesting, and sibling changes. So DW does
   **not** have to *guess* the target among the whole DOM the way codegen (click coordinates) or a healer
   (fuzzy match) must. It can anchor selector generation on the *causally-relevant* node and use *sibling*
   changed nodes to disambiguate — a strictly stronger starting point.

2. **Geometry (`GeometryRead`).** Each node carries `rect`, `inViewport`/`offscreen`, `coveredBy`
   (the covering element label when the center hit-test isn't the node itself), `hitSelf`, and
   display/visibility/opacity. This enables: (a) the **geometry-relative tier** (algorithm C); (b)
   **occlusion-aware anchor selection** — never anchor "near X" on an X that is itself covered/offscreen;
   (c) a **VON-Similo-style** move — when several *overlapping* nodes changed, prefer the one in the visual
   stack that has a durable, verified selector.

3. **Actionability verdict** (Playwright-authoritative, already on the delta). DW can *prefer* a selector
   that resolves to an element Playwright confirms **actionable**, and can down-rank one resolving to an
   inert wrapper (`page.locator('div')` — the known `suggest()` container fallback).

4. **`verifySuggestions` as the uniqueness/identity oracle (already built).** It returns per-candidate
   `matches` (`count()`), `unique`, `verified` (unique **and** same element as the delta's `data-dw-ref`),
   and a `status` ∈ {verified, ambiguous, unique-elsewhere, unconfirmed, broken}, plus honest warnings and
   `bestVerified`. R3 extends this: instead of only **re-ranking** by status, compute the **durability
   score + flags**, and when nothing verifies, *synthesize* the geometry-relative candidate and verify
   *that*. The bounded-concurrency `count()` fan-out is already in place, so scoring adds no new round-trip
   model — just more math per candidate.

The honest limit is already encoded in `verify-suggest.ts`: "stability here is single-page uniqueness +
same-element identity; TRUE cross-render stability would need a stored selector history the codebase does
not have." R3 keeps that limit and adds an *estimated* durability score — clearly labeled as an estimate.

---

## 4. Honest differentiation check — beyond the prior art, or reinventing it?

| Capability | Robula+ | Similo/VON | Healenium/Testim/mabl | Playwright codegen | **DW R3 (proposed)** |
|---|---|---|---|---|---|
| Works from **one** live page (no prior release) | yes | **no** (needs baseline) | **no** (needs baseline) | yes | **yes** |
| Emits **role / accessible-name** tier | no (XPath only) | partial (params) | attributes | **yes (real ARIA)** | yes (heuristic, *verified*) |
| **Verified unique** on current page | current-page | n/a (ranked) | runtime pick | **yes** | **yes (+ identity vs delta ref)** |
| **Durability *score*** exposed | internal rank | similarity score (heal) | ML confidence (heal) | internal, hidden | **yes, transparent 0–100 + grade** |
| **Honest brittleness flags** to the author | no | no | no | **no** | **yes (unstable-id, positional, text-volatile, geometry-relative, heuristic-role, occluded…)** |
| **Attribute-stability model** (blacklist generated ids) | **yes** | **yes (weights)** | yes | no (length/uniqueness only) | **yes (adopt Robula+/Similo)** |
| **Geometry-relative** fallback | no | uses coords as weak param | visual (some) | no | **yes, delta-anchored + occlusion-checked, flagged** |
| Uses the **action delta** (causal target) | no | no | no | no (click coords) | **yes** |
| Runtime **self-healing** | no | **yes** | **yes** | no | **no** (optionally export fingerprint) |

**Where DW is genuinely reinventing (must not claim novelty):**
- **Uniqueness verification of a role/text selector = codegen.** Playwright's generator already emits
  role/text/testid/css *and* forces uniqueness (rejects 6+ matches). `verifySuggestions` re-derives the
  uniqueness check. Keep it (DW needs it as substrate and adds *identity-vs-delta-ref*, which codegen
  lacks), but do **not** market "unique selectors" as the innovation — that violates the hard constraint.
- **Runtime healing = Healenium/Similo/commercial.** DW should not build a baseline-diff healer.

**Where DW is genuinely additive (the defensible niche):**
1. **Transparency over a chosen selector.** Every other generator picks one locator and *hides* the
   trade-off. DW's brand is honesty (observe/label, flag brittleness). A **numeric durability score +
   explicit flags across the candidate set** is net-new *packaging* of otherwise-known signals — and it is
   exactly what an LLM test-author (or a human) needs to decide "ship this / hand-verify / this page has no
   durable handle." Codegen's silent `nth-child` is the anti-pattern DW exists to fix.
2. **Delta-anchored generation.** Keying off the *causal change set* rather than click coordinates or a
   fuzzy baseline is a starting-point advantage no competitor has at authoring time.
3. **Geometry-relative, occlusion-aware, verified-anchor fallback** for the legacy poor-a11y case — beyond
   Selenium's blind relative locators (no delta, no occlusion, no uniqueness guarantee) and beyond codegen
   (no geometry tier at all).
4. **Attribute-stability scoring on the structural fallback** — adopting Robula+/Similo's stability model
   for the tier codegen scores only by length/uniqueness. This is *reuse of known models*, honestly cited,
   applied where codegen is weakest.

**Verdict:** the *uniqueness* half is codegen and must be treated as commodity substrate. The **score +
flags + delta/geometry-anchored fallback for unstable-id / poor-a11y apps**, applied at *authoring time on
one live page*, is a real gap none of Robula+, Similo/Healenium, or codegen fills. DW is differentiated
**iff** it ships the score + flags + geometry tier — not if it stops at "verified unique."

---

## 5. Feasibility + risks

**Feasible now (low cost):**
- The verification substrate (`verifySuggestions`) exists, with bounded-concurrency `count()` fan-out. The
  scorer is *pure post-processing* of signals already gathered — near-zero added latency.
- Attribute-stability heuristics (regex for generated-id shapes, blacklist, positional penalty) are
  well-specified by Robula+/Similo and small to implement.
- Geometry is already on every node; the relative tier is arithmetic over `rect` + a `coveredBy`/`offscreen`
  gate + one more `count()` to verify the synthesized locator.

**Risks / honest limits:**

1. **Single-page durability is an *estimate*, not a proof (core risk).** DW cannot *verify* cross-render
   stability from one page — only the fragility literature's two-release retention test can. Mitigation:
   label the number **"estimated durability,"** never "stable across releases"; keep the existing
   `verifySuggestions` scope caveat prominent; consider an *opt-in* two-snapshot mode (score, act again,
   re-check the same selectors) that *upgrades* an estimate to a *measured* retention signal — the only
   honest path to a real durability number, and a natural DW extension since it already re-observes.

2. **Heuristic role/name ≠ Playwright's ARIA (accuracy risk).** DW's observer role/name can diverge from
   `getByRole`'s real algorithm, producing a role candidate that resolves elsewhere or nowhere. Mitigation:
   already *verified* via `count()` + identity; additionally **discount** the role tier's score until it
   verifies, and optionally reconcile against Playwright's `locator.ariaSnapshot()` / accessibility tree to
   drop the discount when they agree.

3. **Legacy unstable-id / poor-a11y apps (the target case) may have *no* durable handle.** If ids are
   generated, ARIA is thin, and text is dynamic/localized, *every* tier may score `brittle`. This is not a
   failure — the **honest** output is "no durable selector; best available is `geometry-relative near
   <anchor>`, flagged brittle," which beats codegen's confident `nth-child`. The risk is a *user* who wants
   a green checkmark anyway; the mitigation is to make the grade and flags loud and refuse to launder a
   brittle locator as durable (mirrors `bestVerified === null` → warn).

4. **Geometry-relative fragility (the fallback's own risk).** Relative locators break on reflow/responsive
   layout. Mitigation: only when semantics fail; anchor on a **verified-unique, non-occluded, in-viewport**
   element; smallest hop; always tagged `geometry-relative` + lowest score; never auto-promoted to
   `bestDurable`.

5. **Text volatility false-negatives.** Penalizing numeric/dynamic text is heuristic; a legitimately-stable
   label containing a number could be under-scored. Mitigation: penalty, not exclusion; expose the flag so
   the author overrides.

6. **DOM size / performance on legacy pages.** Robula+-style XPath synthesis can be slow on deep legacy
   DOMs. Mitigation: keep XPath synthesis last-resort and *budgeted*; prefer scoring the candidates
   `suggest()` already produced over generating new long paths.

7. **Scope creep into self-healing.** Tempting to add a baseline-diff healer. Keep it out of R3 (it's the
   Similo/Healenium problem); at most emit the multi-signal fingerprint (algorithm D) for a downstream
   healer.

---

## 6. Recommended direction + minimal prototype sketch

**Direction:** build a **durability recommender** = **B (tiered durability scorer) + C (delta-anchored
geometry-relative tier)** layered **on top of the existing `verifySuggestions`**. Borrow Robula+'s
attribute blacklist + positional penalty and Similo's two-tier stability weights as the scoring function;
use DW's delta + geometry for the anchor tier and occlusion gating. **Do not** re-implement codegen's
engine or a runtime healer. **Never** claim cross-render stability from one page — the score is an
*estimate*, promotable to *measured* only via an opt-in two-snapshot re-check.

### 6.1 Durability tiers (best → worst) and base weights

| Tier | Example | Base | Rationale |
|---|---|---|---|
| `role+name` (verified) | `getByRole('button',{name:'Save'})` | 100 | user-facing + a11y; survives refactor (Playwright §1.5) |
| `stable-attr` | `[data-testid=…]`, semantic `name`, human `data-*` | 90 | explicit contract; but only if value is *not* generated |
| `label/placeholder` | `getByLabel('Email')` | 80 | user-facing, form-scoped |
| `text` (stable) | `getByText('Add to cart')` | 70 | reliable anchor unless dynamic/localized |
| `scored-structural` | Robula+-style short CSS/XPath | 40 | fragile; score by stability + depth |
| `geometry-relative` | `near('…')` anchored on verified element | 15 | last resort; layout-dependent |

### 6.2 Scoring function (pseudo-code)

```
score(candidate, node, delta, verifyResult) -> { durability: 0..100, grade, flags[] }

  base = TIER_BASE[candidate.tier]           // table 6.1
  flags = []

  // (1) Uniqueness / identity — from existing verifySuggestions
  switch (verifyResult.status) {
    case 'verified':          break                         // ideal
    case 'unconfirmed':       base *= 0.85                  // unique, identity unknown
    case 'ambiguous':         base *= 0.30; flags += 'ambiguous'        // matches > 1
    case 'unique-elsewhere':  base *= 0.10; flags += 'wrong-element'
    case 'broken':            return { durability: 0, grade: 'broken', flags: ['no-match'] }
  }

  // (2) Attribute stability — Robula+ blacklist + Similo two-tier weights
  if (candidate uses an attribute value) {
    if (isGeneratedId(value))       { base *= 0.25; flags += 'unstable-id' }   // \d{3,}, gwt-uid-N,
                                                                               // component-1012, _hash…
    else if (isVolatileAttr(attr))  { base *= 0.60; flags += 'volatile-attr' } // href/alt/style/…
    // human-authored testid / name / semantic data-* keep full weight
  }

  // (3) Heuristic-role discount — DW role/name are not Playwright's ARIA algorithm
  if (candidate.tier === 'role' && verifyResult.status !== 'verified') {
    base *= 0.7; flags += 'heuristic-role-unverified'
  }

  // (4) Text volatility
  if (candidate.tier === 'text' && isDynamicText(node.name)) {   // digits/date/currency/very-long
    base *= 0.5; flags += 'text-volatile'
  }

  // (5) Structural fragility (Robula+ idea) — only for scored-structural
  if (candidate.tier === 'scored-structural') {
    base -= 5 * depth(candidate)
    if (usesNthChild(candidate)) { base *= 0.4; flags += 'positional' }
  }

  // (6) Geometry / actionability gates (DW-native)
  if (node.geometry?.coveredBy)  flags += 'occluded'
  if (node.geometry?.offscreen)  flags += 'offscreen'
  if (candidate.tier === 'geometry-relative') flags += 'geometry-relative'
  if (node.actionability?.verdict !== 'ACTIONABLE') flags += 'not-actionable'

  durability = clamp(base, 0, 100)
  grade = durability >= 70 ? 'durable' : durability >= 40 ? 'usable' : 'brittle'
  return { durability, grade, flags }
```

`bestDurable` = highest-scoring candidate whose status is `verified` **and** grade ≠ `brittle`; if none,
`bestDurable = null` and a warning states the page offers no durable handle (mirrors today's
`bestVerified === null`). The geometry-relative tier is **synthesized only when** no semantic candidate is
`verified` — anchored on the nearest **verified-unique, non-occluded, in-viewport** element (ideally itself
`role+name`), then that synthesized locator is itself run through `verifySuggestions` for uniqueness.

### 6.3 API sketch (extends, does not replace, `verifySuggestions`)

```ts
export interface ScoredSelectorSuggestion extends VerifiedSelectorSuggestion {
  durability: number;            // 0..100 ESTIMATE (single-page proxy — never "stable across releases")
  grade: 'durable' | 'usable' | 'brittle' | 'broken';
  flags: string[];               // unstable-id · volatile-attr · positional · text-volatile ·
                                 // heuristic-role-unverified · ambiguous · geometry-relative ·
                                 // occluded · offscreen · not-actionable
}

export interface DurableSuggestResult {
  selectors: ScoredSelectorSuggestion[];      // re-ranked by (grade, durability, then tier)
  bestDurable: ScoredSelectorSuggestion | null; // verified + grade !== 'brittle', else null (+ warning)
  assertions: AssertionSuggestion[];          // re-pointed onto bestDurable per node, brittle ones dropped
  warnings: string[];                         // inherits verifySuggestions caveats + durability caveats
}

/** Score suggest()/verifySuggestions candidates for durability, synthesize a geometry-relative
 *  fallback when nothing semantic verifies, and honestly flag brittleness. Call right after
 *  actAndObserve (needs the delta's live data-dw-ref markers). Durability is an ESTIMATE. */
export async function scoreSelectors(
  root: Page | Frame,
  delta: Delta,
  opts?: { concurrency?: number; geometryFallback?: boolean /* default true */ },
): Promise<DurableSuggestResult>;

/** OPTIONAL honest upgrade: re-check the same selectors on a second observed state to turn the
 *  single-page ESTIMATE into a MEASURED retention signal (the only sound cross-render number). */
export async function measureRetention(
  root: Page | Frame,
  before: DurableSuggestResult,
  afterDelta: Delta,
): Promise<{ retained: ScoredSelectorSuggestion[]; broken: ScoredSelectorSuggestion[] }>;
```

**Build order:** (1) `scoreSelectors` = scorer over existing `verifySuggestions` output (algorithm B) —
biggest value, lowest cost; (2) generated-id / volatile-attr detectors + blacklist (Robula+/Similo);
(3) delta-anchored geometry-relative tier + occlusion gate (algorithm C); (4) optional `measureRetention`
two-snapshot mode for a *measured* (not estimated) durability signal; (5) *maybe* the fingerprint export
(algorithm D) for downstream healers — explicitly out of R3.

---

## Sources

- Robula+ (Leotta et al., JSEP 2016): https://onlinelibrary.wiley.com/doi/10.1002/smr.1771 ·
  https://tsigalko18.github.io/assets/pdf/2016-Leotta-JSEP.pdf ·
  https://sepl.dibris.unige.it/ROBULA.php · impl https://github.com/cyluxx/robula-plus
- Similo (Nass et al.): https://arxiv.org/abs/2208.00677 · https://dl.acm.org/doi/10.1145/3571855
- VON Similo (visual overlaps): https://arxiv.org/abs/2301.03863
- VON Similo LLM (Nass 2024): https://arxiv.org/abs/2310.02046 ·
  https://onlinelibrary.wiley.com/doi/10.1002/stvr.1893
- Web element relocalization comparative study (2025): https://arxiv.org/html/2505.16424
- Healenium: https://healenium.io/docs/how_healenium_works · https://github.com/healenium/healenium-web ·
  https://medium.com/geekculture/healenium-self-healing-library-for-selenium-test-automation-26c2358629c5
- Commercial self-healing (mabl/Testim/Functionize): https://www.mabl.com/auto-healing-tests ·
  https://getautonoma.com/blog/ai-self-healing-test-automation ·
  https://www.shiplight.ai/blog/best-self-healing-test-automation-tools
- Selenium 4 relative locators: https://www.browserstack.com/guide/relative-locators-in-selenium ·
  https://angiejones.tech/selenium-4-relative-locators/
- Playwright locators / best practices / codegen: https://playwright.dev/docs/locators ·
  https://playwright.dev/docs/best-practices · https://playwright.dev/docs/codegen
- Playwright selector generator internals:
  https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts ·
  standalone extraction https://github.com/kolodny/playwright-injected
- Fragility measurement / benchmarks: https://sciencedirect.com/science/article/pii/S0164121223003278
  (GUI-change classification) · https://dl.acm.org/doi/10.1145/3661167.3661179 (predicting fragility) ·
  https://arxiv.org/pdf/2605.12158 (ReproBreak) · https://arxiv.org/pdf/2103.02669 (UI-flaky tests)
- Legacy dynamic-id pain (ExtJS/GWT): https://yizeng.me/2017/01/15/tips-for-locating-elements-in-ext-js-applications-with-selenium-webdriver/ ·
  https://croz.net/extjs-testing/
