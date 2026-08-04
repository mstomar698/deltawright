# Experiment: Deltawright usefulness on a ~300-test Playwright suite

**Question.** Measured from the *published* `deltawright@1.1.0` (npm), how useful is DW across two adoption
bands — the **zero-edit** triage/reporting layer vs. the **per-test** primitives — in two scenarios:
retrofitting an **existing** suite vs. authoring a **new** one, both ~300 Playwright tests, against a
no-DW **control**.

Derived from `dw-usefulness-report` (the third-party assessment). The hypothesis to falsify: *the zero-edit
triage/reporting layer clears its bar in both scenarios for ~a config line; the per-test hardening primitives
show narrow, real flake wins concentrated on masked-input / RPC-settle tests; the testgen/authoring aids move
the needle only in the greenfield arm.*

The whole point is **ground truth**: we inject a known set of faults, so every DW label can be scored
precision/recall against what actually failed and why — not vibes.

---

## 1. The target app (`server/`)

A self-contained SPA + a tiny mock backend (`node:http`, no deps), reproducing the pathologies DW targets,
with **deterministic, seed-controlled fault injection** so runs are reproducible.

**Flows (the surface the ~300 tests exercise):**
1. **Login** — form, a submit disabled until both fields valid.
2. **Dashboard** — a data table: filter, sort, paginate, row actions.
3. **Record form** — masked/debounced inputs (card, phone), an async Save → mock API.
4. **Modal workflow** — a confirm dialog over a look-alike control (occlusion).
5. **Wizard** — 3 steps, each gated on an async "validate" call.
6. **Settings** — toggles, a live-region status announcement.

**Injectable faults (the ground truth catalog).** Each is keyed to a `fault profile` the server serves
per `?seed=` / a header, so a run is reproducible; a separate `flaky` profile randomizes timing to produce
genuine cross-run flakiness. Every fault maps to a DW taxonomy expectation:

| Fault id | Injected behavior | True category (ground truth) |
|---|---|---|
| `covered-overlay` | a glass `div` covers the real Save; a look-alike sits beside it | `covered-by-overlay` (actionability) |
| `offscreen` | target rendered below the fold, no scroll-into-view | `off-screen` (actionability) |
| `disabled-stuck` | Submit never enables (validation bug) | `disabled` (actionability) |
| `input-debounce-clear` | a 200ms debounce clears the typed value | `input-not-committed` (outcome) |
| `input-mask-truncate` | a mask truncates past N chars | `input-not-committed` (outcome) |
| `rpc-settle` | Save's effect lands 400–900ms later; a bg poller keeps networkidle busy | slow-but-correct → *should NOT be a hard fault* (settle) |
| `backend-500` | the Save API returns 500 | backend (routing, not a DOM cause) |
| `app-js-error` | the click handler throws | app-JS (routing) |
| `flaky-appear` | the result element appears after random 0–1200ms | genuinely flaky (timing) |
| `clean` | nothing injected | pass (control for false-positives) |

**Honesty controls built into the catalog:** `clean` + `rpc-settle` (correct-but-slow) exist specifically
to catch **false positives** — DW must not name a cause on these.

## 2. The suite (`suite/`)

~300 tests **parameterized** over `flows × scenarios × data-variants` (via `test.describe` loops), the way
real large suites are built — not 300 bespoke files.

- `suite/control/` — **plain Playwright, no DW.** The baseline, and the "existing suite" we later retrofit.
- `suite/greenfield/` — **DW-native**, primitives baked into `suite/support/BasePage`.
- `suite/support/` — page objects + the parameter tables that generate the cases.

The **retrofit arm** = control + the DW zero-edit reporter (config only) + a per-test-primitive pass on a
**fixed flaky subset** (the tests hitting `input-*`, `rpc-settle`, `covered-overlay`).

## 3. Runs

- **Clean run** (profile `clean`): the suite goes green → proves the harness + measures baseline.
- **Fault run** (profile `faults`): the injected catalog fires → deterministic, known failures.
- **Flaky run** (profile `flaky`, N=5): randomized timing → real flakiness for clustering/trends.

Each run emits: Playwright results (JSON), `trace.zip`s (retain-on-failure), and — once DW is wired —
`*.deltawright-sidecar.json` side-cars.

## 4. Metrics (`harness/score.mjs`, scored vs `ground-truth/manifest.json`)

| Band | Metric | Passing bar |
|---|---|---|
| Adoption cost | files/LOC/config touched + wall-clock, per band | zero-edit ≈ 1 config line |
| Triage precision | of injected faults, % labeled with the **correct** cause vs `unsure` vs **wrong** | high recall, **0 wrong on `clean`/`rpc-settle`** |
| Honesty gate | hard false-positive count · `unsure`-rate | **FP ≈ 0** (non-negotiable) |
| Clustering | injected distinct causes vs emitted clusters — no false merges, no false splits | ≥ correct partition, 0 cross-code merges |
| Reporting | does the priority top-K cover the true highest-blast-radius causes? | top-K = the K widest injected causes |
| Hardening | flake-rate on the retrofit subset, before vs after primitives | measurable drop on `input-*` / `rpc-settle` |

## 5. Deliverable

`results/RESULTS.md` — numbers per band per scenario + a verdict that confirms or falsifies the hypothesis,
and a recommendation (triage-product-first vs authoring-toolkit) grounded in the measured cost/ROI.

## 6. Faithfulness notes

- Uses the **published** `deltawright@1.1.0` from npm (not local source) — the true adopter experience.
- Fully **generic + offline**: synthetic app, mock backend, no ICE/PII, no external network. Safe to keep here.
- Reproducible: seeds fix the fault timing; the flaky profile is the only randomized one (that's the point).

## Phases (tracked as tasks #130–#137)

1. Scaffold + this plan · 2. Fixture app + mock backend · 3. Control suite (~300) + green run ·
4. Ground-truth manifest + fault runs · 5. DW zero-edit band · 6. DW per-test band + greenfield ·
7. Metrics harness · 8. Run + results report.
