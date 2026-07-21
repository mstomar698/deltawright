# Deltawright — SDLC-usefulness research charter

**Goal.** The authoring-enhancer chapter (`pageMap` / `observeEffectSettled` / `scoreSelectors` /
`measureRetention`, shipped in v1.0) broadened DW's *authoring* value. This research broadens the lens to
the **whole test SDLC**: how does DW become materially more useful across **testgen, hardening, debug,
triage, and reporting** — leveraging what it already owns, without reskinning Playwright or its ecosystem?

**This is a NO-ACTION research pass.** Deliverable = cited reports under `docs/research/`, not code. Design
from evidence first; do not blind-prototype.

---

## DW's one asset (the through-line)

Every incumbent operates at whole-page or single-element granularity. DW's un-owned territory is
**ACTION GRANULARITY** — a structured, deterministic, honesty-gated model of *what changed because of the
specific action you just took*: the `actAndObserve` delta (coalesced DOM change + per-node geometry /
occlusion / actionability + settle signals), produced by an injected `MutationObserver` + quiescence +
geometry/hit-test engine. It degrades gracefully exactly where the a11y tree and `networkidle` fail
(legacy / poor-a11y / heavy-RPC apps).

## Honesty contracts (non-negotiable, apply to every candidate)

- **DW-02** — Playwright's verdict is authoritative; DW annotates, never overrides.
- **DW-03** — observe & label; never fabricate, retry, or suppress; co-occurrence is never causation.
- **DW-04** — closed taxonomy; abstain (`unsure`) rather than invent a category.
- **Anti-reskin firewall** — never rebrand `waitForSelector` / `networkidle` / `expect` / an ARIA
  snapshot / a self-healing-locator engine / a pixels-only vision model and ship it as "DW".

## What DW ships TODAY, by surface (grounded — the baseline each block must build ON, not re-propose)

| Surface | DW today (code) |
|---|---|
| **testgen** | `suggest` → `verifySuggestions` → `scoreSelectors` → `measureRetention`; `pageMap`; MCP `act_and_observe` (navigate/click/fill → compact delta). Prior finding: DW is a good *selector/authoring aid*, narrow as a *generator*. |
| **hardening** | `preflight` / `toBeActionable` (role-aware actionability); `observeEffectSettled` (action-scoped readiness, no sleep/networkidle); `classifyInput` / input-integrity (value-loss shapes); `toMatchDeltaChecksum` / `toMatchDeltaSnapshot` (geometry-tolerant delta baselines). Prior finding: suite-speed is ~85% plain-Playwright discipline DW doesn't own. |
| **debug** | `diagnose` (closed taxonomy + confidence); `diagnose-trace` (offline `trace.zip` RCA, dep-free zip+zlib); `buildLiveRouting` (live `page.on` ownership routing: DOM vs backend vs client-abort). DW's proven differentiated strength. |
| **triage** | reporter `triageFailure` + failed-only side-cars + `attachDiagnosis`; `assessConfidence` + closed `taxonomy` (codes: covered-by-overlay, off-screen, not-visible, disabled, input-not-committed, settle-timeout, detached-re-render, background-churn, geom-disagreement, late-wave-suspected, …); coverage sweep (exactly one side-car per finally-failed test). DW's other proven strength (0 hard FP, honest abstention). |
| **reporting** | `aggregate` (interactive HTML dashboard from side-cars); inline-in-Playwright-report diagnosis; coverage side-car. v0.9.3 report-UX chapter. |

## The prior honest verdicts (do not re-discover; build past them)

- DW is a **strong, differentiated DIAGNOSIS/TRIAGE layer** (detect → label → route; precise, honest
  abstention) and a **useful AUTHORING aid** — but was **narrow as a hardening/testgen enhancer** until the
  action-granularity primitives landed. The live-root-causing thesis UNDER-delivered on a real 292-test
  suite (net Δ+1; quiescence tunnel-confounded). Proven value = offline covered-by-overlay precision +
  triage compression + inline-in-PW-report. See `[[deltawright-offline-ceiling-assessment]]`,
  `[[deltawright-status]]`.

---

## The five research blocks (one report each → `docs/research/sdlc-<block>.md`)

Each block answers, for its surface:
1. **State of the art / competitors** (web prior-art, CITED URLs) — what tools do here now, and their limits.
2. **DW's real gap** — where DW under-delivers vs that bar today (grounded in the code above).
3. **The un-owned, action-granularity opportunity** — 2–3 concrete candidate capabilities DW could add that
   are *genuinely differentiated* (exploit the action-scoped delta / geometry / observer), not a reskin.
4. **Honest real-vs-reskin check** for each candidate (which contract it respects; what it must NOT claim).
5. **Feasibility** — what existing DW primitive it reuses; rough effort; risks.
6. Return a **~200-word summary + a ranked top pick**.

- **R-testgen** (`sdlc-testgen.md`) — beyond selectors: can the action-scoped delta seed *assertions*,
  *test steps*, *page-object surfaces*, or *AI-agent grounding* better than codegen / whole-page
  re-serialization? Where is the honest line vs "DW is a test generator" (which the firewall forbids selling)?
- **R-hardening** (`sdlc-hardening.md`) — beyond `observeEffectSettled`: what DW-native levers reduce
  flakiness that plain Playwright discipline does NOT already own? (input-integrity, quiescence-as-settle,
  checksum drift, actionability preflight — what's the next real lever, and what's just faster sleeps?)
- **R-debug** (`sdlc-debug.md`) — deepen DW's proven strength: what would make `diagnose` / `diagnose-trace`
  / live-routing materially more useful (new evidence sources, better causal attribution honesty, richer
  offline trace signals) without over-claiming causation?
- **R-triage** (`sdlc-triage.md`) — cross-run / cross-test triage: dedup, clustering, flake-vs-real
  separation, ownership routing at SUITE scale. What can the closed taxonomy + confidence + side-cars
  become across many failures, honestly?
- **R-reporting** (`sdlc-reporting.md`) — what makes a DW report drive action: severity/priority ranking,
  trend/regression signals, CI annotations, the honest presentation of `unsure`. Anti-reskin vs existing
  reporters (Playwright HTML, Allure, etc.).

## Method (recoverable)

Run as 5 parallel `general-purpose` agents, one per block, each given this charter + its block spec. Durable
output = the FILES on disk (`docs/research/sdlc-*.md`), independent of any agent's context (survives
compaction). **Recovery if a file is missing:** re-run that block's agent from this charter — prompts are
fully reconstructable. Then synthesize → `docs/research/SDLC-SYNTHESIS.md` (cross-block, rank the most
defensible directions, flag the anti-reskin traps). No code in this pass.
