# R-hardening — DW-native levers that reduce flakiness plain Playwright discipline does NOT own

**Block:** HARDENING (making existing tests less flaky / more robust).
**Method:** no-action research pass. Grounded in the code (`src/matchers/actionable.ts`,
`src/wait/index.ts`, `src/host/input-integrity.ts`, `src/matchers/checksum.ts`,
`src/injected/observer.ts`, `src/host/taxonomy.ts`, `src/host/types.ts`) + cited web prior-art.
**Prior verdict this builds PAST (do not re-discover):** on a real 292-test suite, suite-speed/flakiness
was ~85% plain-Playwright discipline (proper `waitFor`, web-first assertions) that DW does **not** own;
the one DW-flavored lever (structural quiescence as a settle) already shipped as `observeEffectSettled`.
So the whole question here is: **what is the NEXT genuinely DW-native hardening lever, and what is just
"faster sleeps" reskinned?**

---

## 1. State of the art — what Playwright and its ecosystem ALREADY own (cited)

Be honest first: the large majority of flakiness is already a *solved problem* by Playwright itself and by
a mature anti-flake tooling layer. A hardening candidate only earns its keep if it lands **outside** all of
the following.

### 1a. Playwright core already owns the timing/wait class

- **Auto-waiting + actionability checks.** Every locator action runs a series of actionability checks
  (attached, visible, stable, enabled, receives-events / hit-target) and waits until they pass before
  acting — so "the element isn't ready yet" is largely handled by the framework, not the test author.
  ([Playwright best-practices flaky-tests](https://github.com/ZeeaanNawazHarall/playwright-best-practices/blob/main/docs/08-flaky-tests/README.md),
  [BrowserStack: Playwright waits](https://www.browserstack.com/guide/playwright-wait-types))
- **Web-first, auto-retrying assertions.** `await expect(locator).toBeVisible()` / `toHaveText()` /
  `toHaveValue()` retry until the condition holds or the expect timeout elapses. The canonical anti-flake
  fix is "replace every `waitForTimeout` with auto-waiting locators + web-first assertions."
  ([Playwright: Assertions](https://playwright.dev/docs/test-assertions),
  [Semaphore: avoid flaky Playwright tests](https://semaphore.io/blog/flaky-tests-playwright))
- **`expect.poll` / `expect(async () => {…}).toPass()`.** Retry a value or a whole assertion block until it
  passes within one attempt — the sanctioned way to absorb "UI flickers through intermediate states
  (spinners, partial hydration)." ([Playwright: Assertions](https://playwright.dev/docs/test-assertions),
  [qaskills: toPass](https://qaskills.sh/blog/playwright-to-pass-retry-block-assertions))
- **Locators re-query per action.** Because a locator re-resolves the live DOM on every `.click()/.fill()`,
  a component that re-renders *between* actions self-heals — this is Playwright's answer to the classic
  "element is not attached to the DOM" across steps.
  ([Mergify: auto-wait vs re-render](https://mergify.com/blog/playwright-auto-wait-element-rerenders))
- **`networkidle` is officially DISCOURAGED** in `waitForLoadState`/`waitForURL`: a single analytics beacon
  or long-poll prevents it resolving; the recommended replacement is "wait for the specific element / the
  specific `waitForResponse`." ([Playwright issue #22897](https://github.com/microsoft/playwright/issues/22897),
  [Checkly: waits & timeouts](https://www.checklyhq.com/docs/learn/playwright/waits-and-timeouts/))

**Firewall consequence:** any DW "settle" that merely waits *longer* on a whole-page or whole-element
signal is a `networkidle`/`waitForSelector` reskin. It is forbidden.

### 1b. The ecosystem already owns cross-run flake management

- **Statistical detection + quarantine.** Atlassian *Flakinator* ingests CI data, applies retry- and
  Bayesian-based detection, auto-quarantines, and routes ownership (350M+ executions/day, ~81% detection);
  BuildPulse / Trunk Flaky Tests / Cypress Cloud / TestDino score and track flaky tests across runs.
  ([Atlassian: taming test flakiness](https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests),
  [Pie: flaky tests in CI/CD](https://pie.inc/blog/flaky-tests-cicd/))
- **Detection is rerun/history based:** run a test 20–50× on one commit and see if it both passes and
  fails, or track a rolling per-test failure rate over ~14 days. Definitionally, the test must have
  **already flaked** — repeatedly — before these tools see it. ([TestDino: flaky tests](https://testdino.com/blog/flaky-tests))

**Firewall consequence:** any DW "retry the test / quarantine / statistical pass-rate" feature is an
ecosystem reskin, and worse, the research is unanimous that **silent auto-retry is an anti-pattern** — it
masks genuine race conditions and ships them to production; a test that quietly passes on attempt 2 throws
away the very evidence you need. ([Mergify: jest.retryTimes hides bugs](https://mergify.com/blog/why-jest-retrytimes-hides-bugs),
[dev.to: flaky tests are a broken feedback loop](https://dev.to/microseyuyu/flaky-tests-are-not-a-testing-problem-theyre-a-feedback-loop-you-broke-8j5))

### 1c. Research already owns "classify why a test is flaky" — from SOURCE / HISTORY, not a runtime delta

- **FlakyCat / FlaKat / HiFlaky / NeuroFlake** classify flaky tests into root-cause categories
  (async-wait, concurrency, order-dependency, non-determinism, implementation-dependent, …). Crucially they
  classify from **test SOURCE CODE vectorization** (TF-IDF / Doc2Vec / Code2Vec) or from **rerun history**,
  not from a single-run runtime observation, and top F1 is modest (~0.67 on Java).
  ([FlaKat, arXiv 2403.01003](https://arxiv.org/html/2403.01003v1),
  [FlakyCat PDF](https://orbilu.uni.lu/bitstream/10993/55848/1/FlakyCat.pdf),
  [HiFlaky](https://www.sciencedirect.com/science/article/abs/pii/S0164121225004108))

**Firewall consequence:** a DW classifier is only differentiated if it labels **from one run's
action-granular delta, before the test has flaked** — not from source text and not from statistics.

---

## 2. DW's real gap — the flake classes that fall THROUGH all of §1

The incumbents share one blind spot: they operate at **whole-page / whole-element / whole-test** grain and,
for the statistical layer, **post-hoc across many runs**. None models *what the specific action just did*
in a single run. The flake classes that live in that gap:

| Flake class | What actually happens | Does an incumbent own it? | DW-native signal |
|---|---|---|---|
| **Input debounce / commit race (value-loss)** | `fill()` reports success; an async debounce / autocomplete / input-mask / framework listener then **clears, truncates, or drops** the committed value *after* the action returns. A downstream submit intermittently fails; the fill site looks green. | **No.** `toHaveValue()` auto-retries toward a value you must *specify* and still goes green if the widget mangles it after the retry converges, or if the test never asserts the value at all. Playwright has **no primitive** for "did my typed value survive the async widget." | `classifyInput` / `inputIntegrity` — post-settle committed-vs-intended subsequence check → `never-committed` / `truncated` / `dropped` (`input-not-committed`). Language/obfuscation-independent, PII-safe (shape + lengths only). **Uniquely DW.** |
| **Mid-action re-render staleness** | A component re-renders in the ~<50ms window between actionability check and dispatch, or the action's own output is inserted-then-torn-down (two-pass render / list virtualization). Manifests as intermittent "element is not attached to the DOM," or a silently-transient effect. | **Partially.** Locators self-heal *across* actions ([Mergify](https://mergify.com/blog/playwright-auto-wait-element-rerenders)). But the intra-action race and the *add-then-detach-within-window* transience are **not surfaced as a labeled signal**. | `detachedInWindow` / `detached-re-render` — counts a freshly-added subtree detached again inside the settle window. **DW uniquely LABELS it** (a fragility signal, not a fix). |
| **Occlusion at action-time** | A transient overlay / spinner / toast covers the target exactly as the action fires → intermittent covered-by error. | **Mostly yes.** Playwright's hit-target actionability check auto-waits for the overlay to clear; this is largely *prevented* already. | `preflight`/`toBeActionable` re-emit **Playwright's own** verdict + a `[geom:]` disagreement hint. Differentiated only in the annotation, **not** the boolean → **weak** hardening lever, high reskin risk. |
| **Background-churn false settle** | A live-ticking page (poll feed, toast, clock) makes `networkidle` never resolve and a naive "DOM-quiet" wait either hang or fire early. | **No** (`networkidle` is discouraged *because* of this) — but Playwright's answer ("wait for the specific element") already covers it *when you have a clean assertable element*. The residual gap is legacy/heavy-RPC/poor-a11y apps where you don't. | `observeEffectSettled` — pre-action **baseline footprint subtraction** (`bgInsert`/`bgAttr`/`bgText`/`bgRemove`) + **region-scoped** settle so churn *outside* the effect region can't reset it; `recurringInsert` labels post-action churn. **Already SHIPPED** — this is the prior lever, not the "next" one. |

**Reading the table:** two classes are genuinely un-owned and DW-native — **input-commit races** (owned by
*no one*) and **mid-action re-render / late-wave transience** (owned by no one *as a label*). One
(background-churn settle) is already shipped. One (occlusion) is essentially Playwright's and is the
reskin-trap.

---

## 3. Candidate capabilities (genuinely DW-native, NOT a `networkidle`/`waitForSelector` reskin)

### H1 — Input-commit integrity gate: `expect(locator).toHaveCommittedValue(intended)` *(the value-commit gate)*

A **loud, located** post-fill assertion. After a `fill`/`type` + the DW settle window, read the committed
value and run `classifyInput(intended, committed)`; **fail with the named loss shape** on
`never-committed` / `truncated` / `dropped`. Reuses `src/host/input-integrity.ts` **verbatim** (already the
shared classifier for the live and offline arms) plus the existing post-settle committed-value read.

Why it is not `toHaveValue` reskinned:
- It **names the loss shape (WHY)** — never-committed vs truncated vs dropped — not just "≠ expected."
- It is **subsequence/content-aware**: the `transformed` carve-out means an *intended* reformat mask
  (`4111 1111`→`41111111`, case/reorder, trim) does **not** fire — it flags real character loss only.
- It reads **after the DW settle window**, catching the async **debounce-then-clear** a synchronous
  `toHaveValue` immediately after `fill` misses; and it fires even on the common test that **never asserts
  the value** and just proceeds to submit (the silent-flake path).
- **PII-safe:** reports shape + two lengths, never the raw intended/committed strings.

Hardening effect: a green-but-value-lost step becomes a **deterministic failure at the fill site** instead
of an intermittent, mislocated downstream submit failure. That is direct robustness, not advice.

### H2 — Single-run **fragility labeler**: `assessFragility(delta)` → SUSPECTED "why-fragile" annotation

On a step that **PASSED**, emit a SUSPECTED fragility label from the *one* action-granular delta DW already
computes (all zero-added-latency signals): `detachedReRender` (mid-action re-render), `lateStructural` /
`suspectedEarly` (two-wave render — the step raced a late wave), `recurringInsert` / high
`droppedBackground` (background churn masking the effect), `hitMaxWait` (the app was still working when the
step proceeded), `inputIntegrity` loss. Surface it as a reporter annotation ("this passing step is fragile
because `<taxonomy code>`") so teams harden **before** the step flakes in CI.

Why it is not a FlakyCat/Flakinator reskin:
- Statistical detectors (Flakinator/BuildPulse/Trunk) need the test to have **already flaked repeatedly**;
  source classifiers (FlakyCat/FlaKat) read the **test SOURCE**. H2 labels from **one run's runtime
  delta, pre-flake** — a grain none of them occupy.
- It reuses the **closed taxonomy** (`src/host/taxonomy.ts`) verbatim — no new vocabulary, `unknown`
  allowed.

### H3 — `observeEffectSettled` as an HONEST settle inside a bounded, LOUD retry *(composition pattern, not a new primitive)*

Document/ship a pattern where the region-scoped, background-immune effect-settle is the readiness gate
feeding the caller's **own** web-first assertion inside a bounded `toPass`-style loop, with `hitMaxWait` /
`suspectedEarly` **raised as diagnostics** (attached to the report), never swallowed. Differentiated from a
blind `toPass` re-poll because the settle is **causal + region-scoped** and degrades where `networkidle`
fails (legacy/RPC). **Highest reskin risk** — ships as a documented composition, *not* a suppressing
primitive.

---

## 4. Honest real-vs-reskin check (per candidate, with contracts)

| Candidate | Real or reskin | Contract fit | MUST NEVER |
|---|---|---|---|
| **H1 value-commit gate** | **REAL — the strongest anti-reskin position of all** (Playwright has *zero* analog for post-async-widget value survival). | **DW-02** (a *separate* assertion — never overrides `fill`'s success); **DW-03** (`transformed` → abstain, don't flag a mask); **DW-04** (closed loss shapes). | auto-retype/repair the value; suppress the failure; claim *why* the widget dropped it (co-occurrence, not causation). |
| **H2 fragility labeler** | **REAL — un-owned across all three incumbent classes.** | **DW-03** (SUSPECTED, co-occurrence ≠ causation — a late wave *co-occurred* with the step, it does not prove a flake); **DW-04** (closed taxonomy, `unknown` allowed). | fail the passing test; quarantine; assert the step **will** flake; auto-fix. It is an **advisory label only**. |
| **H3 honest-settle-in-retry** | **BORDERLINE reskin.** Honest only as a settle *signal* feeding the caller's assertion with flags surfaced. If it retries-until-green it becomes the **silent-retry anti-pattern** the research condemns and a `networkidle` reskin. | **DW-03** (already enforced: no `ready` boolean, no retry knob in `observeEffectSettled`). | retry silently; count itself as a pass; hide `hitMaxWait`/`suspectedEarly`; wait on a whole-page idle signal. |

**Cross-cutting NEVERs for the whole block:** never suppress a flake, never auto-retry silently, never
convert a SUSPECTED signal into a verdict, never override Playwright's boolean. The entire value of a
hardening layer that respects DW-03 is that it makes flakiness **louder and located**, the opposite of the
retry/quarantine reflex the ecosystem warns against.

---

## 5. Feasibility

| Candidate | Reused primitive | Effort | Risks |
|---|---|---|---|
| **H1** | `src/host/input-integrity.ts` (`classifyInput`, `LOSS_SHAPES`) verbatim + the existing post-settle committed-value read that `actAndObserve`'s `inputIntegrity` already performs; wrap as a Playwright matcher like `toBeActionable`. | **Smallest / lowest-risk.** A matcher + a settle-then-read; the classifier and the read already ship and are tested. | **Yield is target-dependent** — it fired **0×** on the prior real corpus (that app had no debounce/masked-input races) and will fire heavily on autocomplete/masked-input apps. This is a *narrow but genuinely un-owned* lever; the charter values un-owned territory over broad-but-reskinned. Risk of author confusion vs `toHaveValue` → docs must state the "survives the async widget" distinction. |
| **H2** | The delta `stats` fields already computed at **zero added latency** (`detachedReRender`, `lateStructural`, `recurringInsert`, `droppedBackground`, `hitMaxWait`, `inputIntegrity`) + `ROOT_CAUSE_TAXONOMY`; surface via the existing reporter/side-car path. | **Medium.** No new page-side code; it's an aggregation + presentation layer over signals that exist. Broadest applicability (any re-rendering / live / two-wave app). | **Calibration.** False-fragile labels erode trust; `suspectedEarly` is *already documented as coarse* (light-DOM-only, background-churn can trip it). Must ship as SUSPECTED with confidence, not a gate. Ceiling higher than H1, precision risk higher too. |
| **H3** | `observeEffectSettled` unchanged (it deliberately exposes no `ready`/retry). | **Low code, HIGH doc care.** Mostly a documented pattern + example. | Reskin/silent-retry trap. Only defensible if the honesty flags are surfaced and it never suppresses. Recommend shipping as a *pattern*, deferring any sugar API until H1/H2 land. |

---

## 6. Summary + ranked top pick

**Summary (~200 words).** Most test flakiness is already owned: Playwright core owns the timing class
(auto-waiting, web-first auto-retrying assertions, `toPass`/`poll`, per-action locator re-query), and even
deprecates `networkidle`; the ecosystem owns cross-run detection/quarantine (Flakinator, BuildPulse, Trunk),
though the research is unanimous that silent auto-retry *masks* bugs; and academia owns flake
classification — but from **source code or rerun history**, not a single-run runtime delta. The gap DW
uniquely occupies is **action granularity**. Two flake classes fall clean through every incumbent:
**input-commit races** (an async debounce/mask silently eats a typed value — Playwright has *no* primitive
for it) and **mid-action re-render / late-wave transience** (owned by no one *as a label*). Background-churn
false-settle is real but already shipped (`observeEffectSettled`); occlusion is essentially Playwright's own
verdict and is the reskin trap. The honest levers therefore are: **H1** a loud, PII-safe value-commit gate
reusing `classifyInput`; **H2** a single-run, pre-flake fragility labeler over the closed taxonomy; **H3** a
composition pattern (honest settle inside a loud retry — borderline reskin, ship as docs). All must make
flakiness *louder and located*, never suppressed.

**Ranked top pick: H1 — the input-commit integrity gate (`expect(locator).toHaveCommittedValue`).** It is
the single most defensible "genuinely DW-native, cannot be reskinned" hardening lever — Playwright has
**zero** analog for post-async-widget value survival. It is a **direct** robustness win (a silent
value-loss flake becomes a deterministic failure at the fill site, not a mislocated downstream one), the
**smallest-effort / lowest-risk** to build (wraps an already-shipped, already-tested pure classifier plus an
existing read), and **loud by construction** — exactly the "fail LOUD on input-not-committed" exemplar. Its
one honest caveat is **narrow, target-dependent yield** (0 on the prior corpus; high on masked/debounced
inputs), which is precisely the un-owned-over-broad trade the charter endorses. **H2 (fragility labeler)**
is the higher-ceiling strategic runner-up — broader applicability and reuses free signals — but it is
advisory, not directly hardening, and carries calibration risk; pursue it as the follow-on. **H3** is a
documentation pattern, deferred.
