# Deltawright — consolidated findings & backlog (~a week of experiments)

**Compiled 2026-07-20.** Everything found across 4 dogfooding studies — a diagnosis demo, a test-authoring
study, a nightly-flake RCA, and a suite-hardening run (all on a real legacy-GWT enterprise Playwright
suite) — in one place so nothing is lost. Source of truth for the "features + bugs" the research must not
miss. (Target-specific evidence — test IDs, environment names — is kept out of this public repo and lives
in local notes; the generic feature/bug value is preserved here.)

---

## A. The honest verdict (what the experiments proved)
- **DW is a strong, differentiated DIAGNOSIS / triage layer** — precise (0 hard false positives, 100%
  precision on what it names), honest (abstains rather than guesses), and it says things Playwright can't
  ("covered-by `div.gwt-PopupPanelGlass`", "backend 500 co-occurred", "input-not-committed"). **This is
  DW's proven keep-strength.**
- **DW is NARROW as an authoring / hardening enhancer** — 3–4 real GWT-pathology features, poorly packaged,
  sitting next to a large body of "better/faster tests" that is **plain Playwright discipline DW doesn't
  own**. The hardening run showed suite-speed is ~85% a Playwright job; DW's one differentiated lever
  (structural quiescence settle) is unproven on GWT background churn.
- **DW is NOT a test generator** — `suggest()` degrades to `page.locator('div')` on the common
  (text-in-descendants) node shape.
- Quantified proof points: offline named ~13–14/80 failures (100% precise); live reclassification
  underdelivered (net +1 on a degraded environment); the target suite had hand-rolled 3 DW primitives by
  hand (~300 lines in a base page-object inherited by ~140 page objects); ~566s of blind `sleep()` (~15% of
  a light test's wall-clock); a global networkidle "smart-settle" REGRESSED client-side-settle tests.

---

## B. BUGS found (fix in the DW repo)
| id | bug | severity |
| --- | --- | --- |
| **B1** | Reporter **`not-visible` over-labeling** — spams `not-visible (confirmed)` ~25× for one failure; ~49/54 aggregate rollups | HIGH |
| **B2** | **routeSignals not window-scoped** — ~3/5 findings were ambient-RPC distractors, not causal | MED |
| **B3** | **`input-not-committed` + `suspected-miss-empty` double-code** for one never-committed cause | LOW |
| **B4** | **ESM-only exports** block CJS Playwright consumers (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — every consumer needs a dynamic-import shim | HIGH (adoption) |
| **B5** | `release.yml` has no `concurrency:` group → a tag push spawned duplicate racing runs | LOW (fix-forward) |

## C. IMPROVEMENTS found (detection / diagnosis — DW's strength)
| id | improvement | why | value |
| --- | --- | --- | --- |
| **I1** | **Detect backend errors riding HTTP-200 bodies** (not just status≥400) | legacy portals wrap faults in 200s → invisible to the route arm (reproduced in a lab fixture) | HIGH |
| **I2** | **Capture overlays appearing DURING the action** (not only at preflight's probe) | preflight caught 0/13 live because the GWT overlay appears mid-action | HIGH |
| **I3** | **First-class "backend-not-ready" route** — expose `hitMaxWait && !quiescent` as a signal | turns "flaky test" into "backend/data — route to infra" | HIGH |
| **I4** | **Broaden live instrumentation past the click funnel** + instrument all test projects | failing clicks bypass the one wrapped funnel; one project was missed entirely | MED |
| **I5** | **Console-error scan arm** (offline over the trace / live `page.on('console')`) | surfaces in-trace leads DW currently walks past | MED |
| **I6** | **diagnose-trace "waited-for-absent-element" hint** | a bare `waitForSelector` timeout → `unsure` offline; the failed action IS the selector | MED |
| **I7** | **`suggest()` on container / text-in-descendants nodes** — derive a name from the salient text descendant | today yields a non-durable `page.locator('div')` | HIGH |

## D. ENHANCER / DX gaps (authoring — the pivot target)
| id | gap | note | value |
| --- | --- | --- | --- |
| **E1** | **Ergonomic wrappers** — `dwFill(locator,value)` + `toHaveCommittedValue(intended)` + `dwClick(locator)` (preflight+settle+click) | the MISSING authoring product; input-integrity must be hand-wired today | HIGH |
| **E2** | **`dwWaitForVisible(locator,{awaitQuiescence})`** — quiescence-gate + routed diagnosis on timeout | the target suite's #1 flake was literally `waitForSelector .popupContent` | HIGH |
| **E3** | **Durable/unique selector intelligence** from the LIVE page (role+geometry+text+stability) | the durable-selector problem `suggest()` explicitly punted | HIGH |

## E. RESEARCH themes (novel — the deep-think blocks in this folder)
| id | theme | crux |
| --- | --- | --- |
| **R1** | **Wait-free readiness** — know an action's effect has landed/stabilized WITHOUT static sleep or networkidle | THE crux; must beat both, not rebrand networkidle → `01-wait-free-readiness.md` |
| **R2** | **Spatial + semantic page model** ("screenshot-equivalent") richer than the a11y/DOM snapshot | representation + how it makes authoring smoother → `02-spatial-page-model.md` |
| **R3** | **Durable selector intelligence** (= E3 as a research question: algorithm + honesty) | unique+stable from live DOM+geometry → `03-durable-selectors.md` |
| **R4** | **Competitive landscape / the genuine gap** across PW/Cypress/TestCafe/Selenium + AI-visual tools | avoid reinventing; find what DW can own → `04-competitive-gap.md` |

## F. Proven strengths to PRESERVE (do not regress)
covered-by-overlay geometry precision · honest abstention · triage compression (cluster look-alikes) ·
inline-in-Playwright-report (`attachDiagnosis`) · routeSignals backend/app/DOM routing · input-integrity
fault detection · the closed taxonomy + confidence bands · "observe/label, never fabricate/retry/suppress".

## G. Deferred experiment (separate from this research)
**Healthy-environment value-run re-run** — the live-reclassification thesis was measured on a degraded
environment; a fair re-run needs a healthy window.
