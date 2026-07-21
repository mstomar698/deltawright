# SDLC-usefulness research — synthesis

Cross-block synthesis of the five SDLC research reports (`sdlc-testgen.md`, `sdlc-hardening.md`,
`sdlc-debug.md`, `sdlc-triage.md`, `sdlc-reporting.md`), against the charter
(`SDLC-RESEARCH-CHARTER.md`). **No-action pass** — this ranks directions and flags traps; it commits to no
build. The next chapter's plan is chosen from here.

---

## 1. The through-line, independently reconfirmed five times

Each block, researching its own surface and its own competitors, landed on the **same** un-owned asset the
charter named: **action granularity** — DW's deterministic, honesty-gated model of *what changed because of
the specific action just taken*. The competitive picture is identical across surfaces:

- **testgen** — codegen records *actions but not assertions* (the open oracle problem); AI agents
  re-serialize the *whole page* each step. Nobody maps an *observed transition* to an assertion.
- **hardening** — Playwright core + the flake ecosystem own the timing/rerun classes; nobody models
  *this action's* value-commit or re-render race in a single run.
- **debug** — the trace viewer *presents* five streams and leaves correlation to the human; ML tools bucket
  generically. Nobody fuses the failing *action's* DOM verdict with its *own* network window.
- **triage** — incumbents group on **test identity / text signature / source path**. Nobody groups on the
  observed structural *mechanism*.
- **reporting** — incumbents classify at *test / launch* granularity and rank by *frequency*. Nobody ranks by
  *shared per-action cause blast-radius*.

The wedge is the same everywhere: **legacy / poor-a11y / heavy-RPC apps** where the a11y tree degrades and
`networkidle` never settles, but geometry, hit-testing, the delta, and the trace's structured streams never
degrade.

## 2. The five top picks at a glance

| Block | Top pick | Reuses (shipped) | Effort | Anti-reskin strength | New DW-04? |
|---|---|---|---|---|---|
| **hardening** | **`toHaveCommittedValue(intended)`** — loud input-commit gate | `input-integrity.ts` (`classifyInput`/`LOSS_SHAPES`) *verbatim* + post-settle read | **S** (smallest) | **Strongest of all** — Playwright has *zero* analog | No |
| **testgen** | **delta→assertion synthesis** — state-transition assertions | `suggest→verifySuggestions→scoreSelectors` pipeline; delta `stateChanges`/`ariaLive`/`kind` | **S–M** | High — no tool maps an aria-transition→assertion | No |
| **triage** | **cause-clustering** on (taxonomy-code × delta-fingerprint) | `checksum`/`normalizeDelta` + taxonomy + read-only aggregator | **M** | High — structural key, not text/stack/test-id | No |
| **reporting** | **Actionability Priority queue** — rank by shared-cause blast-radius × confidence | `FlakeReport` + `categoryTotals`; pure function | **S–M** | High — blast-radius, not frequency | No |
| **debug** | **trace-native network correlation** — read the `*.network` member | `deriveRouting` window + live-routing rules *verbatim* | **S–M** | High — action-window fusion, not a request list / OTel | No (routing metadata) |

**Notable:** every top pick reuses an already-shipped, already-tested primitive and **none requires a new
taxonomy code** (debug's more-differentiated runner-up B *would*, which is why it ranks second). This is a
packaging/composition chapter, not a from-scratch one — the same shape as the authoring-enhancer chapter.

## 3. The hidden structure — one substrate unlocks two blocks

The five picks are **not** five independent efforts. There is a dependency spine:

```
             ┌────────────────────────────────────────────────┐
             │  SIDE-CAR ENRICHMENT (small, self-contained):   │
             │  persist checksum(delta) fingerprint            │
             │  + coveredBy covering-element label             │
             │  + the opt-in live routing report               │
             └───────────────┬───────────────┬────────────────┘
                             │               │
              triage T1 ─────┘               └───── reporting A
        (cluster by code × fingerprint)   (rank clusters by blast-radius × confidence)
                             │
              triage T3 (route clusters by cause-domain) ── folds ── debug A (network signal)
```

- **triage T1 and reporting A are the same clustering engine seen from two angles.** T1 *builds* the
  root-cause clusters (code × fingerprint); reporting A *ranks* them by distinct-test blast-radius × confidence
  and puts `unsure` in its own lane. Reporting A's own report calls its MVP "cluster on taxonomy code" — which
  is exactly T1's Level-1 partition. **Ship them as one substrate: enrich the side-car → cluster → rank.**
- The single enabling change both need is **persisting `checksum(delta)` in the side-car** (today computed and
  thrown away). That is the highest-leverage piece of plumbing in the whole set: it also feeds triage T3 and
  reporting A's stretch (cluster on the covering-element signature).
- **debug A strengthens the offline diagnosis that seeds every side-car** the triage/reporting layer consumes,
  and its network-routing signal folds directly into triage T3's cause-domain routing. So debug A is upstream
  value for the suite-scale story too, not only a standalone debug win.
- **hardening H1 and testgen A are independent, orthogonal leaves** — each a small matcher/suggest extension
  over a shipped pure function, with no cross-dependency. They can ship anytime, in parallel, first.

## 4. Recommended sequence (waves)

**Wave 1 — the two sharp, self-contained leaves (fastest, lowest-risk, ship in parallel).**
1. **`toHaveCommittedValue(intended)`** (hardening H1). Smallest effort, strongest anti-reskin position in the
   whole research (Playwright has no analog), loud-by-construction. Honest caveat: *narrow, target-dependent
   yield* (fired 0× on the prior corpus; high on masked/debounced inputs) — the un-owned-over-broad trade the
   charter explicitly endorses.
2. **delta→assertion synthesis** (testgen A). Attacks the sharpest, best-documented, least-served gap (the
   oracle problem). Reuses the shipped `suggest→verify→score` pipeline; every output a *candidate*, live-verified,
   `transient`-flagged if reverted — DW **assists**, never generates/owns the test.

**Wave 2 — the suite-scale substrate (the biggest strategic win; two blocks on one spine).**
3. **Side-car enrichment**: persist `checksum(delta)` (+ `coveredBy` label, + opt-in routing report), with an
   honest coarse `signature` fallback for the passive/zero-edit majority (label each cluster's resolution
   `delta-attachment` vs `error-text` so the limit is *visible*).
4. **triage T1** cause-clustering (code × fingerprint) — collapse "twelve unrelated reds" into "one root cause,
   12-test blast radius."
5. **reporting A** priority queue — rank T1's clusters by blast-radius × confidence, `unsure` in its own
   "route to a human" lane, decomposed/auditable (never an opaque score).
   *(triage T2 flake-shape-from-taxonomy and T3 cause-domain routing are cheap follow-ons over the same cluster
   objects — optional Wave-2 tail.)*

**Wave 3 — deepen the proven strength.**
6. **debug A** trace-native network correlation — open the `*.network` member DW already ships past, and fuse
   status≥400-in-the-action-window with the DOM-cause verdict (live-routing rules verbatim). Closes a documented
   offline↔live asymmetry for *the* dominant real-failure class (backend fault as DOM timeout). Zero DW-04 cost;
   S–M behind the existing version-guard.

*Rationale for the order:* Wave 1 delivers two crisp, independently-valuable wins with near-zero risk and no
plumbing. Wave 2 is the highest-ceiling direction (suite-scale fix-once-fix-many) but needs the one small
side-car enrichment first, so it follows. Wave 3 deepens DW's most-defensible existing territory and is
gated only by an undocumented-but-version-guarded trace format.

## 5. The consolidated anti-reskin firewall (every block's NEVERs, in one place)

- **Never a test generator** (testgen) — emit *candidate* fragments from one observed delta; never write/own/
  re-run the test file; never claim the observed transition is the *intended* spec.
- **Never a flake suppressant** (hardening, triage) — never silent-retry, never quarantine, never convert a
  SUSPECTED signal into a verdict. Make flakiness **louder and located**, the opposite of the retry reflex.
- **Never an APM/OTel or a trace-viewer network panel** (debug) — action-window-scoped routing metadata only;
  a co-occurring 5xx is "WEIGH as a possible backend signal," **never** "the backend caused it." No offline
  geometry (needs a re-render — out).
- **Never text/stack/test-id clustering, never "same bug"** (triage) — cluster on the *structural* delta
  fingerprint; a cluster is a *hypothesis*; distinct codes never merge; **`unsure` never clusters** (each a
  singleton).
- **Never an opaque priority score, never bury `unsure`** (reporting) — decomposed/auditable rank; `unsure`
  gets its own lane on par with the top, never scored low; annotation level maps to the confidence band.
- **Cross-cutting:** DW-02 (Playwright authoritative; annotate, never override), DW-03 (observe/label,
  co-occurrence ≠ causation), DW-04 (closed taxonomy; abstain over invent; a new code costs an ADR + corpus
  relabel + harness re-run + the frozen taxonomy lock).

## 6. Open decisions for the owner (before any build)

1. **Scope of the next chapter.** Wave 1 only (two quick wins), Wave 1+2 (quick wins + the suite-scale
   substrate — the highest-ceiling, most work), or a single flagship pick? Recommendation: **Wave 1 now**
   (crisp, low-risk, immediately useful), then **Wave 2** as the flagship if the suite-scale direction is
   wanted.
2. **Versioning.** Wave 1 is additive (a matcher + a suggest extension) → a minor bump. Wave 2's side-car
   enrichment is additive but changes the side-car schema → decide minor vs a documented schema version.
3. **Is suite-scale triage in DW's mandate,** or does it belong to a separate tool that *consumes* DW
   side-cars? Wave 2 is the most product-shaped (a dashboard/queue), the furthest from a Playwright add-on —
   worth an explicit yes/no before investing.
4. **`measureRetention` + the removal-region fix are already merged on `main` (unreleased)** — fold the Wave-1
   picks into the same next release, or cut the current unreleased set first?

## 7. Pointers

- Charter: `docs/research/SDLC-RESEARCH-CHARTER.md`.
- Blocks: `sdlc-testgen.md`, `sdlc-hardening.md`, `sdlc-debug.md`, `sdlc-triage.md`, `sdlc-reporting.md`
  (each has cited prior-art, a per-candidate honesty table, and feasibility).
- Prior context: `[[deltawright-enhancer-research]]` (the authoring-enhancer chapter this extends),
  `[[deltawright-offline-ceiling-assessment]]` (the honest prior verdicts these build past).
