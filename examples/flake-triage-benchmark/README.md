# Example — flake-triage benchmark

A **runnable, ground-truthed** example of Deltawright wired into a realistic ~300-test Playwright suite. It
exists so you can *see* DW working — not just read about it — and reproduce the numbers yourself.

A synthetic 6-flow app (login · dashboard · record · modal · wizard · settings) with **9 seed-injectable
faults**, driven by a 299-test parameterized suite, scored against a machine-readable manifest of exactly
what should fail and why. Fully offline and synthetic (no real data, no external network).

## Run it

```bash
cd examples/flake-triage-benchmark
npm install
npx playwright install chromium          # once

# 1) clean profile → the suite is green (harness proof)
FAULT_PROFILE=clean npx playwright test --project=control

# 2) faults profile, DW reporter ON (the whole "zero-edit" cost is one config line, DW=1)
FAULT_PROFILE=faults DW=1 RUN_ID=faults npx playwright test --project=control

# 3) the zero-edit triage/reporting band over the side-cars it just wrote
npx deltawright aggregate --clusters results/faults-sidecars
npx deltawright aggregate --priority results/faults-sidecars

# 4) the per-test band (toHaveCommittedValue + preflight) catches the SILENT input-commit bugs
FAULT_PROFILE=faults DW=1 npx playwright test --project=greenfield

# 5) score every DW label against ground truth
node harness/score.mjs faults
```

## What each piece shows

| Path | Demonstrates |
|---|---|
| `playwright.config.ts` | the **one line** that turns on DW — `['deltawright/reporter', …]`, gated by `DW=1` |
| `suite/control/` | a plain-Playwright suite (the *existing-suite* / control) — no DW in the tests |
| `suite/greenfield/hardened.spec.ts` | the **per-test band** — `toHaveCommittedValue` + `preflight` in real tests |
| `server/` | the fixture app + mock backend with the injectable faults |
| `harness/score*.mjs` | scores DW's output (side-cars, clusters, priority) vs `ground-truth/manifest.json` |
| `results/RESULTS.md` | **the full write-up + measured findings** — start here for the outcome |

## Headline results (from `results/RESULTS.md`, 3 realistic runs / 370 records)

- **Zero-edit band** (≈ 1 config line, scenario-independent): **0 hard false-positives**, **100% precision
  (144/144)**, clusters `off-screen×30` + `covered-by-overlay×18` **stable + `confirmed`** (0 false merges),
  priority `#1 off-screen #2 covered` (the true blast-radius order), and **18 flaky tests separated by
  cross-run frequency** — all without reruns. 61% honest `unsure` abstention.
- **Per-test band**: `toHaveCommittedValue` caught **20 silent `debounce-clear` bugs the control ships green**
  (as `never-committed`) + 16 mask (`truncated`); `preflight` named `covered-by div.glass`×18 + `disabled`×12.
- **Honest boundary**: `diagnose-trace`'s network route fires when a 5xx's request lands *inside* the failing
  action's window (polling/retry) and stays *context* for a one-shot fetch — conservative, never a false route.

> Everything here is synthetic and offline. Regenerate any run with the commands above.
