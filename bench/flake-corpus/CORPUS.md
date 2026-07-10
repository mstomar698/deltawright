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

## Coverage (18/18 codes; 36 cases: 24 live, 12 delta)

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
| `detached-re-render` | live (target removed + replaced) | ✅ `detached-re-render` / suspected (#71 fix #3 — the observer counts a freshly-added subtree detached in-window; the original nets out but the transience is surfaced as a delta-level note) |
| `settle-timeout` | live (churning page, low `maxWaitMs`) | ✅ `settle-timeout` / suspected |
| `suspected-miss-empty` | delta (empty + cap) | ✅ `suspected-miss-empty` / unknown |
| `late-wave-suspected` | live (`lateWatchMs`) | ✅ `late-wave-suspected` / suspected |
| `stale-rect-suspected` | live (`rectRecheckMs`) | ✅ `stale-rect-suspected` / suspected |
| `injection-blocked` | live (`<meta CSP script-src 'none'>`) | ✅ `injection-blocked` / confirmed (#71 fix #4b — addScriptTag is blocked, so actAndObserve degrades to an empty delta carrying `stats.injectionBlocked`; the failure is authoritatively observed) |
| `cross-boundary-partial` | live (CSP-uninjectable child frame) | ✅ `cross-boundary-partial` / suspected (#71 fix #4a — `armChildFrames` counts skipped uninjectable frames into `stats.crossBoundarySkipped`; closed shadow roots are structurally uncountable, so skipped frames are the honest signal. A same-origin CSP-uninjectable child stands in for the cross-origin case, which pairs with #25) |
| `pixel-region-fallback` | live (canvas + `screenshotFallback`) | ✅ `pixel-region-fallback` / suspected (#71 fix — the pixel-region node is now mapped) |
| `unknown` | delta (agreed, unattributable) | ✅ first-class unsure |

## Known engine gaps this corpus surfaces (for #52 and follow-ups)

The probe found gaps between the taxonomy and what the engine emits from real pages. **All six #71
fixes have now shipped** (each with an independent adversarial review before merge):

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
- ✅ **`detached-re-render` (was silent).** A freshly-added subtree that is inserted and then
  DETACHED again within the settle window (a re-render / list-virtualization swap) nets out of the
  reported delta entirely (added-then-removed), so its transience was invisible. `coalesce` now
  COUNTS those in-window detaches (zero added latency — it already walks the added set) into a
  default-absent `stats.detachedReRender`, which `diagnose()` maps to `detached-re-render`
  (suspected — an add-then-detach can also be a benign transient). The count honors the same
  `bgInsert` background quarantine as the delta itself (a recurring background toast does NOT trip
  it). **Scope:** the in-window add-then-detach sub-case only — a keyed-list reorder, a detach
  inside a shadow root / child frame, and a re-render AFTER collect are out of scope. ADR 2026-07-10.
- ✅ **`injection-blocked` (was silent).** When a strict CSP (`script-src 'none'`) blocks
  `addScriptTag`, the observer cannot be injected. `actAndObserve` now DEGRADES instead of throwing:
  it still performs the action, then returns an empty delta carrying `stats.injectionBlocked`, which
  `diagnose()` maps to `injection-blocked` (**confirmed** — the injection failure was authoritatively
  observed). Verified LIVE against a `<meta CSP>` fixture. ADR 2026-07-10.
- ✅ **`cross-boundary-partial` (was silent).** During `frames:true` traversal, `armChildFrames`
  already catch-skips cross-origin / uninjectable child frames; it now COUNTS those skips into
  `stats.crossBoundarySkipped`, which `diagnose()` maps to `cross-boundary-partial` (suspected — a
  boundary was skipped, but whether a change hides behind it is unknown). Closed shadow roots are
  structurally uncountable (`el.shadowRoot` is `null`), so skipped frames are the honest signal.
  Runs LIVE against a child frame whose srcdoc CSP blocks injection (a same-origin stand-in for the
  cross-origin case, #25), so the real skip-counting path is exercised, not a hand-authored stat.
  ADR 2026-07-10.

**All #71 diagnosis gaps are now closed.** No taxonomy code is a silent miss on this seed.

**Net: the engine now emits all 18 codes** (the four geometry-visible blocking codes, the three
geometry-blind blocking codes, `pixel-region-fallback`, `geom-disagreement`, `detached-re-render`,
the two capture-integrity codes, and the five delta/stats-level codes). That is exactly why
diagnosis capabilities are **gated** behind the harness floor (#52): the corpus made every gap
measurable, and each closed with an independent adversarial review before shipping. With recall at
100% / silent-miss at 0%, the precision + silent-miss floors have been **ratcheted from reported to
hard-gated** (ADR 2026-07-10, superseding the reporting-first decision).

## Running

`bench/flake-corpus/load.ts` exposes the corpus + invariant checks; `test/corpus.spec.ts`
enforces per-code coverage, the confuser requirement, and the independent-oracle rule.

The accuracy harness (**#52**) that scores `diagnose()` against these labels is live:
**`npm run bench:accuracy`** (`bench/run-accuracy.ts`; pure scorer in `score.ts`). **Three floors now
hard-fail the run**: DW-02 (the LIVE verdict-vs-reality subset must be 100% with ≥1 live oracle),
confirmed-band precision ≥95%, and silent-miss ≤5%. Verdict-vs-reality is split by case kind: only
the live cases exercise Playwright's real verdict (and gate); delta verdicts are authored
self-consistency (never gated). Latest run:

```
verdict-vs-reality LIVE (DW-02 gate):    100.0%  (16/16)  PASS
verdict self-consistency (delta):        100.0%  (10/10)  [authored, not reality]
confirmed-band precision (gate ≥95%):    100.0%  (8 correct / 0 wrong)  PASS
recall (labeled cause emitted):          100.0%  (18/18)
silent-miss rate (gate ≤5%):               0.0%  (0/18)  PASS
```

All 18 codes emit and all three floors pass with headroom. `test/accuracy.spec.ts` guards the scorer
contract + the ratcheted gate (a precision/silent-miss regression test) + live smokes (the
detached-re-render background-quarantine regression, the CSP injection-blocked degrade, and the
uninjectable-child-frame cross-boundary path). The floors are **corpus-relative** — they keep the
engine in lockstep with the corpus, not with real production (blocked on #25/#41).
