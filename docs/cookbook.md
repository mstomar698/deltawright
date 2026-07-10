# Deltawright cookbook (v0.6)

A problem → capability → one-line wiring guide, plus the **honest-limits matrix**. Every capability is
**opt-in**: the core `actAndObserve` path is byte-unchanged unless you pass a flag, and each surface
below is a separate import you add only when you want it.

> **Accuracy stamp (read first).** All diagnosis/accuracy numbers in this repo are **corpus-relative**:
> they measure Deltawright against a **36-case seed corpus** (`bench/flake-corpus/`) — a DOM we
> *assert* resembles each failure mode — not against a real production app. `npm run bench:accuracy`
> currently reports **recall 100% / silent-miss 0% on that seed**, and the DW-02, precision (≥95%) and
> silent-miss (≤5%) floors are gated. **This is not a claim about real-app fidelity**, which stays
> open (#25/#41). A green delta **checksum** is likewise *regression-only* — it proves structure is
> unchanged, not correct.

## Recipes — problem → capability → one line

| You want to… | Capability | One-line wiring |
|---|---|---|
| See **what changed** after one action + whether it's actionable | `actAndObserve` (core) | `const delta = await actAndObserve(page, (p) => p.click('#save'), { label: 'save' });` |
| Get a **compact, token-tiny** render of that delta | `render` | `console.log(render(delta).text);` |
| Ask **why** a node is not actionable (root cause) | `diagnose` | `for (const d of diagnose(delta).diagnoses) console.log(d.code, d.confidence);` |
| …or fold the diagnosis into the text output | `serialize` opt-in | `render(delta, { diagnostics: true }).text` |
| **Fail fast** on a not-actionable target (preflight) | `deltawright/matchers` (#53) | `expect.extend(dwMatchers); await expect(page.getByRole('button', { name: 'Save' })).toBeActionable();` |
| Read that verdict **structurally**, standalone | `preflight` | `const { verdict, reason, geometryVerdict, agreed } = await preflight(locator);` |
| **Regression-guard** a delta's structure (jitter-tolerant) | `deltawright/matchers` (#54) | `expect(delta).toMatchDeltaChecksum('save-opens-toast');` |
| Wait for the DOM to **settle** after an action (a signal, cheaper than a delta) | `deltawright/wait` (#58) | `const { settleMs, hitMaxWait, suspectedEarly } = await observeConsequences(page, (p) => p.click('#save'));` |
| **Suggest** selectors + assertions for a delta's changed nodes | `suggest` (#57) | `const { selectors, assertions, warnings } = suggest(delta);` |
| Triage **every failing test** with zero test edits | `deltawright/reporter` (#55) | `reporter: [['list'], ['deltawright/reporter']]` in `playwright.config.ts` |
| **Rank flaky tests** across runs from the triage side-cars | `deltawright/aggregate` (#59) | `deltawright aggregate --report ./run-1 ./run-2` (or `aggregate(readSidecars(dirs))`) |
| …with a **geometry-grounded** cause on a specific action | `attachDelta` (rich mode, a test edit) | `await attachDelta(testInfo, await actAndObserve(page, act));` |
| Drive Deltawright from an **agent** (MCP) | `deltawright mcp` | MCP config: `command: "npx", args: ["deltawright-mcp"]` |
| Observe a **canvas / WebGL** draw (no DOM mutation) | screenshot fallback (#20) | `actAndObserve(page, act, { screenshotFallback: true })` |
| Include **same-origin child frames** | frames (#34) | `actAndObserve(page, act, { frames: true })` |
| Flag a **late render wave** after settle | `lateWatchMs` (#49) | `actAndObserve(page, act, { lateWatchMs: 1200 })` |
| Flag a **post-settle rect move** | `rectRecheckMs` (#50) | `actAndObserve(page, act, { rectRecheckMs: 800 })` |
| Fingerprint a delta directly | `checksum` (#41) | `const fp = checksum(delta);` |

Subpaths: `deltawright` (core), `deltawright/matchers` (#53/#54), `deltawright/reporter` (#55),
`deltawright/mcp`. Playwright is a **peer** dependency.

## Honest-limits matrix

| Limit | What it means | Behavior (skip-with-reason) |
|---|---|---|
| **Chromium (validated target)** | `actAndObserve` + the injected observer are developed and tested against headless Chromium; **cross-browser (Firefox/WebKit) is deferred/unvalidated**, not a proven hard block. | The **preflight matcher's verdict** is Playwright's own probe and is browser-agnostic; use it under any project. Treat `actAndObserve` on a non-Chromium browser as unverified. |
| **Strict CSP** (`script-src`) | A CSP that blocks `addScriptTag` stops the observer from injecting. | `actAndObserve` **degrades** — it still performs the action, returns an empty delta, and `diagnose()` reports **`injection-blocked`** (confirmed). `preflight` degrades to a Playwright-only verdict (`geometryVerdict: 'n/a'`). |
| **Cross-origin / uninjectable frames** | A frame Deltawright can't inject into during `frames:true` traversal. | Counted and surfaced as **`cross-boundary-partial`** (suspected) — the delta is honestly marked partial. **Closed shadow roots are structurally uncountable** (`el.shadowRoot` is `null`), so only skipped *frames* are reported. |
| **Overhead** | It is not free. | A **~150 ms** pre-arm baseline (early-exits ~60 ms on a quiet page) for causal attribution, plus an **O(nodes)** bounded-concurrent (12) actionability reconcile. Settle quiesced at ~340 ms in the north-star case. All tunable. |
| **Ephemeral `data-dw-ref`** | The `eN` refs are per-action. | They are stamped at collect time and **cleared on the next `arm()`** — they are *not* a stable selector across actions. Use them only within one delta. |
| **Token size** | The delta is small in absolute terms (~100 tokens), not necessarily smaller than the incumbent. | Real large-SPA wins are measured (#23: ~1% of a re-snapshot); the general "cuts tokens vs before+after diff" is app-dependent. |
| **Diagnosis accuracy** | Corpus-relative, not real-prod. | 100% recall / 0% silent-miss **on the 36-case seed**; gated by `npm run bench:accuracy`. Real-app fidelity is blocked on the owner's apps (#25/#41). |
| **Checksum fidelity** | A green checksum is **regression-only**. | It proves the normalized structure/semantics is unchanged, *not* that the delta is correct or models a real app. It also does **not** distinguish *which* attribute changed on an `attrChanged` node (a documented blind spot). |
| **Settle-as-a-wait** | `observeConsequences` is a **signal, not a guarantee**. | It reports when the DOM went structurally quiet (`settleMs`), whether that was inconclusive (`hitMaxWait`), and whether a late wave landed (`suspectedEarly`) — it is NOT a completion guarantee, retry, or flake suppressant, and exposes no `ready` boolean. It saves the **O(nodes) reconcile** (its cost win) but is not unconditionally faster wall-clock — the default late-watch adds a fixed window (`lateWatchMs`, set 0 to skip). `suspectedEarly` is coarse: light-DOM only (misses open-shadow-root late waves) and can trip on background churn. |
| **Suggested selectors** | Every `suggest()` selector is a **candidate to verify**. | role/name are heuristic reads (not Playwright's a11y algorithm), a `name` may be an aria-label, and uniqueness/durability are not checked; `getByTestId` and the ephemeral `data-dw-ref` are never suggested. |
| **Triage cause** | A reporter cause is a **hypothesis**. | It is derived from Playwright's own failure signal (passive) or an attached delta (rich); a low-confidence cause is `unsure` and a gone locator is `detached` — it never fabricates. |

## Notes

- **Everything opt-in.** With no flags, `actAndObserve` produces the byte-unchanged v0.1 delta; the
  gap flags (`lateWatchMs`, `rectRecheckMs`, `screenshotFallback`, `frames`) each default off.
- **One engine.** The matchers and the reporter all consume the *same* `diagnose()` / actionability
  code the core delta uses, so they can't drift from it — and the reporter therefore hard-gates on the
  accuracy harness.
- **Design contracts** (DW-02 verdict authority, DW-03 confidence, DW-04 closed taxonomy) live in
  `docs/decisions/design-watches.md`; the per-decision trail is in `docs/decisions/`.
