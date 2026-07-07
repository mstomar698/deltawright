<!-- Keep this PR small and traceable. -->

Plan: docs/plans/<slug>.md
<!-- If there is no plan yet for non-trivial work, write one first. -->

## What shipped
<one paragraph — what this PR does>

## What did NOT ship (and why)
- <thing> — <punted / blocked / out-of-scope>

## What is next
- <next slice / follow-up issue / open question>

## Plan trace
<!-- Map each changed area to a plan slice; note any orphan lines. -->
- A1 → <files> ✓

## Reviewer checklist
- [ ] `npm run typecheck` clean
- [ ] `npm test` green (no regressions)
- [ ] Every changed file is in the plan's scope (no scope creep)
- [ ] Delta membership stays mutation-derived (geometry never used as a filter) — DW-02 / DW-01 respected
- [ ] Playwright remains the authoritative actionability verdict
- [ ] Public contracts in `src/index.ts` unchanged, or the break is called out above
- [ ] Commits are Conventional Commits and signed off (`-s`, DCO)
