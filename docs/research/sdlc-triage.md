# R-triage — cross-run / cross-test triage at suite scale

**Block:** TRIAGE. **Status:** NO-ACTION research (cited). **Through-line:** DW already detects → labels →
routes ONE failure at a time (0 hard FP, honest `unsure` abstention). This report asks what a *collection*
of those honest, taxonomy-coded, confidence-scored side-cars can become across **many** failures — and
where that is genuinely un-owned versus a test-analytics reskin.

Grounded in the code as it ships today:
`src/reporter/triage.ts` (the per-failure side-car), `src/reporter/index.ts` (failed-only side-cars +
`attachDiagnosis` + the coverage sweep), `src/host/taxonomy.ts` (the closed code set),
`src/host/confidence.ts` (`confirmed`/`suspected`/`unknown`), `src/host/summarize.ts` (the shared gate),
`src/host/checksum.ts` (the geometry/timing-tolerant delta fingerprint),
`src/host/live-routing.ts` (DOM-vs-backend-vs-app-JS co-occurrence routing), and
`src/aggregate/index.ts` + `src/aggregate/html.ts` (the existing **per-test** cross-run aggregator).

---

## 1. State of the art / competitors (cited)

Suite-scale failure triage in the market clusters into three families. Each has a real, documented ceiling.

### 1a. Flaky-test platforms — per-TEST, rerun-driven

- **Trunk Flaky Tests** — auto-detect + quarantine + ownership routing across GitHub Actions / GitLab /
  Buildkite / CircleCI. Detection is rerun-history + pass/fail patterns across environments; quarantine and
  "failure fingerprinting" operate **per test** (recognising failure modes *within a single test*).
  Ownership is via ticketing integration keyed to repo/service.
  <https://trunk.io/flaky-tests>
- **Datadog Test Optimization / Flaky Management** — tracks flakiness at **per-test granularity** via
  `@test.fingerprint_fqn` = *"a hash of the repository ID and the test's fully qualified name"*. An ML layer
  assigns one of **13 root-cause categories** (Concurrency, Asynchronous Wait, Network, Environment
  Dependency, …, plus **Unknown**) from *"execution patterns and error signals"*. Ownership routing is a
  `test_codeowners` tag on notification rules. It does **not** cluster distinct tests by a shared structural
  cause beyond that category label.
  <https://docs.datadoghq.com/tests/flaky_management/> ·
  <https://docs.datadoghq.com/tests/early_flake_detection/>
- **BuildPulse** — ingests JUnit XML, detects "pass and fail without code changes", and (its real
  differentiator) ranks by **business impact** — "engineering hours lost, CI minutes wasted, PRs blocked" —
  rather than raw flake count; an AI agent opens fix PRs with a root-cause explanation. Detection/quarantine
  are **per test**; no documented cross-test signature clustering.
  <https://buildpulse.io/products/flaky-tests>
- Market surveys corroborate the split (CI-native detection, dedicated flake platforms, observability,
  framework retries, self-healing): <https://www.shiplight.ai/blog/best-tools-flaky-tests-ci-cd> ·
  <https://qualflare.com/blog/best-flaky-test-debugging-tools/> ·
  <https://www.harness.io/blog/flaky-tests-the-quiet-killer-of-productivity-in-your-ci-pipeline>

**Limit (family 1):** flakiness is inferred **a-posteriori from reruns** (multiple executions, pass/fail
flip-flop) and tracked **per test identity**. It is lagging (needs history), expensive (Datadog reruns new
tests up to N times to reach ~75% detection), and it never explains *why the mechanism is flake-shaped* — the
categories are ML guesses over text, with an explicit "Unknown" escape hatch.

### 1b. Failure-signature clustering / deduplication — TEXT signatures

- The classic dedup approach groups failures by **stack trace and/or error message**; Microsoft's CloudBuild
  flaky-test system "groups failures with similar error messages together". Overview:
  <https://www.ministryoftesting.com/software-testing-glossary/failure-clustering>
- **Just-in-Time Flaky Detection via Abstracted Failure Symptom Matching** — matches new failures to known
  flaky patterns by abstracting *"failure symptoms, such as error messages or stack traces"*; its own stated
  constraint is *"the importance of having descriptive and informative failure symptoms"* — vague symptoms
  break it (distinct causes → same symptom, or one cause → varying symptoms).
  <https://arxiv.org/abs/2310.06298>
- **230,439 Test Failures Later** (22 Java projects, 498 flaky tests) — symptom/signature dedup to separate
  flaky from real is *"extremely effective (100% specificity)"* on some projects and *"entirely ineffective"*
  on others, with the dangerous failure mode that *"flaky test failure symptoms might resemble those of true
  failures … a risk of misclassifying a true test failure as a flaky failure to be ignored."* Signature-only
  classification is **unreliable as a standalone approach**. <https://arxiv.org/abs/2401.15788>
- Empirical failure clustering in parallel debugging (grouping failing cases by fault) is a long-studied,
  intrinsically hard problem — clusters mix distinct faults or split one fault. <https://arxiv.org/pdf/2207.07992>

### 1c. Error-grouping systems — Sentry-style fingerprints (the canonical analog)

- **Sentry** groups by fingerprint → stack trace → exception → message, defaulting to the stack trace.
  <https://docs.sentry.io/concepts/data-management/event-grouping/> ·
  <https://develop.sentry.dev/backend/application-domains/grouping/>
- Its two documented failure modes are exactly the traps DW must avoid: **over-grouping** ("API responses of
  400 and 500 both resulting in the same frontend exception stack trace … grouped together") and
  **under-grouping** ("an exception raised from two different locations … not grouped together"). Root cause:
  *"a stack trace consists of multiple frames and each frame contributes to the fingerprint … two stack
  traces can be the same execution path but differ by one frame due to middleware, node_modules, the
  framework itself, or library imports."* <https://punits.dev/blog/how-we-made-sentry-work-to-identify-production-issues/>

**Limit (families 1b/1c):** the grouping key is **text** (message / stack trace). Text is noisy — obfuscated
class names, framework frames, and localized/variable error strings jitter it — so every text-fingerprint
system fights over-grouping and under-grouping, and needs per-project fingerprint rules to be reliable.

### 1d. Ownership routing — CODEOWNERS by source PATH

- **CODEOWNERS** (GitHub/GitLab) routes by the **source file path** a change touches (last-match-wins; empty
  teams block merges). Sentry/AppSec tools extend it: "when a scan detects an issue in a file path … look up
  who owns that path" — i.e. routing needs the failure to map to a **product source file** in a stack frame.
  <https://docs.gitlab.com/user/project/codeowners/> · <https://docs.sentry.io/product/issues/ownership-rules/> ·
  <https://www.secure.com/blog/appsec/appsec-teams-route-findings-to-code-owners> ·
  <https://www.aviator.co/blog/a-modern-guide-to-codeowners/>

**Limit (family 1d):** an E2E/Playwright failure's error names the **test file and the locator**, not the
product source line that broke. Path-based routing therefore misfires for E2E failures, and ownership is
otherwise manual.

### The market gap, stated once

Everyone groups on **(a) test identity** (per-test flakiness) or **(b) a text signature** (message / stack
trace) or **(c) a source path**. Nobody groups E2E failures on the **observed structural *mechanism* of the
failure** — because nobody else *has* an action-scoped, taxonomy-coded, geometry-tolerant model of what the
failure looked like in the DOM. That is DW's un-owned territory.

---

## 2. DW's real gap today

DW emits, per failed test, one honest side-car: a closed taxonomy `cause`, a `confidence` band, `detached` /
`lateWave` / `staleRect` flags, and the full `diagnoses[]` list — never fabricated, `unsure` first-class
(`src/reporter/triage.ts`). The existing aggregator (`src/aggregate/index.ts`) already does a **read-only,
cross-run** sweep — but it groups by **`testId`** (per-test), ranks most-flaky-first, and reports per-test
`settleCapRate` / `disagreementRate` with `unsure` bucketed apart. That is family-1a-shaped: *per test*.

Three concrete gaps against the suite-scale bar:

1. **No cross-TEST clustering by cause.** Twelve tests that all fail because the same cookie-consent glass
   covers the same button are twelve unrelated rows today. The `covered-by-overlay` code is identical and the
   normalized delta is identical — but nothing collapses them into "one root cause, 12 blast-radius tests".
2. **Flake-vs-real is not surfaced from the mechanism.** The taxonomy already *knows* that `settle-timeout` /
   `background-churn` / `late-wave-suspected` are timing/race-shaped while `disabled` / `not-visible` /
   `covered-by-overlay` are deterministic-geometry-shaped — but the aggregator never turns that into a
   flake-likelihood, so DW leaves the rerun-based incumbents to guess it a-posteriori.
3. **The delta fingerprint is computed but thrown away.** `checksum(delta)` (`src/host/checksum.ts`) is a
   stable, geometry/timing/message-**tolerant** structural hash — the ideal clustering key that dodges every
   Sentry-style text-jitter trap — yet the side-car (`Sidecar` in `triage.ts`) **does not persist it**, and
   neither does the live `routing` report (`DeltaStats.routing`). The best available cross-test key exists and
   is dropped on the floor.

---

## 3. Un-owned, action-granularity candidates (2–3)

All three exploit what only DW has: a **closed taxonomy code** + a **confidence band** + a **geometry-tolerant
delta fingerprint**, over a corpus of honest side-cars. None reruns anything; none parses a stack trace.

### T1 — Cause-clustering keyed on (taxonomy-code × delta-fingerprint) — the flagship

**What:** a read-only pass over a side-car corpus (across tests *and* runs) that collapses failures into
**root-cause clusters** using a two-level key:

- **Level 1 (the partition, never crossed):** the closed `cause` code. Two failures with different codes are
  **never** in the same cluster — this is the anti-over-grouping firewall Sentry lacks (a `not-visible` and a
  `covered-by-overlay` can never merge, no matter how similar their text).
- **Level 2 (the sub-key within a code):** the geometry/timing/message-tolerant `checksum(delta)`. Failures
  sharing a code **and** an identical normalized delta fingerprint are the *same observed structural effect*
  (same widget, same coverer, same state-attr transition) — collapsed into one cluster with a blast-radius
  count ("17 failures across 6 tests, 3 runs"). Different fingerprints under one code = same cause *family*,
  different sites (sub-clusters).

**Why it is not a reskin:** incumbents cluster on text (message/stack — noisy, needs per-project rules,
over/under-groups per §1b/1c) or on test identity (per-test, §1a). T1 clusters on a **normalized structural
delta**: `normalizeDelta()` already drops raw refs, pixel rects, computed-style strings, timing, error text,
and MutationObserver order, folds obfuscated app classes to `hash` while keeping load-bearing framework
classes, and folds the changed **state-attribute names**. So "same cause" clusters even when the message text
differs (kills under-grouping), and distinct codes never collapse (kills over-grouping) — the exact two
failure modes the Sentry post-mortem names. This is the "cluster thousands of failures → a handful of root
causes" promise, but on a structural key instead of a fragile signature.

**Contract / must-never:** DW-04 (the closed code is the partition — clusters are named by a real code, never
an invented bucket). DW-03 (a shared fingerprint is **co-occurrence of an identical observed effect, not proof
of the same bug** — a cluster is a *hypothesis*, echoing `checksum.ts`'s own note that a matching checksum is a
regression identity, "says nothing about whether the fixture faithfully models a real app"). It must NEVER
present a cluster as "the same bug", NEVER merge two different codes, and — critically — **NEVER cluster
`unsure` failures together as if they shared a cause**: each `unsure` stays a **singleton** in its own bucket
(you cannot fingerprint an absence of evidence), exactly as the aggregator already refuses to fold `unsure`
into a category.

### T2 — Flake-shape vs real-defect, from the taxonomy — without reruns

**What:** classify each cluster's **flake-likelihood from its taxonomy category**, not from rerun flip-flops.
The closed code set partitions cleanly by physics:

- **Timing / race-shaped (flake-prone by mechanism):** `settle-timeout`, `background-churn`,
  `late-wave-suspected`, `stale-rect-suspected`, `detached-re-render`, `unstable-animating`
  (`membership-attribution` + the animating case).
- **Deterministic-geometry-shaped (a real, reproducible defect — reruns won't help):** `covered-by-overlay`,
  `not-visible`, `off-screen`, `disabled`, `read-only`, `pointer-events-none`, `input-not-committed`.

A single failing run already carries the shape; incumbents need a rerun **history** to guess it (§1a). T2
labels a cluster "timing-shaped → likely rerun-sensitive" or "deterministic-shaped → likely a real regression,
reruns are wasted". Where retry history *is* present (the reporter already writes one side-car per retry,
`-r{retry}`), T2 **corroborates** shape against observed flip-flop but never overrides it.

**Why it is not a reskin:** it is an **a-priori** flake judgment from the failure *mechanism*, orthogonal to
(and cheaper than) the a-posteriori rerun statistics every incumbent uses — a signal none of them can produce
from one run. It composes on top of T1 (you shape-classify the *clusters*, not raw failures).

**Contract / must-never:** DW-02 (Playwright/CI owns the pass/fail and any quarantine decision — DW **never
quarantines** and never says "this test IS flaky"). DW-03 (shape is a hypothesis: `settle-timeout` is
deliberately ambiguous — a genuinely slow-but-correct backend also caps, and `taxonomy.ts` already frames
`background-churn`/`suspected-miss-empty` as "suspected"). It must surface **mixed / `unsure` clusters as
undecided**, never force a flake-or-real verdict. The deterministic-vs-timing partition must ship as a
reviewed, ADR-locked mapping (like the taxonomy lock in `test/taxonomy.spec.ts`), not a vibe.

### T3 — Ownership routing by cause-DOMAIN, not by source path

**What:** bucket clusters by the **domain of the observed mechanism** and emit a route per cluster:
`actionability-blocking` / `verdict-disagreement` → **frontend/DOM**; `outcome-integrity`
(`input-not-committed`) → **frontend-or-backend data path**; `capture-integrity` / `injection-blocked` →
**test-infra / CSP**; `membership-attribution` → **app-timing**. When the opt-in live `routing` report is
present (`buildLiveRouting`), fold its DOM-vs-backend(≥400/requestfailed)-vs-app-JS(pageerror) co-occurrence to
sharpen the route ("2 clusters route to BACKEND — co-occurring 5xx").

**Why it is not a reskin:** CODEOWNERS routes by the **source file path** in a stack frame (§1d), which an E2E
failure rarely provides. T3 routes by the **observed failure mechanism**, which is exactly what an E2E failure
*does* give you — then hands the domain to CODEOWNERS to pick the human. It **complements** CODEOWNERS rather
than rebranding it.

**Contract / must-never:** DW-02 (routing is adjacent metadata, emits no code, never overrides the verdict) and
DW-03 (the backend route is **co-occurrence**, carried verbatim from `live-routing.ts`: "WEIGH as a possible
backend/infra signal, not a cause" — a co-occurring 5xx is never "the backend caused this"). It must NEVER
auto-assign or auto-close, and **`unsure` clusters route to NO owner** — an explicit "needs a human triage"
bucket, never a guessed team.

---

## 4. Honest real-vs-reskin check (summary)

| Candidate | Real (un-owned) because | Contract | Must NEVER |
|---|---|---|---|
| **T1** cause-cluster (code × fingerprint) | groups on a **normalized structural delta**, not text/stack/test-id → immune to the obfuscation + frame-noise that over/under-groups Sentry; closed code = hard anti-merge firewall | DW-03, DW-04 | call a cluster "the same bug"; merge two codes; cluster `unsure` together (each stays a singleton) |
| **T2** flake-shape from taxonomy | **a-priori** flake shape from the *mechanism*, from ONE run — orthogonal to everyone's rerun statistics | DW-02, DW-03 | say "this test IS flaky"; quarantine; force a verdict on mixed/`unsure` clusters |
| **T3** cause-domain routing | routes by **observed mechanism**, the thing an E2E failure actually yields (CODEOWNERS needs a source path it lacks) | DW-02, DW-03 | assert "the backend caused this"; auto-assign/close; route an `unsure` cluster to any owner |

---

## 5. Feasibility

**Shared substrate — the one real dependency.** The clean cross-test key is `checksum(delta)`, which the
side-car **does not persist today**. The enabling change is small and well-scoped:

- Fold `checksum(delta)` into the **rich-mode** side-car (a `deltawright-delta` attachment was present) → a
  high-resolution structural fingerprint. Reuses `src/host/checksum.ts` verbatim — no new engine.
- For the **passive / zero-edit** majority (a synthetic delta from the error text), the honest fallback is a
  **coarse `signature`** derived from the diagnosis-code multiset + the `detached`/`lateWave`/`staleRect`
  flags. Label the cluster's resolution by `source`: `delta-attachment` = high-res structural; `error-text` =
  low-res error-shape. This makes the resolution limit **visible, not hidden** — the same honesty stance the
  aggregator takes with `unsure`.

**Per candidate:**

- **T1** — reuses `checksum` + taxonomy + the existing read-only aggregator sweep (`readSidecars` /
  `aggregate`). Effort: **MEDIUM**. New: the persisted fingerprint (above) + a `clusterByCause()` pass + a
  cluster panel in `src/aggregate/html.ts`. Risk: passive corpora yield coarse clusters — must not over-promise
  structural clustering on error-text-only inputs (label the resolution honestly).
- **T2** — reuses the taxonomy category + the aggregator's already-computed `settleCapRate` /
  `disagreementRate` + the per-retry side-car files. Effort: **LOW–MEDIUM** (a classification layer over data
  already computed). Risk: the deterministic/timing partition needs an ADR + a locked test (the `settle-timeout`
  ambiguity must be documented, not smoothed over).
- **T3** — reuses `buildLiveRouting` + a taxonomy-category→domain map + the aggregator. Effort: **MEDIUM**.
  New: persist the opt-in `routing` report into the side-car (today it lives only on `DeltaStats.routing`); the
  domain-map ADR. Risk: the sharpest routing signal is live/opt-in — the passive corpus can only route on the
  category (weaker but still real, since the category *is* a coarse domain).

**Composition:** T1 is the substrate; T2 shape-classifies T1's clusters; T3 routes them. Shipping T1 first
makes T2 and T3 cheap follow-ons over the same cluster objects.

---

## 6. Summary + ranked top pick

DW already turns one failure into an honest, taxonomy-coded, confidence-scored side-car with **0 hard FP** and
first-class `unsure`. The suite-scale opportunity is to turn a **corpus** of them into a handful of honest
**root-cause clusters** — and DW can do it on a key no incumbent has. Flaky-test platforms (Trunk, Datadog,
BuildPulse) group **per test** from **rerun history**; signature-dedup and Sentry group on **text**
(message/stack) and provably over- and under-group; CODEOWNERS routes on a **source path** an E2E failure never
supplies. DW's un-owned key is the **closed taxonomy code × the geometry/timing/message-tolerant delta
fingerprint** — structural, not textual, so "same cause" collapses even when the text jitters and distinct
causes can **never** merge. Three composable candidates follow: **T1** cause-clustering (the flagship),
**T2** flake-shape-from-taxonomy without reruns, **T3** cause-domain routing that complements CODEOWNERS. Each
stays honest: `unsure` is never clustered into a cause, co-occurrence is never causation, DW never quarantines
or overrides Playwright's verdict.

**Ranked top pick: T1 — cross-test cause-clustering keyed on (taxonomy-code × delta-fingerprint).** It is the
direct answer to "what can a collection of side-cars become", it exploits the delta fingerprint the charter
flags as the clustering key, it is the sharpest differentiation from every text-signature incumbent, it reuses
`checksum` + taxonomy + the read-only aggregator almost wholesale, and its one real gap — persisting the
fingerprint in the side-car — is small and self-contained. T2 and T3 then ride on T1's clusters as cheap
follow-ons.
