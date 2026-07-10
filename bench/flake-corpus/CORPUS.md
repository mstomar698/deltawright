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
| `pointer-events-none` | live (`pointer-events:none`) | ✅ `pointer-events-none` / suspected (#71 fix — geometry's self-cause preferred over Playwright's generic "intercept") |
| `disabled` | live (disabled button) | ✅ `disabled` / confirmed (#71 geometry-blind recovery — geometry can't see `disabled` so `agreed=false`, but Playwright's authoritative cause is recovered from the disagreed branch) |
| `read-only` | live (readonly input) | ✅ `read-only` / confirmed (#71 — same geometry-blind recovery as `disabled`) |
| `unstable-animating` | delta | ✅ `unstable-animating` / confirmed (#71 recovery; delta — live CSS-animation reproduction is future work) |
| `geom-disagreement` | live (covered fillable input) | ✅ `geom-disagreement` / suspected (a GENUINE disagreement on a geometry-VISIBLE cause: Playwright can `fill` a covered input, geometry sees the cover — NOT recovered, unlike the geometry-blind class) |
| `background-churn` | delta (dominant `droppedBackground`) | ✅ `background-churn` / suspected |
| `detached-re-render` | live (target removed + replaced) | ⚠️ **not emitted** — no `ref-staleified` signal in the Delta yet. Silent miss. |
| `settle-timeout` | live (churning page, low `maxWaitMs`) | ✅ `settle-timeout` / suspected |
| `suspected-miss-empty` | delta (empty + cap) | ✅ `suspected-miss-empty` / unknown |
| `late-wave-suspected` | live (`lateWatchMs`) | ✅ `late-wave-suspected` / suspected |
| `stale-rect-suspected` | live (`rectRecheckMs`) | ✅ `stale-rect-suspected` / suspected |
| `injection-blocked` | delta | ⚠️ **not emitted** — CSP injection failure isn't surfaced as a code yet |
| `cross-boundary-partial` | delta | ⚠️ **not emitted** — skipped cross-origin frame / closed shadow root isn't surfaced yet |
| `pixel-region-fallback` | live (canvas + `screenshotFallback`) | ✅ `pixel-region-fallback` / suspected (#71 fix — the pixel-region node is now mapped) |
| `unknown` | delta (agreed, unattributable) | ✅ first-class unsure |

## Known engine gaps this corpus surfaces (for #52 and follow-ups)

The probe found gaps between the taxonomy and what the engine emits from real pages. **Three
fixes have shipped** (tracked in #71):

- ✅ **`pointer-events-none` (was mislabeled `covered-by-overlay`).** When the target's own
  `pointer-events:none` is why the hit misses (Playwright reports a generic "intercept" and
  `elementFromPoint` returns the element behind), the engine now names `pointer-events-none`.
- ✅ **`pixel-region-fallback` (was unmapped).** `diagnose()` now maps the screenshot-diff
  pixel-region node to the code.
- ✅ **`disabled` / `read-only` / `unstable-animating` (was `geom-disagreement`; recall).** These
  are Playwright-only causes geometry is structurally BLIND to, so the node reads
  geometry-actionable (`agreed=false`). The engine now RECOVERS the Playwright-named cause from
  the disagreed branch (geometry's dissent is blindness, not counter-evidence — it doesn't
  contradict the verdict, it *is* the verdict's reason). Limited to the geometry-blind set: a
  dissent on a geometry-VISIBLE cause stays `geom-disagreement`. ADR 2026-07-10.

Remaining gaps (open in #71):

1. **`detached-re-render` (silent).** Needs a `ref-staleified` signal added to the Delta.
2. **`injection-blocked` / `cross-boundary-partial` (silent).** Need capture-integrity signals
   plumbed from `inject.ts` / frame+shadow traversal into the Delta.

**Net: the engine now emits ~14 of the 18 codes well** (the four geometry-visible blocking codes,
the three geometry-blind blocking codes, `pixel-region-fallback`, `geom-disagreement`, and the
five delta/stats-level codes), with the three silent-miss codes above remaining. That is exactly
why diagnosis capabilities are **gated** behind the harness floor (#52): the corpus makes the gaps
measurable before any capability ships.

## Running

`bench/flake-corpus/load.ts` exposes the corpus + invariant checks; `test/corpus.spec.ts`
enforces per-code coverage, the confuser requirement, and the independent-oracle rule.

The accuracy harness (**#52**) that scores `diagnose()` against these labels is live:
**`npm run bench:accuracy`** (`bench/run-accuracy.ts`; pure scorer in `score.ts`). It is
**reporting-first** — only the LIVE verdict-vs-reality subset < 100% (a DW-02 regression) fails the
run; precision and silent-miss are reported while #71's remaining signals land (ADR 2026-07-10).
Verdict-vs-reality is split by case kind: only the live cases exercise Playwright's real verdict
(the gate); delta verdicts are authored self-consistency. Latest run:

```
verdict-vs-reality LIVE (DW-02 gate):  100.0%  (16/16)  PASS
verdict self-consistency (delta):      100.0%  (10/10)  [authored, not reality]
confirmed-band precision:              100.0%  (7 correct / 0 wrong)   [reported]
recall:                                 83.3%  (15/18)
silent-miss rate:                       16.7%  (3/18)                  [reported]
```

The three silent misses are exactly the open #71 gaps (detached-re-render, injection-blocked,
cross-boundary-partial) — surfaced as `✗ SILENT`, by design. `test/accuracy.spec.ts` guards the
scorer contract + the DW-02 floor (browser-free delta integration + a live smoke).
