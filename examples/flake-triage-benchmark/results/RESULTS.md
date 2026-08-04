# Results — Deltawright usefulness on a ~300-test Playwright suite

Ground-truth experiment against the **published `deltawright@1.1.0`** (installed from npm). A 296-test
parameterized Playwright suite over a synthetic 6-flow app with **seeded fault injection**, scored against
a machine-readable manifest of what should fail and why. Two adoption bands, two scenarios, one control.

**Bottom line — the assessment's hypothesis is confirmed.** The zero-edit triage/reporting layer delivers
high, honest value for ~a config line and is scenario-independent; the per-test primitives deliver a narrow
but uniquely-DW win (the silent input-commit class) that the zero-edit band structurally cannot see.

**Full matrix (3 realistic runs, 370 failure records — `harness/score-matrix.mjs` → `results/matrix.json`):**
**0** hard false-positives · **100%** precision (144/144) · clusters `off-screen×30` + `covered-by-overlay×18`
**stable across all 3 runs, both `confirmed`**, 0 false merges · priority `#1 off-screen #2 covered` (true
order) · **18 flaky tests** separated by frequency (7 fail 2/3, 11 fail 1/3, none 3/3). Shareable writeup:
the "Deltawright ground-truth experiment — results" artifact.

---

## Setup (all reproducible)

- **App**: `server/` — login · dashboard · record · modal · wizard · settings, with 9 injectable faults.
- **Suite**: 296 tests (`suite/control/`), parameterized `flows × cases × data`. Same titles drive the
  greenfield arm so the injected fault is identical.
- **Profiles**: `clean` (all green — harness proof: **296/296 pass**), `faults` (deterministic injection).
- **Ground truth**: `ground-truth/manifest.json` — 124 hard-injected across 7 causes (+ 1 slow trap, 1 flaky).
- **DW cost knob**: `DW=1` toggles the *one* reporter line in `playwright.config.ts` (the zero-edit band).

Under the `faults` profile the control suite: **112 failed / 184 passed** — and **20 `input-debounce-clear`
tests PASS silently** (the debounce wipes the value after the assertion reads it; a green-but-broken bug the
control cannot catch).

---

## Band 1 — zero-edit (reporter + `aggregate` + `diagnose-trace`) · ~1 config line

Scored by `harness/score.mjs` vs ground truth (112 failures → 112 side-cars):

| Metric | Result |
|---|---|
| **Hard false-positives** (named a wrong cause) | **0** ✅ — the non-negotiable gate held |
| **Precision** of causes DW named | **48 / 48 = 100%** (30 `off-screen` + 18 `covered-by-overlay`) |
| **Abstention** (`unsure` → human lane) | **64 (57%)** — correctly, on failures with no passively-nameable DOM cause |
| **Clustering** | `off-screen×30`, `covered-by-overlay×18`, **64 unsure singletons**, **0 false merges** ✅ |
| **Priority fix-first order** | **#1 `off-screen`(30), #2 `covered-by-overlay`(18)** — matches true blast-radius order ✅ |

**What it named vs abstained (all correct):** it named exactly the failures that surfaced as genuine
Playwright *actionability* errors (covered / off-screen) and honestly abstained on the rest — `disabled`
(expressed as a `toBeEnabled` assertion, not a click), input value-diffs, backend/app-JS timeouts, and the
slow-settle trap. **Zero false positives**, including on the `rpc-settle` honesty trap (8 failures → all
`unsure`, never a fabricated DOM cause).

**`diagnose-trace` (offline) — an honest boundary found.** On the 12 `backend-500` failures the trace's
`*.network` member *does* contain the 500, and DW surfaces it as **context** (`console-error … status 500`)
— but it does **not** auto-route to backend. Reason, verified in the trace: the 5xx fired at t=64747, the
*failing* action's window is `[64749.6, …]` — the 500 co-occurred with the **succeeding click** that
triggered the save, ~2.6 ms *before* the assertion that timed out. DW correctly correlates to the *failing*
action's window and refuses to over-attribute. The network route fires when the 5xx lands inside the failing
action's own window (a Submit whose own request 5xxes); a click-then-assert pattern puts it one action early.

## Band 2 — per-test primitives (greenfield / retrofit) · per-test cost

The same fault classes the zero-edit band couldn't name, with the primitives applied. Clean run: **66/66
pass** (no false positives from the primitives). Under `faults`:

| Primitive | Fault class | Result |
|---|---|---|
| `toHaveCommittedValue` | `input-debounce-clear` (20) | **all 20 caught** as `never-committed` — the class the control shipped **green** |
| `toHaveCommittedValue` | `input-mask-truncate` (16) | **all 16 caught** as `truncated` |
| `preflight` | `covered-overlay` (18) | named **`covered-by div.glass`** at the assertion site |
| `preflight` | `disabled-stuck` (12) | named **`disabled`** at the assertion site (where the control gave a bare `toBeEnabled` failure, and the zero-edit reporter → `unsure`) |

**The headline contrast — `record > notes` (debounce-clear):** control = 20 tests, **0 failures (silent
bug shipped)**; greenfield with `toHaveCommittedValue` = **20 failures caught, named `never-committed`.**

---

## Verdict by scenario

**Existing ~300-test suite (retrofit).** Turn on the zero-edit reporter (1 line) → 100%-precise, 0-FP cause
labels + fix-first clustering on all 300 tests, no test edits. `diagnose-trace` adds backend/app context on
the trace artifacts you already keep. Then retrofit `toHaveCommittedValue`/`preflight` onto the flaky
input/actionability subset to convert silent + mislabeled failures into loud, named ones. **Highest ROI is
the zero-edit band; the per-test band is a targeted, high-value add on the specific fault classes it uniquely
sees.**

**New ~300-test suite (greenfield).** Same free zero-edit layer, and the per-test primitives baked into the
base page object catch the silent input-commit class from day one (0 false positives observed). The
incremental win over the existing-suite scenario is precisely the pre-emptive input/actionability hardening.

## Band 1b — cross-run flake trends (`aggregate` over N runs) · zero-edit

Ran the `flaky` profile (only `flaky-appear` fires: the table loads after a random 0–1200 ms vs an 800 ms
budget) **×5** into separate run dirs, then `aggregate` across all five (read-only, **no reruns of its own**):

- Per run: **8 / 9 / 6 / 8 / 6** of the 20 flaky-load tests failed — a different random subset each time.
- Aggregated: **37 failure records across 18 distinct flaky tests**, ranked by cross-run frequency —
  3 tests fail in **4/5** runs, 2 in 3/5, 6 in 2/5, 7 one-offs (`{4:3, 3:2, 2:6, 1:7}`). None in all 5.
- All labeled **`unsure`** — correct: a "renders late" timeout has no nameable DOM cause, so DW abstains and
  lets the **cross-run frequency** be the flake signal (never a fabricated cause).

So the zero-edit band also delivers honest **flake-frequency triage from existing side-cars**, distinguishing
the persistently-flaky (4/5) from the one-off (1/5) — the input the priority/quarantine decision needs.

## Band 3 — `diagnose-trace` network route, fair test (delayed 5xx inside the failing window)

The earlier boundary was that a click-then-assert pattern puts the 5xx ~2.6 ms *before* the failing action's
window. Added a **`backend-slow-500`** variant (the detail API delays ~500 ms then returns 500, so the 5xx
arrives *inside* the failing assertion's window) and a `record > fetch detail` flow:

- **One-shot fetch (the debounce-style pattern): NOT routed — and that's correct.** A resource-snapshot is
  timestamped at **request initiation** (`_monotonicTime`), which for a click-triggered fetch falls inside
  the *click's* window. Verified: the 500 fired at t=1331, the failing assertion's window is `[1335, 6338]`
  — the request initiated **4 ms before** the assertion began. DW correlates to the *failing* action and so
  surfaces the 500 as **console-error context**, never an over-attributed route (DW-03).
- **Polling / retry pattern (the realistic backend-error UI): ROUTED.** When the UI *polls* the endpoint
  while waiting (every 200 ms, each 500), the 5xx request-starts keep landing **inside** the failing
  assertion's window. `diagnose-trace` then correctly fires:
  > `routing: SUSPECTED not-a-DOM-cause … route to BACKEND — the trace recorded 8 HTTP error response(s)
  > [status 500] in this action's own window (all origins) — prefer routing over self-healing the selector.
  > Co-occurrence, not proof.`

**Precise scope of the v1.1 network route:** it fires when 5xx request-*initiations* fall inside the failing
action's window (a poll/retry loop, or a failing action that itself initiates the request) and stays silent
(context only) for a one-shot fetch initiated by a preceding, succeeding action. This is conservative and
correct — DW never manufactures a route — and it means the feature's yield depends on the test's action
topology, not just on whether a 5xx occurred.

## Honest limits this surfaced

1. The zero-edit passive reporter names only genuine Playwright **actionability** errors; assertion-diffs
   and timeout-for-absent failures correctly → `unsure` (you need the per-test band to name them).
2. `diagnose-trace`'s network route requires the 5xx inside the **failing** action's window; a
   click-then-assert pattern leaves it as context, not a route.
3. `input-debounce-clear` is only caught by the per-test `toHaveCommittedValue` — no zero-edit path sees it.

## Artifacts

- `harness/score.mjs` — the scorer (run: `node harness/score.mjs faults-dw`).
- `results/faults-dw-sidecars/` (112) · `results/greenfield-dw-sidecars/` · `test-results/**/trace.zip` (112).
- `ground-truth/manifest.json` — the scoring ground truth. `PLAN.md` — the full design.
