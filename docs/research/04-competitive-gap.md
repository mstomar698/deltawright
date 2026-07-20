# R4 — Competitive landscape & the genuine unmet gap

**Research block 4 of the enhancer-research charter.** Adversarial survey of how existing tools solve the
three targets DW wants to own — (1) auto-waiting / **readiness**, (2) page understanding / **representation**,
(3) **selector** robustness — followed by a per-direction gap analysis (R1/R2/R3), DW's most defensible
differentiation, an honest "do not bother" list, and a single recommendation.

Method: five parallel web sweeps (one per angle: readiness in test frameworks, page representation, selector
self-healing, AI-agent internals, legacy-app pain), each returning falsifiable claims with primary-source
URLs; the load-bearing counter-claim (a shipping multi-signal readiness library, "Waitless") was
independently re-verified. Confidence is flagged where a claim rests on a single or vendor-grade source.

> **TL;DR.** All three targets have strong incumbents, but they split cleanly. **Readiness (R1)** and
> **representation (R2)** share one universal blind spot: every tool works at **whole-page** or
> **target-element** granularity — *none* attributes a settle signal, or a change, to **the specific action
> that caused it**. **Selectors (R3)** are the most crowded and the least defensible. DW's single unique
> asset is the **action-scoped, geometry-annotated delta** (`actAndObserve`) — the fusion of R2's
> representation with R1's scoping — which **no competitor ships**. The most defensible bet is **R2 (the
> spatial+semantic page model)**: it is the emptiest niche, it is already DW's proven strength, and it is the
> substrate R1 and R3 both depend on.

---

## 1. Per-tool survey

### 1a. Test frameworks

| Tool | Readiness / auto-wait | Page representation | Selectors | Key sources |
|---|---|---|---|---|
| **Playwright** | Actionability on the **target element only**: Visible, Stable (same bbox ≥2 animation frames — geometry only), Receives-Events (hit-test), Enabled, Editable; per-action subset (`fill` skips Stable+Receives-Events; `dispatchEvent` skips all). Web-first `expect` auto-retries ~100ms up to 5s, but only checks **the assertion the author wrote**. `networkidle` = "no connections 500ms", officially **DISCOURAGED**. | ARIA snapshot: YAML of the a11y tree (role, name, ARIA state, normalized text). **No geometry/occlusion/z-order/pixels.** `aria-ref` mode adds opaque `[ref=eN]` handles. | Strict single-locator (throws if >1 match), re-resolved each action; recommended order role→text→label→…→testId. **Not self-healing** — if the one query breaks, the test fails. Codegen emits one disambiguated selector, no fallbacks. | [actionability](https://playwright.dev/docs/actionability) · [class-Page](https://playwright.dev/docs/api/class-page) · [assertions](https://playwright.dev/docs/test-assertions) · [aria-snapshots](https://playwright.dev/docs/aria-snapshots) · [locators](https://playwright.dev/docs/locators) · [codegen](https://playwright.dev/docs/codegen) |
| **Cypress** | Retry-ability (default 4s); **only queries retry, `.click()` runs once**; retry is driven by the trailing assertion. 9-step actionability incl. "not animating" (position-slope heuristic) and "not covered" (center-point hit-test). `cy.wait(Number)` officially an **anti-pattern**; sanctioned effect-wait = `cy.wait('@alias')` on a **user-declared** route. | Live DOM via jQuery; no exported semantic/geometry model. | CSS/jQuery selectors; `data-cy` convention recommended. No self-healing. | [retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability) · [interacting-with-elements](https://docs.cypress.io/app/core-concepts/interacting-with-elements) · [best-practices](https://docs.cypress.io/app/core-concepts/best-practices) |
| **TestCafe** | Selectors + actions auto-wait for the target to appear/become visible (selector timeout). "Smart Assertion Query" re-evaluates the **assertion expression** until it passes — "does not wait for elements to appear, just repeats the evaluation." Waits for XHR/fetch up to a **global** `--ajax-request-timeout`; redirect wait 15s. | Selector-property model; no exposed geometry+semantic snapshot. | Chainable Selectors + property filters (`.withText`, `.nth`, `.parent`). No self-healing. | [built-in-wait-mechanisms](https://testcafe.io/documentation/402827/guides/advanced-guides/built-in-wait-mechanisms) |
| **Selenium / WebDriver** | **No auto-wait.** Implicit wait (default 0, presence only) vs explicit `WebDriverWait` poll (500ms) over `ExpectedConditions` the engineer picks; docs warn **against mixing** the two. WebDriver **BiDi** exposes raw `network.beforeRequestSent`/`responseCompleted` — "users must build their own" readiness. | None; raw DOM via locators. | ID→CSS→XPath best-practice; **relative locators** (`above/below/near`, 50px radius) built on bounding boxes, documented **layout-fragile**, no overlapping elements. Official best-practice page **does not address dynamic/auto-generated IDs at all**. No self-healing. | [waits](https://www.selenium.dev/documentation/webdriver/waits/) · [expected_conditions](https://www.selenium.dev/documentation/webdriver/support_features/expected_conditions/) · [bidi/network](https://www.selenium.dev/documentation/webdriver/bidi/network/) · [locators best-practice](https://www.selenium.dev/documentation/test_practices/encouraged/locators/) |

### 1b. Visual + AI/ML testing

| Tool | Readiness | Page representation | Selectors / self-healing | Sources |
|---|---|---|---|---|
| **Applitools** | Relies on the host framework's waits; visual-stability handling for animations/loading artifacts is a separate concern it explicitly builds noise-exclusion for. | **Pixels-first** Visual AI (perceptual diff beyond pixel-by-pixel); Ultrafast Grid re-renders a captured DOM+CSS snapshot as **images**; Root-Cause Analysis attributes a diff to DOM elements. **No exposed structured geometry/occlusion/z-order model.** | "Native/Self-healing selectors" fall back to **visual** matching (find what *looks like* Submit). Proprietary SaaS. | [eyes platform](https://applitools.com/platform/eyes/) · [visual testing](https://applitools.com/solutions/visual-testing/) · [animations](https://applitools.com/blog/handling-animations-and-loading-artifacts-in-visual-testing/) |
| **Testim** (Tricentis) | Host-framework waits. | — | **Smart Locators**: weighted multi-attribute model ("hundreds of attributes"), auto-improves a locator when its **score drops below ~70%**. Proprietary SaaS. *(number is vendor-doc; re-verify before external quoting)* | [locator technologies](https://www.tricentis.com/blog/testim-locator-technologies) |
| **mabl** | Auto-wait + auto-heal. | Stored per-element model (text, role, position, nearby labels, structural path). | Auto-heal to "best available match"; **confidence-gated** (fails rather than mis-heals); GenAI semantic heal only **after ≥5 passing runs**. Proprietary SaaS. | [how auto-heal works](https://help.mabl.com/hc/en-us/articles/19078583792404-How-auto-heal-works) |
| **Functionize** | — | Claims per-element "multi-dimensional fingerprint" (5 dims) + CV + NLP. | Self-heal via CV+NLP "even when the DOM changes completely"; "hundreds of thousands of data points", "decade of data." **Heaviest marketing, thinnest reproducible mechanism.** Proprietary SaaS. | [self-healing under the hood](https://www.functionize.com/blog/self-healing-tests-arent-magic-heres-whats-actually-happening-under-the-hood) |
| **Reflect** (SmartBear) | — | Captures **many** diverse selectors per action. | Optimistic syntactic selectors first; **OpenAI-backed semantic fallback** only when they go stale. Proprietary SaaS. | [element selection AI](https://reflect.run/articles/element-selection-ai/) |
| **Katalon** | Host waits. | — | **Self-Healing**: ordered, user-configurable fallback across XPath→Attributes→CSS→**Image**; healed locators need **human approval**. Most transparent/least-magical. Free tier; self-healing is Enterprise. | [self-healing docs](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio) · [blog](https://katalon.com/resources-center/blog/self-healing-object-locator) |

### 1c. AI browser agents / codegen

| Tool | Readiness | Page representation | Element selection | Delta after one action? | Sources |
|---|---|---|---|---|---|
| **browser-use** | Fixed sleeps + short poll: `min_wait` 0.25s + `network_idle` 0.5s + 0.5s between actions. | Injected `buildDomTree.js` → indexed interactive-element tree; **`paint_order` occlusion + DOMRect computed internally but STRIPPED before the LLM** (LLM sees index/tag/text/scroll only). | LLM emits `click(index=N)` → `selector_map[N]`. **Avoids authoring selectors.** | **No** — full DOM rebuild every step (~5-6s on Amazon home; open perf issue). | [all-parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters) · [dom serialization](https://deepwiki.com/browser-use/browser-use/5.2-dom-serialization) · [perf issue #627](https://github.com/browser-use/browser-use/issues/627) |
| **Skyvern** | Planner→Actor→**Validator** loop; validation = fresh LLM re-observation. | **Annotated screenshot + labeled interactive-element tree (with positions)** to a multimodal LLM. | `skyvern-id` → CSS selector; identity kept via content hash. **No pre-set XPaths** ("resistant to layout changes"). AGPL-3.0. | **Narrow exception** — `start_listen_dom_increment`/`get_incremental_element_tree` detect **new dropdown/autocomplete options** after one Click/Input; **not** a general per-step diff. | [how skyvern reads the web](https://www.skyvern.com/blog/how-skyvern-reads-and-understands-the-web/) · [handler.py](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/webeye/actions/handler.py) |
| **Stagehand** (Browserbase) | Inherits **Playwright auto-wait**. | **Chrome a11y tree** (DOM+a11y hybrid, ~80-90% payload reduction) — chosen because it "remains stable when visual layouts change" (i.e. **discards geometry**). | `observe()` returns concrete cacheable **XPath**; LLM picks at discovery, replay skips the LLM. **Self-heal = throw away cache, re-ask LLM** (opposite of a delta). MIT + cloud. | **No** — each `observe()`/`act()` re-derives the whole a11y tree. | [observe](https://docs.stagehand.dev/v3/basics/observe) · [caching](https://docs.stagehand.dev/v2/best-practices/caching) · [ai web agent sdk](https://www.browserbase.com/blog/ai-web-agent-sdk) |
| **Playwright-MCP** | Playwright auto-wait + timeouts. | **A11y snapshot** (YAML role/name + opaque `ref`), no-vision default; opt-in `--caps=vision` (pixel x,y). Opt-in `boxes` appends `[box=x,y,w,h]` — **bounding box only, no occlusion/z-order**. | Target by `ref` or CSS. | **No — starkest case**: returns a **fresh full snapshot after every action and re-mints refs**, structurally preventing cross-step diffing. | [README](https://github.com/microsoft/playwright-mcp) · [snapshots](https://playwright.dev/mcp/snapshots) · [vision-mode](https://playwright.dev/mcp/vision-mode) |
| **Selenium-IDE** | Explicit/implicit waits. | None (record-replay). | Records **fallback locators** (primary + secondaries, ordered, **no ML ranking**). OSS — the honest-but-weakest baseline. | No. | [locators](https://ui.vision/rpa/docs/selenium-ide/locators) |
| **Claude / OpenAI computer-use** | Model-driven; explicit `wait` action + app-side ~0.5s `sleep`; "Claude sometimes assumes outcomes without checking" → re-screenshot. | **Pure pixels + coordinates. No DOM / no a11y tree.** | `left_click [x,y]`. | **No** — re-screenshots the whole screen each turn (~2-5s/action); reliability degrades on dense/unfamiliar UI. | [Claude computer-use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool) · [OpenAI CUA](https://openai.com/index/computer-using-agent/) |

### 1d. The multi-signal-readiness incumbent (the R1 counter-claim, re-verified)

| Tool | What it is | How it works | The critical limit |
|---|---|---|---|
| **Waitless** | Released **OSS** library (PyPI, `pip install waitless`, v0.2.0), Selenium-oriented, one-line drop-in. | Injects a script fusing **four** signals: DOM-mutation settled (MutationObserver), network idle (patches fetch/XHR), animations/transitions finished, layout stable. | **Global, not action-scoped**: its own framing is *"Is the **entire page** stable and ready?"* — it monitors aggregate page state (total pending requests, last-mutation timestamp) and **does not compute a delta of what changed after a specific action.** Inherits the never-settle failure on perpetual-animation / polling apps. |

Source: [Waitless writeup](https://www.dhirajdas.dev/blog/waitless-eliminate-flaky-tests) (independently re-verified). Precedent that DOM-mutation readiness is adopted: [Testing Library `waitFor` is MutationObserver-driven](https://testing-library.com/docs/dom-testing-library/api-async/).

### 1e. Legacy-app evidence (why the sweet spot is real — and narrow)

- **`networkidle` is discouraged and provably hangs** on persistent connections (WebSockets/SSE/analytics/health-checks/long-poll): Playwright docs mark it DISCOURAGED ([class-Page](https://playwright.dev/docs/api/class-page)); lint rules ban it ([eslint no-networkidle](https://github.com/mskelton/eslint-plugin-playwright/blob/main/docs/rules/no-networkidle.md), [Biome](https://biomejs.dev/linter/rules/no-playwright-networkidle/)); open issues report indefinite hangs and ask for `networkidle1/2` thresholds ([#37080](https://github.com/microsoft/playwright/issues/37080), [#19835](https://github.com/microsoft/playwright/issues/19835)). GWT-RPC and JSF/PrimeFaces partial-submit behave exactly this way.
- **AX-tree / role-based models degrade on poor semantics.** GWT's own a11y guide: "Ajax applications like GWT are often written in ways that screen readers have difficulty interpreting" ([GWT a11y](https://www.gwtproject.org/doc/latest/DevGuideA11y.html)). Playwright `getByRole` can't find `<div>`-as-button with no role/name ([#20303](https://github.com/microsoft/playwright/issues/20303)). Quantified: WebVoyager text/AX-tree agent **40.1%** vs multimodal **59.1%** — stripping to the AX tree costs ~19 pts ([WebVoyager](https://www.emergentmind.com/topics/webvoyager)); agent success ~halves on inaccessible pages ([arXiv 2410.13825](https://arxiv.org/abs/2410.13825)). **Caveat: this cuts both ways** — the industry's answer to poor semantics is *vision*, so "avoid the AX tree" is not itself novel.
- **Stable selectors are absent-by-default.** GWT `gwt-uid-*` churn; stable `gwt-debug-*` IDs require `ensureDebugId` and are **stripped from production** ([GWT testing](https://www.gwtproject.org/articles/testing_methodologies_using_gwt.html)). JSF auto-prefixes `j_id*` ([CodeNotFound](https://codenotfound.com/jsf-primefaces-automated-unit-testing-selenium.html)); Vaadin generated IDs are unreliable ([TestBench](https://vaadin.com/docs/v8/testbench/creatingtests/testbench-selectors)). **No self-healing tool documents `gwt-uid-*`/`j_id*` by name** — coverage is generic ("dynamic IDs", "Salesforce Lightning"), and the fallback they name (data-test-id/role/text) is exactly what these DOMs lack.

---

## 2. Gap analysis per direction (already-solved vs open)

### R1 — Wait-free readiness — **REAL gap, but the primitive is being commoditized; DW's slice is *action-scoped* attribution**

**Already solved / crowded:**
- The *primitive* of multi-signal quiescence (DOM-mutation + network + animation + layout-shift) **ships today** in **Waitless** (OSS) and, partially, in Applitools' visual-stability layer and Testing-Library `waitFor`. **DW is not inventing "wait for the page to settle."**
- Playwright's official position (web-first `expect` auto-retry + a well-chosen effect assertion) already avoids `networkidle` for teams that adopt it well.

**Genuinely open (the defensible slice):**
- **No tool attributes settle to the specific action.** Every framework waits on the **target element's** actionability or a **user-authored** assertion/alias; `networkidle`/TestCafe-AJAX-wait/Waitless are all **whole-page** and cannot say "the DOM re-render + RPC round-trip *caused by this click* has stabilized while ambient polling keeps chattering." This action-scoped framing — tolerant of keepalive/analytics noise — is unoccupied.
- Playwright's only built-in "settle" (`Stable` = 2-frame same bbox) and Cypress's ("not animating" slope) are **geometry-only** and ignore subtree/text/content churn — the dominant change shape on RPC apps.

**Adversarial risk:** DOM-quiescence inherits `networkidle`'s never-settle failure on perpetual spinners/animations/poll widgets **unless** noise-exclusion is built in — and DW's `awaitQuiescence` is, per the internal findings backlog, *"unproven on GWT background churn."* Beating the incumbents here is an **execution** problem (robust ambient-noise exclusion + action attribution), not a discovery problem.

**Verdict: OPEN, contested. Real gap = action-scoped attribution, not multi-signal settle (already shipped by Waitless et al.).**

### R2 — Spatial + semantic page model — **the cleanest, emptiest gap**

**Already solved / crowded:** nothing directly. The landscape splits into two non-overlapping camps:
- **Pixels-only** (Claude/OpenAI computer-use, Playwright-MCP vision mode, Skyvern's screenshot half, Applitools) — the model *infers* geometry visually; no structured, queryable model; slow + nondeterministic.
- **Semantic-tree-only** (Playwright ARIA snapshot, Playwright-MCP default, Stagehand a11y tree) — role/name **with geometry deliberately discarded** ("remains stable when layouts change").

**Genuinely open:** **no mainstream tool exposes a combined structured model carrying role/name + per-element geometry + occlusion ("covered-by") + z-order that a human or agent can assert on.** Even the two tools that internally *know* occlusion keep it hidden — Playwright's `elementFromPoint` is a transient actionability boolean; **browser-use computes `paint_order`/DOMRect then strips them before the LLM sees them.** The single case of geometry reaching a decision-maker in structured form — Playwright-MCP's opt-in `boxes` — is a **bare bounding box with no occlusion and no z-order.** The richest raw substrate (CDP `DOMSnapshot` `includePaintOrder`+`includeDOMRects`) is a low-level protocol consumed internally, never surfaced as a semantic+spatial product.

**Why DW is uniquely placed:** DW **already ships this primitive** — `probeGeometry`/`geometryVerdict` (rect, `coveredBy`, `offscreen`, `hitSelf`, z-order) and the geometry-annotated `actAndObserve` delta. This is DW's **proven keep-strength** (covered-by-overlay precision, 0 hard false positives). And it directly serves the legacy sweet spot: where the AX tree degrades (poor semantics), a **deterministic geometry+text model** answers the same "poor-semantics" question that vision answers — but structured, fast, and reproducible.

**Verdict: OPEN and clean. This is the niche nobody occupies, and the one DW already owns.**

### R3 — Durable selector intelligence — **most crowded, DW currently weakest; a narrow legacy sub-gap remains**

**Already solved / crowded:**
- Playwright's strict single-locator (unique-at-action-time, re-resolved each action) is a solved baseline — though **not self-healing**.
- Mature self-healing exists: Testim (weighted ML, ~70% re-score), mabl (confidence-gated + GenAI-after-5-runs), Katalon (ordered fallback + image + human approval), Reflect (multi-selector + OpenAI fallback). **All are proprietary SaaS**; only Selenium-IDE is OSS and it's the weakest (unranked fallback list).
- **AI agents structurally sidestep churning IDs** by *re-deriving element identity every run* (browser-use index, Stagehand observe→XPath, Skyvern skyvern-id) — a `gwt-uid-*` that changes each build is simply irrelevant to them.

**Genuinely open (narrow):** **no tool documents opaque auto-generated IDs (`gwt-uid-*`, `j_id*`, hashed classes) by name**, and every DOM-attribute healer implicitly requires a *surviving* stable signal (text/role/testid/structural path) — which accessibility-poor legacy DOMs may lack. A library combining **structural + positional + visible-text anchoring** specifically for ID-churning, semantics-poor apps targets terrain incumbents cover only generically.

**Adversarial risk:** the incumbent fix on apps you control (add a `data-testid`; adopt `ensureDebugId`, `primefaces-selenium`, Vaadin TestBench) is **cheaper than any observer**. DW's own `suggest()` currently **degrades to `page.locator('div')`** on the common text-in-descendants node — DW is *weakest* here today. And AI re-derivation already neutralizes the churn problem for the agent use-case.

**Verdict: MOSTLY SOLVED. Only a narrow, hard, low-leverage legacy sub-gap remains — best pursued as a *byproduct* of R2 (geometry+text anchoring), not as a standalone flagship.**

---

## 3. DW's most defensible differentiation

Ranked by how empty the niche is × how much DW already owns it × execution feasibility:

1. **The action-scoped, geometry-annotated *delta* (`actAndObserve`).** This is the fusion of R2 (geometry+semantic representation) and R1 (action scoping), and it is the one thing **no competitor ships**. Every AI agent re-serializes the *whole* page each step (Playwright-MCP even re-mints refs to prevent diffing); Skyvern's only delta is a narrow dropdown detector. "What changed *because of this one action*, annotated with where it is and what covers it" is unoccupied space. **This is DW's flagship claim.**
2. **The structured occlusion / covered-by / z-order + role/name model (R2).** The emptiest single niche in the survey; DW's proven-precise strength; the substrate everything else is built on.
3. **Action-scoped settle tolerant of ambient RPC noise (R1's defensible slice).** Differentiated from Waitless/`networkidle`/TestCafe precisely by *attribution* — but an execution challenge (never-settle risk), and currently unproven on GWT churn.
4. **Honest diagnosis/triage on opaque legacy failures** (covered-by-overlay naming, backend-500 co-occurrence, input-not-committed, honest abstention). The proven, shipped strength — but this is a *diagnosis* product, adjacent to the *authoring-enhancer* question this research is scoping.

**The through-line that unifies 1–3:** every incumbent operates at **whole-page** or **target-element** granularity. DW's categorical difference is **action granularity** — settle, representation, and change all scoped to *the action that caused them*. That is the single sentence that is simultaneously true, defensible, and un-owned.

---

## 4. Where DW should NOT bother (honest list)

- **Do not build generic multi-signal "is the page ready" quiescence.** Waitless (OSS) + Applitools + Testing-Library already ship it. Re-shipping it un-scoped is "networkidle rebranded" — a charter violation. *Only* the action-scoped, noise-excluding variant is defensible.
- **Do not reimplement `waitForSelector`/`networkidle`/`expect`-polling.** Charter constraint; Playwright owns these and actively lints teams off `networkidle`.
- **Do not build a general self-healing-locator engine.** Testim/mabl/Katalon/Reflect are years ahead, and AI agents solve the churn a different way. DW would be a distant, worse me-too.
- **Do not chase a pixels-only / vision page model.** Computer-use agents own pixels; DW's edge is *structured* geometry, not perception. Competing on vision throws away DW's determinism advantage.
- **Do not lean on `getByRole`/AX-tree representation as the core.** On the exact legacy targets DW is for, that representation degrades (~19-pt WebVoyager drop) — leaning on it forfeits the differentiator.
- **Do not sell `suggest()` as a test generator.** It degrades to `page.locator('div')` on the dominant node shape; today it *underdelivers*. Fix it as a byproduct of R2 (derive a name from the salient text descendant + geometry), don't headline it.
- **Do not position DW as a general legacy-testing framework.** The framework-specific harnesses (`primefaces-selenium`, Vaadin TestBench) and app-side instrumentation (`ensureDebugId`, `data-testid`) already own the parts of that problem that are cheap to solve.

---

## 5. Recommendation — which direction has the biggest real gap

**Lead with R2 (the spatial + semantic page model), expressed through the action-scoped delta, with R1's action-scoped settle as the differentiated capability layered on top. Treat R3 as a byproduct, never a flagship.**

Rationale:
- **R2 has the cleanest, emptiest gap.** The entire field splits into pixels-only or semantic-tree-only; a structured **role/name + geometry + occlusion/covered-by + z-order** model that a human/agent asserts on is owned by no one — and the two tools that internally compute occlusion (Playwright, browser-use) deliberately hide it.
- **DW already ships R2's primitive and it is proven-precise** (covered-by-overlay geometry, 0 hard false positives). This is a *packaging/exposure* problem, not a discovery problem — the lowest-risk path to a defensible product.
- **R2 is the substrate for the other two.** Action-scoped settle (R1) needs to know *where* things changed; durable anchoring (R3) needs geometry+text. Building R2 well de-risks and enables both.
- **R1 is the strong #2** and the source of DW's flagship *capability* (`actAndObserve` = R2-representation × R1-scoping — the thing no competitor has). But as a *standalone* direction it is contested (Waitless commoditized the multi-signal primitive) and carries real execution risk (never-settle on perpetual churn). Its defensible core — *action-scoped attribution that tolerates ambient RPC noise* — should ship **as the delta's readiness half**, not as a generic quiescence library.
- **R3 is the least defensible** — most crowded, incumbents mature, AI re-derivation already neutralizes churn, cheap app-side fixes exist, and DW is currently weakest there. Pursue only the narrow legacy anchoring sub-gap as a spin-off of R2.

**One-sentence positioning:** *DW's un-owned territory is **action granularity** — a structured, geometry-annotated model of what changed because of the specific action you just took, on exactly the opaque legacy apps where accessibility trees degrade and network-idle never fires.*

---

### Confidence & caveats
- **High / multi-agent-corroborated:** networkidle discouraged & RPC-defeated; no framework waits on the *action's effect*; no combined geometry+semantic model exposed; no AI agent computes a general per-action delta; self-healers are proprietary-SaaS.
- **Single/vendor-source — re-verify before external quoting:** Testim ~70% re-score, mabl 5-run GenAI gate, Waitless internals (blog + PyPI, re-verified as global-not-action-scoped), Skyvern incremental-scrape scoping (read from `handler.py`).
- **Cuts against DW:** WebVoyager AX-vs-vision (~19 pts) shows the market's poor-semantics answer is *vision*, so "avoid the AX tree" is not itself novel — DW's novelty must rest on *structured determinism + action scoping*, not merely on "not the AX tree."
