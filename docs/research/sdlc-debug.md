# R-debug — deepening DW's proven strength (failure diagnosis / root-cause routing)

**Block:** DEBUG (of the SDLC research charter). **Surface:** `diagnose` / `diagnose-trace` /
live-routing. **Mandate:** make DW's *differentiated* strength MATERIALLY more useful without
over-claiming causation (co-occurrence ≠ cause, DW-03). No code in this pass — evidence + ranked
candidates only.

**Grounding (code read):** `src/host/diagnose.ts`, `src/host/taxonomy.ts`, `src/host/confidence.ts`,
`src/host/summarize.ts`, `src/host/synthetic-delta.ts`, `src/trace/read-trace.ts`,
`src/trace/diagnose-trace.ts`, `src/trace/routing.ts`, `src/host/live-routing.ts`,
`src/host/actAndObserve.ts`; the v0.8 recon (`docs/plans/v0.8-diagnose-trace-plan.md`); trace fixtures
under `test/fixtures/traces/`.

---

## 1. State of the art — how teams debug Playwright failures today (cited)

**The trace viewer is the incumbent.** A `trace.zip` is a single archive the viewer stitches from
synchronized streams: an **action timeline** (every command + timing + status), **before/action/after
DOM snapshots**, a **network panel** (every request with status/headers/timing/bodies), a **console
panel** (page console + `pageerror`), **source**, and an optional **screenshot filmstrip**
([Playwright trace-viewer](https://playwright.dev/docs/trace-viewer),
[TraceLoom](https://traceloom.io/blog/debug-playwright-failures-with-traces/),
[TestDino](https://testdino.com/blog/playwright-trace-viewer)). Capture is intentional: `on-first-retry`
in CI, `retain-on-failure`, or `retain-on-failure-and-retries` for "flake forensics"
([Playwright tracing](https://playwright.dev/docs/api/class-tracing),
[OneUpTime](https://oneuptime.com/blog/post/2026-01-28-playwright-tracing/view)).

**What the trace viewer does NOT do — the manual gap.** It *presents* five synchronized streams and
leaves the human to correlate them. It never fuses "the failing action produced no DOM effect" with
"a 5xx fired in that same action's window" into a verdict; it never separates *"the element never
rendered"* from *"the element rendered but was blocked"* (both surface as a `TimeoutError`); it never
labels a cause or abstains. The friction reported in practice is *operational* (finding/storing/opening
the right zip) *and* interpretive (reading the timeline for "misordered steps, unexpected navigations,
retries") — a human-in-the-loop scan
([TraceLoom](https://traceloom.io/blog/debug-playwright-failures-with-traces/),
[TestDino debug guide](https://testdino.com/blog/debug-playwright-tests)).

**RCA / observability approaches.** The frontier is (a) **flaky-vs-real classification** and (b)
**frontend↔backend correlation**:
- *Flaky-vs-real:* teams re-run (`--repeat-each=20`), and modern tools classify a failure into buckets
  — *Actual Bug / UI Change / Flaky / Environment* — often with a confidence number ("Actual Bug — 92%")
  ([BrowserStack flaky](https://www.browserstack.com/guide/playwright-flaky-tests),
  [TestDino flaky](https://testdino.com/blog/playwright-flaky-tests),
  [Parasoft ML triage](https://www.parasoft.com/blog/ml-powered-test-failure-analysis/),
  [Ranger](https://www.ranger.net/post/ai-test-failure-analysis-how-it-works)). ~46.5% of flakes are
  resource-affected (CPU/mem/IO), and a dominant real-failure pattern is *"backend took longer under
  parallel load"* — a **network/backend** root cause wearing a **DOM-timeout** costume
  ([TestDino pass-locally-fail-CI](https://testdino.com/blog/playwright-test-failure)).
- *Frontend↔backend correlation:* OpenTelemetry context-propagation ties a click to the backend span
  via trace-id, so an observability backend can link a UI failure to backend logs — but only for teams
  who have instrumented **both** ends
  ([OneUpTime correlate](https://oneuptime.com/blog/post/2026-01-15-correlate-frontend-backend-traces-react/view),
  [Elastic](https://www.elastic.co/observability-labs/blog/web-frontend-instrumentation-with-opentelemetry)).
- *Dashboards:* Currents does health/orchestration but "**no AI failure classification** … and **no error
  grouping**"; Testomat/TestDino add classification + clustering by message/stack
  ([TestDino Currents-alternatives](https://testdino.com/alternatives/best-currents-alternatives),
  [Currents AI post](https://currents.dev/posts/fixing-playwright-tests-with-ai)).

**Playwright's own signal for "never appeared vs blocked".** The call-log already carries the
distinction — `no elements matching …` (never resolved) vs `resolved to …` then `waiting for element to
be visible` (resolved, stayed blocked) — but **surfaces it only as raw log text** the human reads; no
tool turns it into a *cause class*
([WebCrawlerAPI](https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-click-timeout-not-visible),
[Playwright actionability](https://playwright.dev/docs/actionability)).

**Net state-of-the-art:** rich raw evidence (trace) + generic ML/LLM buckets over logs/screenshots +
opt-in OTel correlation. **Missing:** an *action-scoped, deterministic, honesty-gated* layer that
correlates the failing action's own DOM/network/console window into a **routable** verdict and
**abstains** rather than guessing. That is precisely DW's un-owned territory.

---

## 2. DW's real gap (grounded in the code)

DW already leads on *offline DOM-actionability attribution* and *honest abstention*. The gaps are in
**evidence sourcing**, not in the diagnosis engine:

1. **The offline network channel is blind by construction.** `readTraceZip` reads only `*.trace`
   members (`read-trace.ts:534`, `n.endsWith('.trace')`). Every `trace.zip` also ships a `*.network`
   member (confirmed: `trace.network` in `covered.trace.zip`; `0-trace.network` in the test-runner
   fixture) — **DW never opens it.** Offline routing therefore sources backend signal *only* from
   harness `stdout`/`stderr` **text** (`scanHarness`, `read-trace.ts:251`). But on most CI runs the
   backend 5xx/`ECONNREFUSED` is recorded in the trace's **structured network stream**, not echoed to
   the runner's stdout. So the exact class the field data says dominates real failures — *"a backend
   fault presenting as a DOM timeout"* — is the class the **offline** arm most often **misses**. The
   code comments already flag this asymmetry honestly ("The offline arm is capped by what a trace
   records — a legacy app that swallows its JS errors leaves the in-page channel empty",
   `live-routing.ts:2`). The **live** arm already has the structured channel (`response` /
   `requestfailed` with `net::ERR_ABORTED` client-abort exclusion + action-window scoping,
   `live-routing.ts:215-229`). **Offline lacks the live arm's best evidence source even though the
   trace recorded it.**

2. **"Never rendered" collapses into "unsure".** `looksDetached` (`synthetic-delta.ts:17`) catches
   `no element matching` / `not attached` and routes it to a dead-end *"no cause fabricated"*
   (`diagnose-trace.ts:123`). That is honest, but it **throws away a real, distinct signal**: an element
   that *never materialized* is a different failure class (route to an upstream step / data / navigation)
   than one that *rendered but was blocked* (actionability). DW has no code for it; the closed taxonomy
   (`taxonomy.ts:55`) has no *membership/existence* bucket for the target.

3. **The per-action DOM snapshots are read for one field only.** DW parses `frame-snapshot` events but
   collects **only value-bearing fields** for input-integrity (`read-trace.ts:427`,
   `collectSnapshotFields`). The `before@`/`after@` snapshot **pair** — DW's own core asset (an
   action-scoped delta) rendered offline — is otherwise unused. (Full geometry offline is **out of
   scope**: the v0.8 recon confirmed snapshots store tag/attrs/text but **no per-node rects**, so
   geometry needs a live re-render — `docs/plans/v0.8-diagnose-trace-plan.md`. Any snapshot candidate
   must be *structure-only*, never a geometry claim.)

4. **Console is context-only, unclassified.** Offline routing lists console but only a `pageerror` flips
   a hint (`routing.ts:94`) — correct anti-cry-wolf design, but the console text is never *bucketed*
   (null-deref vs network-echo vs framework-warning) to sharpen the route. Lower-value; noted, not a
   headline candidate.

---

## 3. Candidate capabilities (action-granularity + closed taxonomy, genuinely differentiated)

### Candidate A — **Trace-native network correlation** (offline `resource-snapshot` window-fused routing)  ★ top pick

Read the trace's own `*.network` member. Parse its `resource-snapshot` events (each carries a
request/response snapshot: method, URL, **status**, and a monotonic time). **Window-correlate** them to
the failing action's `[startTime, endTime]` window — the same window `deriveRouting` already computes
(`routing.ts:87-96`) — and mirror the *live* arm's rules exactly: a status ≥ 400 or a non-abort failed
request **in the failing action's own window** flips `suspectedBackendCause`; a `net::ERR_ABORTED`
client-abort is **excluded** (page cancelled its own request, not infra); DW-named-a-DOM-cause suppresses
the flip. Output stays a **routing hint**, not a taxonomy code.

- **Why differentiated (not a reskin):** the trace viewer's network *panel* lists **all** requests for
  the **whole test** and leaves correlation to the human. DW's value is the **fusion**: *DW named no DOM
  actionability cause* **AND** *a 5xx co-occurred in THIS action's settle window* → **"suspected backend
  — route, don't self-heal the selector."** That is action-granularity + the DOM-cause verdict, not a
  request list. It also brings **offline↔live parity** to the channel the field data says matters most
  (backend-fault-as-DOM-timeout), which today's offline arm silently misses.
- **The honest anti-reskin firewall:** must never become an OTel/APM. It reports *"N HTTP error
  response(s) co-occurred in this action's window (all origins) — WEIGH as a possible backend signal"* —
  the exact wording the live arm already ships (`live-routing.ts:175`). Page-wide + all-origin means it
  can see a third-party 404; that width is **disclosed**, never upgraded to "the backend caused it".

### Candidate B — **"waited-for-absent" separation** (new closed-taxonomy code: `target-never-materialized`)  ★ most differentiated

Split today's dead-end detached path into two honest outcomes using two primitives DW already has:
(i) the **call-log phrasing** — `no elements matching` / `waiting for locator … to be visible` after a
`resolved to` line (`read-trace.ts` `extractCauseLine`, `synthetic-delta.ts` `looksDetached`); and
(ii) **snapshot corroboration** — walk the failing action's `after@` `frame-snapshot` (DW already parses
these) and check whether the target *selector key* (id/name) is **present** in the serialized DOM. When
the log says never-resolved **and** the snapshot confirms the target absent → emit a NEW code
`target-never-materialized` (bucket: a new `membership-attribution`/existence sub-case), `suspected`.
When it resolved-but-stayed-hidden → the existing actionability path is unchanged.

- **Why differentiated:** **no incumbent structurally separates "never rendered" from "rendered-but-
  blocked"** — both are a `TimeoutError`, and the ML/LLM tools bucket them together as "UI Change / Flaky"
  ([TestDino](https://testdino.com/blog/playwright-flaky-tests),
  [Parasoft](https://www.parasoft.com/blog/ml-powered-test-failure-analysis/)). This is the deepest use
  of the **closed taxonomy**: a genuinely new *cause class*, not a relabel.
- **What it must NEVER claim:** *why* the target is absent (a prior step failed, a nav didn't happen, a
  backend didn't return data) — those are **routing**, not this code. The code asserts only *"the target
  the action referenced was not present in the after-snapshot's DOM"* — a membership fact, `suspected`,
  never `caused-by`. Governed by **DW-04** (a new code ⇒ ADR + corpus relabel + accuracy-harness re-run +
  the frozen `test/taxonomy.spec.ts` lock).

### Candidate C — **Offline action-effect presence** (structure-only before→after "did anything change?")

The deferred v0.8 DOM-diff in its **honest light form**: for the failing action (or the last action),
compare `before@` vs `after@` `frame-snapshot` *node counts / a coarse structural signature* — **not**
geometry, **not** a full delta. Two honest outputs: an offline analogue of `suspected-miss-empty` ("the
action's before/after snapshots are structurally identical → the action may have been a no-op") and a
positive corroboration ("the action did produce a structural effect"). Exploits per-action snapshots (DW's
asset) offline.

- **Why differentiated:** the trace viewer shows both snapshots but never *diffs* them into a semantic
  "the action changed nothing" signal.
- **Fragility (why it ranks third):** the snapshot format uses incremental back-references (`[[n,m]]`,
  already handled-by-skipping in `collectSnapshotFields`), which the v0.8 recon flagged as the "large,
  fragile" part. A count-level signature is achievable but noisy; must stay `suspected` and abstain on any
  unresolved reference rather than manufacture a false "no-op".

**Explicitly OUT:** offline **geometry** (`covered-by-overlay` / `off-screen` reconstructed from a trace)
— snapshots carry no rects; recovering them needs a live re-render, which breaks the "no browser"
contract. The v0.8 recon already ruled this out; re-proposing it would violate the firewall.

---

## 4. Honest real-vs-reskin check (per candidate)

| Candidate | Contract it respects | Real (not a reskin) because… | Must NEVER claim |
|---|---|---|---|
| **A — trace-native network** | DW-02 (verdict untouched), DW-03 (co-occurrence ≠ cause) | It's **action-window-scoped fusion** with the DOM-cause verdict → a route/self-heal decision, not a request list. Not a trace-viewer network panel; not OTel (no instrumentation, no trace-id, offline). Emits **no taxonomy code** — pure routing metadata. | "the backend **caused** this failure"; that a third-party/all-origin 4xx is *the* cause; anything that overrides Playwright's outcome. |
| **B — waited-for-absent** | DW-04 (closed taxonomy, ADR-governed), DW-03 | A genuinely **new cause class** grounded in two real primitives (call-log phrasing + snapshot membership). Not a self-healing locator (it does NOT re-query or fix the selector); not "UI Change" hand-waving. | *why* the element is absent; any `confirmed` claim (reconstructed ⇒ clamped `suspected`); that the selector is "wrong" (it may be right and the element upstream-missing). |
| **C — action-effect presence** | DW-03, and the `diagnose-trace` **suspected-clamp** (`confidence.ts:74`) | Diffs the **action's own** snapshots into a "did the action do anything" signal — DW's action-scoped-delta asset, offline. Not a screenshot/visual diff. | any structural count as a **geometry** or **occlusion** claim; a confident "no-op" (must abstain on unresolved refs). |

Every candidate keeps the load-bearing honesty invariants already in the code: reconstructed-offline ⇒
**clamped to `suspected`** (`diagnose-trace.ts:132`); `unsure` is a **first-class** outcome
(`summarize.ts`); routing **emits no taxonomy code and touches no verdict** (`live-routing.ts:23`).

---

## 5. Feasibility (reused primitive · effort · risks)

| Candidate | Reuses | Effort | Key risks |
|---|---|---|---|
| **A** | `deriveRouting` window logic (`routing.ts:53-96`) + the live arm's rules (status≥400, `ERR_ABORTED` exclusion, `domCauseNamed` suppression, list-and-clamp, path/query redaction) verbatim; `readTraceZip` gains a `*.network` member read + a `resource-snapshot` case. The version-guard (`SUPPORTED_TRACE_VERSIONS`) already protects format drift. | **S–M.** Mostly wiring an existing, *already-validated* model to a new source; the offline `RoutingReport` shape already has the fields. | Undocumented `*.network` event shape + version migration (mitigated: existing hard version-guard, and abstain-on-unparseable). Privacy: reuse the existing query-strip + snippet cap (`live-routing.ts` `urlPath`/`snippet`) so no raw URL/PII leaks. Monotonic-time alignment between `.network` and `.trace` clocks (fall back to the existing next-action-start right edge if absent). |
| **B** | `looksDetached`/`isActionabilityError` (`synthetic-delta.ts`), the snapshot walker (`collectSnapshotFields`), `summarizeDiagnoses`, the taxonomy table + `capConfidence`. | **M.** The classification split is small; the **DW-04 governance** (ADR + corpus relabel + harness re-run + taxonomy-lock update) is the real cost. | Precision over recall (a legacy app with dynamic ids can defeat id/name membership → must abstain, not guess). Snapshot back-reference resolution (skip → abstain). Must not regress the existing detached path's honesty. |
| **C** | `frame-snapshot` parsing, the `suspected-miss-empty` code (already exists), the suspected-clamp. | **M–L.** | Highest fragility (back-references, incremental snapshots); noisiest signal; risk of a false "no-op". Ship only if A+B land and a corpus shows real yield. |

---

## 6. Summary + ranked top pick

**Ranking:** **A (trace-native network correlation) ≫ B (waited-for-absent) > C (action-effect
presence).**

**Top pick — Candidate A.** It is the highest-leverage, lowest-risk, most-honest upgrade to DW's proven
strength. It closes a gap the code *itself already documents* as a known offline↔live asymmetry: every
`trace.zip` ships a `*.network` member that DW never opens, so the **offline** arm is blind to exactly
the failure class the field evidence says dominates real (non-flaky) CI failures — a backend fault
presenting as a DOM timeout. Candidate A sources that channel from the trace's **own** structured network
stream and fuses it, **action-window-scoped**, with DW's DOM-cause verdict into a **route-vs-self-heal**
recommendation — reusing the *already-live-validated* rules (status≥400, client-abort exclusion,
`domCauseNamed` suppression, redaction, list-and-clamp) verbatim. It stays pure routing metadata: **no
new taxonomy code, no verdict touched, co-occurrence never causation** (DW-02/03), so it carries **zero
DW-04 governance cost** and no honesty risk. Effort is S–M (wiring a validated model to a new source
behind the existing version-guard). Candidate **B** is the most *conceptually* differentiated — a cause
class ("never rendered" vs "blocked") no incumbent surfaces — and is the natural **second** step, but it
spends DW-04 governance and needs a corpus relabel, so it should follow A. Candidate **C** is the
fragile, defer-until-proven option. Offline **geometry** stays firmly out (needs a re-render — firewall).
