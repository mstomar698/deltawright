# context · deltawright · 2026-07-07

## what this repo does
Deltawright is a delta-and-actionability layer for Playwright agents. Instead of
re-dumping accessibility snapshots, it turns one action into a compact structured
delta of what changed on the page, where it is, and whether it is actionable —
reusing Playwright's own actionability judgment so the verdict matches reality.

## architecture, in 5 bullets
- `src/injected/observer.ts` · injected page script (bundled to an IIFE): one MutationObserver, the coalescer, the settle heuristic, per-node geometry + `elementFromPoint`, `data-dw-ref` stamping. Installs `window.__deltawright`.
- `src/host/inject.ts` · esbuild-bundles the page script and installs it idempotently via `addScriptTag`.
- `src/host/actAndObserve.ts` · the primitive: arm → act (Playwright) → settle → collect → annotate → `Delta`.
- `src/host/actionability.ts` · reconciles geometry vs Playwright `click({trial:true})`; Playwright wins; disagreements flagged.
- `src/host/serialize.ts` · renders the compact §3 text delta and counts tokens (`gpt-tokenizer`, cl100k proxy).

## test runner & commands
- run all: `npm test` (Playwright test: coalescer units + north-star validation)
- run one: `npx playwright test test/northstar.spec.ts`
- typecheck: `npm run typecheck`
- demo (the proof): `npm run demo`

## conventions
- Public API is whatever `src/index.ts` exports; keep it stable.
- kebab-case files/dirs; `SCREAMING_SNAKE` constants; explicit types on public functions.
- Membership of the delta is mutation-derived only; geometry is annotation, never a filter.

## no-go zones
- `src/host/actionability.ts` — do not add a parallel actionability verdict that can override Playwright.
- `src/injected/observer.ts` `readGeometry`/`coalesce` — do not turn `elementFromPoint`/rect into a membership filter.

## relevant to current task
- `docs/specs/ideation-agent-delta-layer.md` · binding design doc (§3/§5/§6/§7/§10).
- `docs/plans/v0.1-milestone.md` · the plan every changed line traces to.
- `test/fixtures/northstar.html` · the three controlled cases.

## active design-watches
- DW-02 · actionability verdict must equal the real Playwright action — verify alignment when changing the probe or geometry read.
- (DW-01 retired — #13 shipped robust structural-quiescence settle + regression suite.)

## open questions
1. none blocking for v0.1.
