# Deltawright flake corpus (#51)

The labeled **ground truth** for the accuracy harness (#52). It exists to turn "accurate" into
a measurable number without cheating — so precision can't be inflated by an author who picked
both the DOM and the label.

> **Honesty stamp.** All numbers derived from this corpus are **corpus-relative**: "Deltawright
> diagnoses correctly on a DOM we *assert* resembles the failure mode." That is **not**
> real-production precision, which stays **blocked on #25/#41** (the owner's real apps). This is
> a **seed** (~36 cases); real-app expansion pairs with #25.

## The three independent oracles

Ground truth is never a stored Deltawright output (the `CorpusCase` schema has no field for one;
`load.ts` guards against it). Each case carries up to three **independent** oracles:

1. **Real Playwright action outcome** (`verdict`) — the reality anchor. A `live` case runs the
   fixture through `actAndObserve`, so the delta's verdict is Playwright's own judgement, not a
   saved blob. Validates the **verdict** (DW-02), not the diagnosis code.
2. **Construction manifest** (`code` + `confidence`) — hand-authored, asserting the intended
   **true** root cause. This is the label the harness scores the engine's diagnosis against.
3. **`window.__truth`** — fixture instrumentation for **hidden causes** the DOM alone doesn't
   reveal (which reveal was triggered, wave counts, scheduled repositions).

**Mandatory near-miss confuser per code.** Every taxonomy code has a positive case AND a
`confuser` — a superficially-similar DOM whose correct label is *different* (e.g. an overlay
*near* a button vs *over* it). A confuser-free, one-fixture-per-code corpus is a strawman.

`live` cases use real DOM fixtures (`fixtures/reveal.html` + reused `test/fixtures/*`); `delta`
cases feed a hand-built `Delta` for causes not cleanly reproducible live this cycle (honesty-
stamped, weaker reality anchor).

## Coverage (18/18 codes; 36 cases: 22 live, 14 delta)

Each code has **1 positive + 1 confuser**. The **engine behavior** column records what
`diagnose()` *actually* emits today, discovered by live probe — the corpus labels the **true**
cause and #52 measures the engine against it, so the gaps below are visible, not hidden.

| Code | Positive source | Engine behavior today |
|---|---|---|
| `covered-by-overlay` | live (overlay over button) | ✅ `covered-by-overlay` / confirmed |
| `off-screen` | live (fixed, clipped above viewport) | ✅ `off-screen` / confirmed |
| `not-visible` | live (`visibility:hidden`) | ✅ `not-visible` / confirmed |
| `pointer-events-none` | live (`pointer-events:none`) | ⚠️ **mislabeled `covered-by-overlay`** — Playwright reports a generic "intercept"; geometry has the true reason. Precision gap. |
| `disabled` | live (disabled button) | ⚠️ **`geom-disagreement`** — geometry can't see `disabled`, so `agreed=false`; a flag, not a wrong confirmed. Recall gap. |
| `read-only` | live (readonly input) | ⚠️ **`geom-disagreement`** — same class as `disabled`. Recall gap. |
| `unstable-animating` | delta | (delta) — live CSS-animation reproduction is future work |
| `geom-disagreement` | live (disabled button) | ✅ `geom-disagreement` / suspected (the code it *does* emit for the disabled/readonly class) |
| `background-churn` | delta (dominant `droppedBackground`) | ✅ `background-churn` / suspected |
| `detached-re-render` | live (target removed + replaced) | ⚠️ **not emitted** — no `ref-staleified` signal in the Delta yet. Silent miss. |
| `settle-timeout` | live (churning page, low `maxWaitMs`) | ✅ `settle-timeout` / suspected |
| `suspected-miss-empty` | delta (empty + cap) | ✅ `suspected-miss-empty` / unknown |
| `late-wave-suspected` | live (`lateWatchMs`) | ✅ `late-wave-suspected` / suspected |
| `stale-rect-suspected` | live (`rectRecheckMs`) | ✅ `stale-rect-suspected` / suspected |
| `injection-blocked` | delta | ⚠️ **not emitted** — CSP injection failure isn't surfaced as a code yet |
| `cross-boundary-partial` | delta | ⚠️ **not emitted** — skipped cross-origin frame / closed shadow root isn't surfaced yet |
| `pixel-region-fallback` | live (canvas + `screenshotFallback`) | ⚠️ **not emitted** — the pixel-region node is in the delta but `diagnose()` doesn't map it to the code yet |
| `unknown` | delta (agreed, unattributable) | ✅ first-class unsure |

## Known engine gaps this corpus surfaces (for #52 and follow-ups)

The probe found four honest gaps between the taxonomy and what the engine emits from real pages:

1. **`pointer-events-none` → `covered-by-overlay` (precision).** Playwright's error for a
   `pointer-events:none` target is a generic "intercepts pointer events", so PW-cause-wins picks
   `covered-by-overlay` even though geometry has the specific cause and nothing covers it. Fix:
   prefer geometry's specific self-cause when Playwright's "intercept" has no corroborating cover.
2. **`disabled` / `read-only` / `unstable-animating` → `geom-disagreement` (recall).** These are
   Playwright-only causes geometry can't see, so `agreed=false` routes them to `geom-disagreement`.
   Fix: emit the Playwright-named cause from the disagreed branch too (it doesn't contradict the
   verdict — it *is* the verdict's reason). Both are `feat/diagnose` follow-ups, not corpus fixes.
3. **`detached-re-render` (silent).** Needs a `ref-staleified` signal added to the Delta.
4. **`injection-blocked` / `cross-boundary-partial` (silent).** Need capture-integrity signals
   plumbed from `inject.ts` / frame+shadow traversal into the Delta.
5. **`pixel-region-fallback` (unmapped).** The screenshot-diff already produces a pixel-region
   node; `diagnose()` just needs to map that node to the code (a small, safe addition).

**Net: the engine emits ~9 of the 18 codes well today** (`covered-by-overlay`, `off-screen`,
`not-visible`, `geom-disagreement`, `settle-timeout`, `suspected-miss-empty`, `background-churn`,
`late-wave-suspected`, `stale-rect-suspected`), with the rest documented above. That is exactly
why diagnosis capabilities are **gated** behind the harness floor (#52): the corpus makes the
gaps measurable before any capability ships on top of them.

## Running

`bench/flake-corpus/load.ts` exposes the corpus + invariant checks; `test/corpus.spec.ts`
enforces per-code coverage, the confuser requirement, and the independent-oracle rule. The
harness that scores `diagnose()` against these labels is **#52** (`npm run bench:accuracy`).
