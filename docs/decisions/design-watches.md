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

### DW-01 · Settle detection is a heuristic — re-validate its tunables per page shape
- **Rule:** Before trusting a delta on a new kind of page/interaction, confirm the settle tunables (`quietMs`, `maxWaitMs`, `animMaxMs`) actually capture the change. Treat `stats.hitMaxWait && nodes.length === 0` as a SUSPECTED MISS, not a confident empty delta.
- **Applies when:** a plan/diff adds a new interaction, animation pattern, lazy-load, or debounced handler; or changes settle logic.
- **Why:** Settle is the #1 risk (§6). Too early misses the change; too late is slow. CSS transitions move geometry without firing mutations. (→ ADR 2026-07-07 settle heuristic)
- **Not mechanical because:** "did we wait the right amount" depends on the page's runtime behavior, not on any static property.
- **Retire when:** v0.5 ships robust settle detection (mutation-quiescence + Playwright auto-wait + network-idle, corpus-validated) with a regression suite.
- **Status:** active

### DW-02 · The delta's actionability verdict MUST equal the real Playwright action
- **Rule:** Any change to the actionability probe or the geometry read must preserve the invariant that ACTIONABLE ⇔ a real Playwright action would succeed, and that Playwright's verdict wins. New probes must be validated with a verdict-matches-reality test (real action, not just trial).
- **Applies when:** editing `src/host/actionability.ts`, the trial-probe choice, or the geometry read that feeds the reason string.
- **Why:** Closing the gap between "what the agent thinks it can click" and "what Playwright will click" is most of the target 60% failure. A parallel verdict that drifts recreates the gap. (→ ADR 2026-07-07 reuse actionability)
- **Not mechanical because:** alignment is a semantic property of two engines agreeing on real pages, not a type or lint rule.
- **Retire when:** Playwright exposes a first-class "explain actionability" API we can consume directly, removing the trial-probe reconciliation.
- **Status:** active

## Retired
_(none yet)_
