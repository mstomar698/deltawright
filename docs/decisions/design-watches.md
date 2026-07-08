# design watches

Judgment-only, repo-specific rules that must gate future plans/reviews and that a
linter/CI cannot mechanically catch. Cap ~10–12 active. Every watch needs a
**retire-when**. Retired watches move to the bottom section.

<!-- Template:
### DW-NN · <one-line rule>
- **Rule:** <what to verify before approving a plan/diff>
- **Applies when:** <trigger>
- **Why:** <incident — what it cost> (→ ADR <YYYY-MM-DD>)
- **Not mechanical because:** <why a linter/CI can't catch this>
- **Retire when:** <the structural fix or CI gate that subsumes this watch>
- **Status:** active
-->

### DW-02 · The delta's actionability verdict MUST equal the real Playwright action
- **Rule:** Any change to the actionability probe or the geometry read must preserve the invariant that ACTIONABLE ⇔ a real Playwright action would succeed, and that Playwright's verdict wins. New probes must be validated with a verdict-matches-reality test (real action, not just trial).
- **Applies when:** editing `src/host/actionability.ts`, the trial-probe choice, or the geometry read that feeds the reason string.
- **Why:** Closing the gap between "what the agent thinks it can click" and "what Playwright will click" is most of the target 60% failure. A parallel verdict that drifts recreates the gap. (→ ADR 2026-07-07 reuse actionability)
- **Not mechanical because:** alignment is a semantic property of two engines agreeing on real pages, not a type or lint rule.
- **Retire when:** Playwright exposes a first-class "explain actionability" API we can consume directly, removing the trial-probe reconciliation.
- **Status:** active

### DW-04 · The root-cause taxonomy is closed and versioned
- **Rule:** Every diagnosis Deltawright emits is one of the codes in `src/host/taxonomy.ts` or `unknown`. Adding, removing, or renaming a code requires, IN ORDER: an ADR, a corpus relabel (`bench/flake-corpus/`, #51), and an accuracy-harness re-run (#52) — then, as the deliberate last step, updating the frozen SHA lock in `test/taxonomy.spec.ts`. Each code must stay grounded in ≥1 real `PrimitiveSignal`; `catch-all` is reserved for `unknown`.
- **Applies when:** editing `src/host/taxonomy.ts`, `docs/specs/v0.6-root-cause-taxonomy.md`, or any code that maps signals to a diagnosis code (the #48 engine and every diagnosis surface).
- **Why:** Six planned diagnosis surfaces must speak ONE vocabulary or the "single accurate place" drifts into dialects; an ungrounded or ad-hoc code is how a confidently-wrong label ships. (→ ADR 2026-07-08 root-cause taxonomy)
- **Not mechanical because:** the SHA lock catches a *changed* set, but "is the new code grounded in a real signal and reflected in the corpus + harness" is a semantic judgement a hash cannot make.
- **Retire when:** the taxonomy has been real-app-calibrated (#25/#41) and stable across a full release, and the corpus+harness gate subsumes the manual review.
- **Status:** active

## Retired

### DW-01 · Settle detection is a heuristic (retired 2026-07-07)
- **Was:** re-validate settle tunables per page shape; treat `hitMaxWait && 0 nodes` as a suspected miss.
- **Retired because:** #13 shipped robust **structural-quiescence** settle (resolves on
  structural quiet, ignoring non-structural background churn) with a regression suite
  (`test/settle.spec.ts`), benchmark-validated (live-page settle 2000 ms → ~155 ms, no
  cap, capture preserved). The suspected-miss surfacing is built into the serializer.
- **Residuals moved to #15** (causal attribution): a non-structural (attr/text-only)
  effect on a live page, and element-adding background churn (toasts/virtualized lists),
  are still not perfectly isolated.
