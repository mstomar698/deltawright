# R-reporting — what makes a DW report DRIVE ACTION

*SDLC-usefulness research, REPORTING block. NO-ACTION pass: this is a cited design memo, not code.
Grounded in `src/reporter/*` + `src/aggregate/*` + `src/host/{confidence,taxonomy}.ts`. Generic — no
client/PII.*

---

## 0. What DW ships TODAY (the baseline to build ON, not re-propose)

- **`deltawright/reporter`** (`src/reporter/index.ts` + `triage.ts`) — zero-edit Playwright reporter.
  Writes one taxonomy-labeled side-car (`*.deltawright-sidecar.json` + `.triage.txt`) per **finally-failed**
  test (coverage sweep guarantees exactly one, never on a green/flaky-then-passed test). `attachDiagnosis`
  puts the diagnosis **inline in the Playwright HTML report**. Cause comes from the one `diagnose()` engine;
  a locator that never resolved degrades to `unsure` + `detached` — never a fabricated cause.
- **`deltawright/aggregate`** (`src/aggregate/index.ts` + `html.ts`) — read-only pass over side-cars across
  runs → JSONL + a ranked summary + a self-contained, theme-aware **HTML dashboard**. Ranks **most-flaky
  first by raw failure count** (`aggregate()` sorts by `failures`, then distinct `runs`, then `testId`).
  Surfaces per-test dominant category, `settleCapRate`, `disagreementRate`, and an **`unsure` bucket kept in
  its own panel** — never folded into a real category.
- **Primitives available for free:** the closed 18-code / 6-category taxonomy (`taxonomy.ts`), the
  `confirmed | suspected | unknown` confidence with evidence-source grounding (`confidence.ts`), and per-record
  flags (`detached`, `lateWave`, `staleRect`, `hitMaxWait`, `disagreement`) plus each retained diagnosis line.

**Honest read of the baseline:** DW's reports are already *honest* (unsure bucketed apart, confidence banded,
Playwright authoritative) and *taxonomy-coded*. But they are **presentation-first** — they *display*
per-failure data and rank by *frequency*. They do not yet *decide* what to fix first, whether a failure is
new/regressed, or surface the cause where developers actually look (the PR).

---

## 1. State of the art / competitors (CITED)

### Playwright's own reporters
- **HTML reporter** — filters by passed/failed/flaky/skipped, screenshots/video/trace per failure, retry-based
  "flaky" labeling. **Limits (widely documented):** single-run focus; *no* cross-run trends across
  branches/environments; can't say whether a test has been failing for a month or which feature is most
  problematic; **manual triage burden at scale**.
  ([Playwright running-tests](https://playwright.dev/docs/running-tests),
  [Currents: HTML reporter breaks down at scale](https://currents.dev/posts/playwright-html-reporter-why-it-breaks-down-at-scale),
  [TestDino: the reporting gap](https://testdino.com/blog/playwright-test-reporting))
- **`github` reporter** (built-in) — emits **inline GitHub Actions annotations** for failed tests: file, the
  exact assertion, expected-vs-received. **Limit:** it annotates the **raw Playwright error only** — no cause,
  no priority, no confidence; one annotation per failure.
  ([Playwright reporters](https://playwright.dev/docs/test-reporters))

### Allure
Rich HTML: **categories** (product defects vs test defects vs known issues; group by severity/owner/flaky),
flaky markers + filter, and **historical trends** (trend charts, duration dynamics, status-age pyramid) that
*require history to be enabled*. **Limit:** categories are **regex-over-error-message rules a human maintains**;
there is **no confidence, no abstention, no per-action cause** — it is presentation-rich but attribution-thin.
([Allure visual analytics](https://allurereport.org/docs/visual-analytics/),
[allure3](https://github.com/allure-framework/allure3),
[BrowserStack: Allure](https://www.browserstack.com/guide/generate-allure-test-report))

### ReportPortal
ML **auto-analysis** trained on *previously human-investigated* results; classifies each failure into **4
defect types — Product Bug / Automation Bug / System Issue / No Defect**; **Unique Error** clustering of
identical failures; ML **suggestions** from similar historical failures (~30 features over log text + item
stats). **Limits:** needs a *trained corpus of human labels* to be useful; **no documented confidence score
or abstention** (the AI is marketed as "minimizing human error," not as calibrated uncertainty); server infra
(OpenSearch + analyzer services).
([RP auto-analysis](https://reportportal.io/docs/analysis/AutoAnalysisOfLaunches/),
[RP failure categorisation](https://reportportal.io/docs/features/CategorisationOfFailures/),
[RP AI failure-reason detection](https://reportportal.io/docs/features/AIFailureReasonDetection/))

### Datadog CI Visibility / Flaky Test Management
Centralized flaky-test view ranked by **impact metrics — pipeline failures, CI time wasted, failure rate**;
**quarantine** (test keeps running but failures don't break the pipeline); and **AI assigns one of 13
root-cause categories incl. "Unknown"** (concurrency, timeouts, async wait, order-dependence, network, …),
requiring both `@error.message` and `@error.stack` to be eligible.
([Datadog flaky management](https://docs.datadoghq.com/tests/flaky_management/),
[Datadog CI Visibility](https://www.datadoghq.com/blog/datadog-ci-visibility/))

### BuildPulse / Trunk
Flake detection + **quarantine**; dashboards that **prioritize which flaky test to fix by impact** — BuildPulse
sorts by **"Most Disruptive"** (number of flaky failures), Most Recent, or Quarantined; Trunk visualizes flaky
trends over time and isolates candidates.
([BuildPulse dashboard](https://docs.buildpulse.io/flaky-tests/guides/Flaky%20Tests%20Dashboard),
[BuildPulse quarantine](https://docs.buildpulse.io/flaky-tests/guides/Test%20Quarantining),
[Trunk vs Datadog](https://trunk.io/compare/trunk-vs-datadog))

### GitHub Checks API (the CI annotation substrate)
A Check Run carries **line-level annotations** (file + start/end line, level `notice | warning | failure`,
message, title, raw_details), a **64K-char Markdown summary/text**, images, and a conclusion — annotations
appear **inline on the PR "Files changed" view**. **Limits:** ≤ **50 annotations per API request** (appended,
not replaced); inline annotations are **PR-only** (not on push/dispatch).
([Introducing check runs & annotations](https://github.blog/news-insights/product-news/introducing-check-runs-and-annotations/),
[Ken Muse: creating GitHub Checks](https://www.kenmuse.com/blog/creating-github-checks/),
[Publish Test Results action](https://github.com/marketplace/actions/publish-test-results))

### Cross-domain principles (what "actionable" means beyond testing)
- **Severity ≠ blast radius:** severity is theoretical risk in isolation; **blast radius is the *actual* scope
  affected by reachability** — prioritize the large-blast-radius items first.
  ([Endor Labs: blast radius](https://www.endorlabs.com/learn/vulnerability-blast-radius-how-to-measure-and-reduce-impact))
- **A report should drive specific actions:** prioritize by severity not by count; assign owners/deadlines;
  enrich alerts with context (criticality, history, likely root cause).
  ([Security Boulevard: beyond pass/fail](https://securityboulevard.com/2026/05/how-to-read-a-ddos-test-report-beyond-pass-fail/))
- **Noise reduction = signal quality, not just volume:** dedup/correlate, use tiered priority; static
  thresholds and poor severity classification are the classic failure modes.
  ([BigPanda: alert-noise reduction](https://www.bigpanda.io/blog/alert-noise-reduction-strategies/),
  [Stellar Cyber](https://stellarcyber.ai/learn/alert-noise-reduction/))
- **Regression reporting = current vs baseline:** highlight **new failures (regressions)** vs resolved vs known
  issues; a single data point has little value — establish a baseline and read the trend.
  ([ReportPortal: test-result trends](https://reportportal.io/blog/test-result-trends-how-to-analyze-regression-testing-results-over-time-in/),
  [Baseline testing for developers](https://dev.to/sophielane/baseline-testing-for-developers-catching-regressions-without-slowing-ci-3b0m))

---

## 2. DW's real gap vs that bar

| Decision-driving dimension | Incumbent bar | DW today | Gap |
|---|---|---|---|
| **Prioritization** | Datadog/BuildPulse rank by **impact** (CI-time, pipeline failures, "Most Disruptive") | ranks by **raw failure count** (`aggregate()` sort) | DW has confidence + category + shared-cause structure but **never combines them into a fixability/priority rank** — it reproduces the "sort by frequency" limit others already moved past |
| **Trend / regression** | Allure/RP/Datadog show pass/fail trends + new-vs-known | reads across runs but emits a **static most-flaky list**; never diffs run N vs N-1 | **no NEW / REGRESSED / RECOVERING / CHRONIC signal**, and no *cause-trajectory* (mode changed?) |
| **CI-native, in-the-PR** | PW `github` reporter annotates the **raw error**; Datadog/Allure live off-platform | `attachDiagnosis` (inline in PW HTML report) + a standalone dashboard | **no GitHub Checks annotation carrying DW's cause + confidence** at the failing action's authored line — the diagnosis isn't where reviewers look |
| **Honest uncertainty** | RP/Datadog: **no documented confidence/abstention**; Datadog's "Unknown" is a 13th bucket | **already strong** — `unsure` bucketed apart, confidence banded, PW authoritative | **not a gap to fix — an asset to protect and *leverage*** (route unsure to humans explicitly, never bury or inflate it) |

**The through-line DW under-uses:** every incumbent classifies at **test / launch granularity** (Datadog: a
per-test flaky category; Allure: a per-test error-regex bucket; RP: a per-launch defect type). DW alone has a
**per-ACTION** diagnosis with **grounded confidence** — "the click on step 4 was `covered-by-overlay`
(*suspected*, geometry-only)" or "`input-not-committed` — the field committed a subsequence of the intent."
A DW report can therefore rank, trend, and annotate **on the cause, not the symptom** — which no incumbent
reporter can, because they never had the action-scoped signal.

---

## 3. Candidate capabilities (differentiated, honest)

### Candidate A — **Actionability Priority queue** (rank by shared-cause blast-radius × confidence; `unsure` in its own lane)

Replace "most failures first" with a **decomposed, auditable priority** over the existing `FlakeReport`:

- **Blast-radius** = how many **distinct tests** share the same taxonomy **cause code** (stretch: same
  `covered-by-overlay` *covering-element* signature). One overlay covering a submit button that breaks 20 tests
  is *one fix that clears 20 reds* — the single highest-leverage thing in the suite. DW already computes
  per-category counts across tests (`categoryTotals` in `html.ts`); this extends it to per-*code* distinct-test
  clusters.
- **Confidence band** as a **separate axis** — `confirmed` cause clusters rank above `suspected`; `unsure`
  is **NOT scored low** (which would bury it). It is routed to its own **"DW can't explain — N failures need
  human triage"** lane, on par with the top lane, honoring the existing unsure-apart rule.
- **Persistence** = the already-computed `failures` × distinct `runs`, plus `settleCapRate` / `disagreementRate`
  as tie-breakers and as the row's *why-it-ranks* explanation.

Output is a **ranked triage queue where every row shows its components** (`cause · confidence · #tests-sharing
· #runs · settle-cap%`) — never one opaque score. It turns the dashboard from "here is all the data" into
"fix *this* cluster first, and here is exactly why."

- **Real vs reskin:** **REAL.** Datadog/BuildPulse rank by *frequency / CI-time*; DW ranks by **shared
  root-cause blast radius**, which is only possible because DW owns the action-scoped taxonomy they don't.
  Clustering 20 reds onto *one covering overlay* is a fix-once-fix-many signal no frequency sort produces.
- **Contracts:** DW-04 (`unsure` gets its own lane, never scored low or folded); DW-03 (blast-radius is
  *co-occurrence of the same cause signature*, labeled "tests sharing this cause" — **never** a claim that one
  fix *will* clear them all); DW-02 (priority annotates, never overrides PW's pass/fail).
- **Must NEVER claim:** that a high rank = a confirmed bug; that fixing the shared cause is *guaranteed* to fix
  every sharing test (it is a hypothesis to check); that a single opaque number captures severity (show the axes).

### Candidate B — **Cause-trajectory trend** (NEW / REGRESSED / RECOVERING / CHRONIC / CAUSE-SHIFTED across runs)

DW already reads side-cars across runs with a `runId`. Add a **run-ordered diff** that classifies each test's
(and each cause's) trajectory vs prior runs:
- **NEW** — this cause appeared this run; **REGRESSED** — was green, now failing with cause X;
  **RECOVERING** — was failing, now green; **CHRONIC** — failing ≥ N runs with the same cause;
  **CAUSE-SHIFTED** — still failing but the *mode* changed (e.g. `covered-by-overlay` → `settle-timeout`),
  which is a richer signal than "red again."
- Honestly surfaces `unsure → cause` and `cause → unsure` transitions (DW *gained/lost* the ability to explain
  a failure), never hides them.

- **Real vs reskin:** **REAL at the cause layer.** Allure/RP/Datadog trend **pass/fail**; DW trends the
  **taxonomy code**. "Regressed *and* its cause shifted from overlay to settle-timeout" is a diagnosis-grade
  trend line incumbents can't draw without the per-action cause.
- **Contracts:** DW-03 (a trajectory is *observed history, not a prediction*; correlation with a commit is
  **not** causation — DW must not claim a change *introduced* the cause); DW-02 (a `RECOVERING`/green label
  never overrides PW's current verdict).
- **Must NEVER claim:** that a NEW cause was *caused by* a specific commit; that CHRONIC = a confirmed real bug
  (could be a chronic environment); that a trajectory predicts the next run.

### Candidate C — **DW-native CI annotations** (GitHub Checks: action + cause + confidence, level-mapped to confidence)

A thin emitter turning existing side-cars into **GitHub Actions Check annotations** anchored at the failing
action's authored file/line: *"step 4 click → `covered-by-overlay` (suspected, geometry-only) — hit-point
occupied by `<div.modal-backdrop>`."* The honest twist competitors structurally can't match: **annotation
level is mapped to DW's confidence band** — `confirmed`→failure-adjacent, `suspected`→**warning**,
`unsure`→**neutral notice** ("DW could not explain — human triage"). Calibrated certainty, inline in the PR,
where reviewers actually look.

- **Real vs reskin:** **PARTIAL — the reskin trap is real here.** PW's `github` reporter *already* annotates
  failures, so "annotate the failure" alone **is** a reskin. The non-reskin core is annotating the **CAUSE +
  CONFIDENCE** (which PW lacks) and **mapping annotation level to the confidence band** (honest uncertainty
  inline). If it degenerates to re-printing the PW error at `failure` level, it violates the firewall — do not
  ship that.
- **Contracts:** DW-02 (**never** emit a `failure`-level annotation that reads as *DW* failing the test — PW
  owns pass/fail; DW annotations are advisory `warning`/`notice`); DW-04 (`unsure` → a "needs human" notice,
  never a fabricated cause).
- **Must NEVER claim:** an annotation level above what the confidence warrants; a cause on a passing test; that
  the annotated line is where the *bug* is (it is where the failing *action* is authored).

---

## 4. Feasibility

| Candidate | Reuses | Effort | Risks |
|---|---|---|---|
| **A — Priority queue** | `FlakeReport` + `categoryTotals` (extend to per-*code* distinct-test clusters) + confidence bands; pure function, **no new input**; renders into the existing dashboard + `renderReport` | **S–M.** MVP clusters on taxonomy **code** (already present in every record). Stretch: cluster on `covered-by-overlay` *covering-element* signature — needs the delta's `coveredBy` label surfaced into the side-car (small side-car addition). | The **only** real risk is the honesty one: a combined score can *look* decisive. Mitigate by construction — decomposed/auditable rank, `unsure` in its own lane, no opaque number. Low technical risk (pure, offline, deterministic). |
| **B — Cause-trajectory** | side-car `runId` + taxonomy diff; new run-ordered aggregation | **M.** | **Run ORDERING is a genuine gap** — `runId` is today just the containing-dir basename (`readSidecars`), an *unordered set*. Trends need a real ordinal/timestamp; garbage order → garbage trend. This gates B below A. |
| **C — CI annotations** | side-cars + a `::error/::warning/::notice` workflow-command (or Checks API) emitter | **S–M.** | **Reskin proximity** to PW's `github` reporter (differentiation lives entirely in cause+confidence+level-mapping). Checks API has a **50-annotations/request** cap + PR-only inline visibility → needs batching + a summary fallback for the ≤50 overflow. |

---

## 5. Ranked recommendation

**Top pick: Candidate A — the Actionability Priority queue.**

It is the most direct answer to the block's question — *what makes a DW report DRIVE ACTION rather than
display data* — because it decides **what to fix first** and shows **why**. It is the cheapest and safest to
build (a pure function over the `FlakeReport` DW already produces, offline and deterministic, **no new data
source and no run-ordering dependency**), and its differentiator — **ranking by shared root-cause blast
radius** (fix-once-fix-many, clustered on the action-scoped taxonomy) — is genuinely un-owned: Datadog/
BuildPulse can only sort by frequency/CI-time because they never had DW's per-action cause. It also lets DW
*use* its honesty asset offensively — `unsure` becomes an explicit **"route these N failures to a human"**
lane rather than a bucket, without ever inflating confidence or hiding uncertainty.

**Order:** **A** (highest leverage, lowest risk, purest anti-reskin) → **C** (highest *reach* — lands in the
PR flow — but narrower differentiation vs PW's `github` reporter) → **B** (valuable cause-level trends, but
gated on a run-ordering primitive DW lacks today).
