# R-testgen — can the action-scoped delta seed better assertions, steps, page-objects, and agent grounding than codegen or whole-page re-serialization?

> Block: **TESTGEN**. Charter: `docs/research/SDLC-RESEARCH-CHARTER.md`. NO-ACTION research pass —
> deliverable is this cited report, not code. Grounded in `src/host/suggest.ts`,
> `src/matchers/verify-suggest.ts`, `src/matchers/score-selectors.ts`, `src/host/page-map.ts`,
> `src/mcp/server.ts`, `src/host/actAndObserve.ts`, `src/host/types.ts`.

## TL;DR

DW's action-scoped delta already carries three fields **no incumbent test-authoring tool exposes**:
`stateChanges` (aria-expanded/selected/checked/pressed/disabled/open, as an **old→new transition**),
`ariaLive` (was this change *announced*?), and `kind` (added/removed/attr/text) fused with geometry
(occlusion / newly-actionable). Codegen records **actions but not assertions** (the oracle gap); its
only assertion tooling is manual point-and-click plus a coarse whole-page ARIA-snapshot baseline. AI
agents re-serialize the **whole page** each step (20k–60k tokens/step) and the frontier optimization
is *smaller whole-page snapshots*, not *action-scoped deltas*. The un-owned move is to turn the delta
into **candidate assertions and step-grounding**, always labeled candidate, verified against the live
DOM, and never sold as "the test." The honest line: **DW grounds the author/agent who writes the test;
it never authors, owns, re-runs, or vouches for the correctness of the test.**

Top pick: **Candidate A — delta→assertion synthesis (state-transition assertions).**

---

## 1. State of the art / competitors (cited)

### 1a. Playwright codegen / record-and-replay
- **Records actions, not assertions.** Codegen emits a click/fill script; assertions require *deliberate*
  toolbar selection, and there are exactly three: `assert visibility`, `assert text`, `assert value`
  ([Playwright — Test generator](https://playwright.dev/docs/codegen),
  [codegen-intro](https://playwright.dev/docs/codegen-intro)). A recording with no assertions "does not
  verify anything" ([Autonoma — Why recorded tests rot](https://getautonoma.com/blog/playwright-codegen)).
- **Brittle on poor-a11y apps.** Codegen is "mostly right on well-structured apps and increasingly wrong
  on apps with poor accessibility attributes, where it falls back to structural selectors that break the
  moment you reorder a list or rename a class"; positional locators are "the most fragile part of any
  generated test"; and there is **no update command — when the UI changes you start over**
  ([Autonoma](https://getautonoma.com/blog/playwright-codegen)).
- **Assertion tooling is state-blind.** Playwright *has* `toBeExpanded()` / `toBeChecked()`
  ([test-assertions](https://playwright.dev/docs/test-assertions),
  [LocatorAssertions](https://playwright.dev/docs/api/class-locatorassertions)), but there is **no feature
  that maps an observed aria-attribute change to the right assertion method** — you hand-write it; and
  `toBeChecked()` *errors* on ARIA `switch` roles
  ([microsoft/playwright#18193](https://github.com/microsoft/playwright/issues/18193)). The one automatic
  option is `Assert snapshot`, a **whole-subtree ARIA baseline** ([aria-snapshots](https://playwright.dev/docs/aria-snapshots))
  — coarse (asserts the entire tree, not the one transition you cared about) and itself brittle to
  incidental churn.

### 1b. AI test generators / autonomous browser agents
- **Whole-page re-serialization is the cost driver.** A multistep browser task consumes 20k–60k tokens
  "once you count the page state fed in at each step"; a full-page screenshot each step "is how an agent's
  running cost triples quietly"
  ([Bug0 — Expect vs agent-browser vs Stagehand](https://bug0.com/blog/expect-vs-agent-browser-vs-stagehand-vs-passmark)).
  Raw DOM snapshots "can cost hundreds of thousands of tokens"
  ([Webfuse — DOM downsampling](https://www.webfuse.com/blog/dom-downsampling-for-llm-based-web-agents),
  [arXiv 2508.04412](https://arxiv.org/html/2508.04412v1)).
- **The frontier optimization is a *smaller whole-page snapshot*, not a delta.** Vercel's agent-browser
  compresses the a11y tree with semantic refs (`@e1`, `@e2`) for a claimed ~93% context reduction
  ([DEV — agent-browser token war](https://dev.to/chen_zhang_bac430bc7f6b95/why-vercels-agent-browser-is-winning-the-token-efficiency-war-for-ai-browser-automation-4p87);
  directional — savings "vary widely by page complexity", per [Bug0](https://bug0.com/blog/expect-vs-agent-browser-vs-stagehand-vs-passmark)).
  It is still a *stateless full-page* dump each step, just cheaper per node.
- **Reliability + hallucination.** Stagehand-class agents run ~75% success on novel tasks (flaky steps in
  complex workflows) ([Bug0](https://bug0.com/blog/expect-vs-agent-browser-vs-stagehand-vs-passmark)); LLMs
  "occasionally produce tests that look correct but exercise nothing useful" and "suggest fixes for code
  snippets that don't exist" ([CloudQA](https://cloudqa.io/how-llms-are-reshaping-qa-in-2025/),
  [DEV — Why AI can't write good Playwright tests](https://dev.to/johnonline35/why-ai-cant-write-good-playwright-tests-and-how-to-fix-it-knn)).
- **Grounding is empty exactly where DW is strong.** Playwright/Chrome-DevTools MCP ground the agent in the
  accessibility tree; on canvas / legacy / poor-a11y apps the a11y tree is "empty and you're stuck"
  ([Playwright MCP field guide](https://medium.com/@adnanmasood/playwright-and-playwright-mcp-a-field-guide-for-agentic-browser-automation-f11b9daa3627),
  [Playwright MCP](https://playwright.dev/docs/getting-started-mcp)).

### 1c. Self-healing / commercial record-replay (mabl, testim, QA Wolf)
- **The healing firewall is instructive:** the industry consensus is heal **locators only, never assertions**,
  gate on high confidence, log every heal
  ([QA Wolf — 6 types of self-healing](https://www.qawolf.com/blog/self-healing-test-automation-types),
  [QASkills — Self-healing 2026](https://qaskills.sh/blog/self-healing-test-automation-2026-guide)).
- **Brittle selectors are a minority of failures.** In real suites only ~28% of failures are broken
  selectors; the rest are timing, runtime errors, bad data, over-strict visual assertions, and **missing
  interaction/assertion steps** ([QASkills — Self-healing 2026](https://qaskills.sh/blog/self-healing-test-automation-2026-guide)).
  → Durable selectors (DW's shipped authoring aid) address a fraction of the pain; **the assertion/oracle
  gap is larger and less-served.**

### 1d. Academic framing — the oracle problem
Generating *inputs/steps* is comparatively mature; generating **robust oracles is still an open problem**
([Molina — Test Oracle Automation in the era of LLMs, arXiv 2405.12766](https://arxiv.org/pdf/2405.12766);
[Assertions in software testing: survey, Springer 2025](https://link.springer.com/article/10.1007/s10009-025-00794-1)).
The canonical oracle recipe is **compare pre-execution vs post-execution state around the operation**
([Automated Functional Testing from User Intent, arXiv 2604.02079](https://arxiv.org/pdf/2604.02079)) —
which is *exactly the shape of an `actAndObserve` delta.*

---

## 2. DW's real gap today (grounded in the code)

DW already does the **selector** half well and honestly:
- `suggest()` (`src/host/suggest.ts`) emits ranked candidate selectors + a `toBeActionable()` assertion,
  but **only** for `verdict === 'ACTIONABLE'` nodes, and every output is labeled a candidate.
- `verifySuggestions()` → `scoreSelectors()` → `measureRetention()` round each candidate through the live
  page for uniqueness, durability, and a measured cross-render signal — re-pointing assertions onto the
  `bestDurable`/`bestVerified` selector and **dropping** any that don't verify.

But three gaps remain, all on the **assertion / grounding** side (the larger, less-served half of §1):

1. **The delta's richest fields are unused for authoring.** `DeltaNode.stateChanges`
   (`AttrStateChange{attr, old, new}` for aria-expanded/selected/checked/pressed/disabled/open),
   `DeltaNode.ariaLive`, and `DeltaNode.kind` (added/removed) are carried in `types.ts` and consumed by
   `diagnose`/`pageMap` — but `suggest()` reads only `role`/`name`/`tag`/`actionability`. The **one
   assertion DW emits is actionability**; it never turns "aria-expanded went false→true" or "a
   role=dialog node was added" or "an aria-live region announced text" into a **candidate assertion**,
   even though that transition is precisely the post-condition an author would assert.
2. **No step/flow grounding for an agent beyond the raw delta.** MCP `act_and_observe` returns the compact
   delta, but there is **no explicit "what is now newly-actionable / newly-occluded / newly-announced"
   frontier** framed for *planning the next step* — the agent still has to re-derive that from the node
   list, and today's agents fall back to re-serializing the whole page ([§1b]).
3. **Selector suggestions are per-node, not per-interaction.** There is no *slice* that says "the action
   `openMenu` revealed these durable handles" — the unit an author copies into a flow.

DW's un-owned asset (charter §"DW's one asset") is **action granularity**: a deterministic, honesty-gated
model of *what changed because of the specific action*. Every gap above is an authoring surface that this
asset — and nothing an incumbent owns — can seed.

---

## 3. Three candidate capabilities (exploit the action-scoped delta; not a reskin)

### Candidate A — Delta→assertion synthesis (state-transition assertions) ★ top pick
Turn the **observed transition** in a delta into **candidate assertions**, ranked and verified, extending
the existing `suggest()` output beyond `toBeActionable()`:

| Delta evidence (already on `DeltaNode`) | Candidate assertion emitted |
|---|---|
| `stateChanges`: aria-expanded `false→true` | `await expect(<durable-sel>).toBeExpanded()` |
| `stateChanges`: aria-checked/selected/pressed toggled | `toBeChecked()` **only for checkbox/radio**, else `toHaveAttribute('aria-checked','true')` (the switch-role gap, [PW#18193]) |
| `stateChanges`: `disabled` `true→false` | `toBeEnabled()` (and the reverse → `toBeDisabled()`) |
| `kind: added`, role ∈ {dialog, alertdialog} | `await expect(<durable-sel>).toBeVisible()` on the new container |
| `kind: removed` | `toBeHidden()` / `toHaveCount(0)` |
| `ariaLive` set + `textChanged` | `await expect(<live-region>).toContainText(<observed text>)` — candidate |
| `kind: added`, interactive, ACTIONABLE | `toBeActionable()` (today's behavior — now one row in a family) |

Mechanics reuse the shipped pipeline: build each assertion, then route its selector through
`verifySuggestions`/`scoreSelectors` (re-point onto `bestDurable`, drop the un-verifiable — the code
already does exactly this for assertions), **and** re-read the asserted state on the live page so DW never
hands back an assertion that wouldn't hold right now; if the state already reverted (a transient), surface
it flagged `transient — no longer holds` rather than silently drop (DW-03: observe & label, never suppress).

**Why it's differentiated, not codegen:** codegen's assertion tooling is manual point-and-click over three
primitives, or a coarse whole-subtree ARIA-snapshot baseline; **no tool maps an observed aria-transition to
the right assertion** ([§1a]). DW is the only layer that *knows the old→new transition* (the a11y tree shows
static state, never the edge), and it answers the **oracle** question ("what should I assert here?") that
§1d calls open — grounded in the delta's own pre/post comparison.

### Candidate B — Agent step-grounding "change frontier" (MCP)
Extend MCP `act_and_observe` (and `pageMap` recency fusion) into an explicit **post-action step context**
tuned for *planning the next action*, not just describing the last one:
```
after <action>:
  appeared (now actionable):  [Confirm @top-center], [Cancel @top-center]
  state transitions:          menu aria-expanded → true
  now occluded (not actionable): the form below  (covered-by dialog)
  announced:                  status "Saved" (aria-live=polite)
```
This is the **delta of the last action + the newly-actionable/newly-occluded/newly-announced frontier**,
in place of re-serializing the whole page each step ([§1b]: 20k–60k tokens/step). It degrades gracefully
where the a11y tree is empty (legacy/poor-a11y) because it is observer+geometry-based, and it expresses a
*transition* ("the menu is now open") that a stateless a11y snapshot cannot.

**Why it's differentiated, not an a11y-snapshot reskin:** every incumbent (Playwright MCP, agent-browser)
sends a *stateless whole-page* structure, just compressed; DW sends the *action-scoped change* plus
occlusion and the actionable-set diff — strictly less to serialize and it carries state DW alone observes.

### Candidate C — Action-scoped page-object *slices*
Emit an **interaction-organized fragment** (not a whole POM class): for the action just performed, the
`bestDurable` handle for the target plus handles for the controls the action *revealed* (the `added` +
ACTIONABLE nodes), grouped and named after the action — e.g. `openMenu → { saveItem, deleteItem }`. Only
verified-durable handles are included; brittle ones are dropped (DW-04 abstention).

**Why it's differentiated, not a POM generator:** whole-page POM generators scrape a static page into one
class; DW's slice is scoped to a **state transition** (a flow step), which is how flows actually
decompose, and it is durability-gated. (This is the closest-to-codegen of the three — see §4.)

---

## 4. Honest real-vs-reskin check (per candidate)

**The firewall line for the whole block.** The anti-reskin firewall forbids DW *selling itself as a test
generator*; it permits DW to **assist**. The seam:

> A **generator produces the artifact and owns its correctness**. DW **grounds the human/agent who
> produces it**: it emits *candidate* fragments (selectors, assertions, step-context) from *one observed
> delta*, always labeled candidate, verified against the live DOM, and it **never writes/owns/re-runs the
> test file, never claims the observed transition is the intended spec, and never fabricates a step that
> wasn't observed.** DW answers "what just changed and what can you now assert/act on"; the author/agent
> decides "is that what I meant" and writes the test.

| Candidate | Respects | Real (not reskin) because | Must NEVER claim |
|---|---|---|---|
| **A — assertions** | DW-02 (emits `expect(...)` *code*; Playwright's `expect` runs it and is authoritative — DW runs no assertion engine). DW-03 (co-occurrence ≠ causation: the transition *happened*; DW doesn't assert it was *correct*/intended). DW-04 (only the closed transition→assertion map; unknown transitions → no assertion). | It converts the delta's **unique old→new state + ariaLive + add/remove** into the *targeted* assertion no incumbent maps automatically, and answers the open oracle question via the delta's own pre/post comparison. It is **not** reskinning `expect` (it generates candidate code) nor the ARIA snapshot (that's whole-subtree + stateless). | That the assertion encodes **correct/intended** behavior. It is "this is what changed on this run — assert it *iff* it's what you meant." Never auto-commit it to a test file. |
| **B — step frontier** | DW-02 (annotates; the agent/Playwright acts and decides). DW-03 (reports what changed + what's now actionable; never plans or picks the next step). | Every incumbent grounds on a *stateless whole-page* structure; DW grounds on the *action-scoped change + occlusion + actionable-set diff + transitions* — a strictly different, smaller, state-carrying substrate that works where the a11y tree is empty. | That it **replaces** the full snapshot in all cases — after navigation/first-load there is no prior state, so a full `pageMap` is still needed. Never present the frontier as a *decision*. |
| **C — POM slices** | DW-04 (abstains — emits nothing rather than a brittle handle). DW-02 (durability via Playwright-verified `bestDurable`). | Scoped to a **transition/flow-step** and durability-gated, vs a static whole-page scrape. | That the slice is **complete** (it only knows what *this* action revealed) or **stable across releases** (single-page estimate unless `measureRetention` ran). This is the highest reskin-risk candidate — frame strictly as an assist fragment. |

---

## 5. Feasibility

| Candidate | Reuses (shipped primitive) | Rough effort | Key risks |
|---|---|---|---|
| **A** | `suggest()` selector/assertion emit + honesty scaffold; `verifySuggestions`/`scoreSelectors` assertion re-pointing & drop path; delta fields `stateChanges`/`ariaLive`/`kind` already populated by the observer. | **S–M.** A pure `stateChanges→assertion` map in `suggest.ts` (mirrors `selectorsForNode`), plus a small live re-read of the asserted state in the verify layer. No observer/injection changes. | Over-generating low-value assertions (gate to allowlisted state attrs + added dialogs + announced live regions). `toBeChecked()` role limitation → fall back to `toHaveAttribute` ([PW#18193]). `toContainText` on volatile text → reuse `isDynamicText()` from `score-selectors.ts` to flag/skip. Keep every output labeled candidate. |
| **B** | MCP `act_and_observe` (already returns the delta); `pageMap` recency fusion + occlusion; `actionability.verdict`. | **M.** A new serializer/MCP field that diffs actionable-set + occlusion + `stateChanges` + `ariaLive` into a planning-framed block. Mostly presentation over existing data. | Scope creep into planning (forbidden — DW-03). "Newly-actionable" needs the prior actionable set (a cheap prior-delta/pageMap diff). Don't imply full-snapshot replacement. |
| **C** | `scoreSelectors.bestDurable`/`bestVerified`; delta `kind`/`role`/`name`. | **M.** Grouping + naming + code-emit; reuses durability gating. | Closest to codegen/POM reskin → strictest framing needed. Naming a slice from `Delta.action`/role is heuristic; keep names candidate. Incomplete-by-construction (only what the action revealed). |

**Sequencing.** A and B both hang off already-populated delta fields and the already-shipped verify/durable
pipeline, so neither needs observer work. A is the smallest, sharpest, and most defensible; B is a natural
MCP follow-on; C is optional and needs the most careful anti-reskin framing.

---

## 6. Summary + ranked top pick

**Top pick: Candidate A — delta→assertion synthesis (state-transition assertions).**

It attacks the **sharpest, best-documented, least-served gap**: codegen records *actions but not
assertions* (the oracle problem, still open in the literature — §1a/§1d), and even Playwright's own
assertion tooling has **no automatic mapping from an observed aria-transition to the right assertion**
(§1a, confirmed incl. the `switch`-role `toBeChecked()` limitation). It exploits the fields **only DW
carries** — `stateChanges` as an old→new *transition*, `ariaLive`, and add/remove `kind` fused with
geometry — where the a11y tree and codegen see only static state. It **reuses the shipped
`suggest→verify→score` pipeline** (assertions are already re-pointed onto verified/durable selectors and
dropped when they don't hold), so effort is S–M with no observer changes. And its honesty story is clean
and precedented by the existing `toBeActionable()` suggestion: **every assertion is a candidate, verified
against the live DOM, labeled `transient` if the state reverted, and never a claim that the observed
behavior is correct** — DW assists the author/agent, it does not generate or own the test.

Ranked: **A (assertions) > B (agent step-frontier) > C (POM slices).** B is a strong MCP follow-on; C is
useful but the highest reskin risk and must be framed strictly as an assist fragment.

---

## References

- Playwright — Test generator (codegen): https://playwright.dev/docs/codegen
- Playwright — Generating tests (codegen-intro): https://playwright.dev/docs/codegen-intro
- Playwright — Assertions: https://playwright.dev/docs/test-assertions
- Playwright — LocatorAssertions API: https://playwright.dev/docs/api/class-locatorassertions
- Playwright — ARIA snapshot testing: https://playwright.dev/docs/aria-snapshots
- Playwright — MCP getting started: https://playwright.dev/docs/getting-started-mcp
- Playwright — MCP assertions tool: https://playwright.dev/mcp/tools/assertions
- microsoft/playwright#18193 — `toBeChecked` should work on aria switches: https://github.com/microsoft/playwright/issues/18193
- Autonoma — How to Use Playwright Codegen (and Why Recorded Tests Rot): https://getautonoma.com/blog/playwright-codegen
- Bug0 — Expect vs Agent-Browser vs Stagehand vs Passmark: https://bug0.com/blog/expect-vs-agent-browser-vs-stagehand-vs-passmark
- DEV — Why Vercel's agent-browser Is Winning the Token Efficiency War: https://dev.to/chen_zhang_bac430bc7f6b95/why-vercels-agent-browser-is-winning-the-token-efficiency-war-for-ai-browser-automation-4p87
- Webfuse — DOM Downsampling for LLM-Based Web Agents: https://www.webfuse.com/blog/dom-downsampling-for-llm-based-web-agents
- arXiv 2508.04412 — Beyond Pixels: DOM Downsampling for LLM-Based Web Agents: https://arxiv.org/html/2508.04412v1
- Playwright & Playwright MCP: A Field Guide (Masood): https://medium.com/@adnanmasood/playwright-and-playwright-mcp-a-field-guide-for-agentic-browser-automation-f11b9daa3627
- QA Wolf — The 6 Types of AI Self-Healing in Test Automation: https://www.qawolf.com/blog/self-healing-test-automation-types
- QASkills — Self-Healing Test Automation in 2026: https://qaskills.sh/blog/self-healing-test-automation-2026-guide
- CloudQA — How LLMs Are Reshaping QA in 2025: https://cloudqa.io/how-llms-are-reshaping-qa-in-2025/
- DEV — Why AI Can't Write Good Playwright Tests: https://dev.to/johnonline35/why-ai-cant-write-good-playwright-tests-and-how-to-fix-it-knn
- Slack Engineering — Agentic Testing: Where Agents Fit in the E2E Testing Stack: https://slack.engineering/agentic-testing-where-agents-fit-in-the-e2e-testing-stack/
- Molina — Test Oracle Automation in the era of LLMs (arXiv 2405.12766): https://arxiv.org/pdf/2405.12766
- Assertions in software testing: survey, landscape, and trends (Springer 2025): https://link.springer.com/article/10.1007/s10009-025-00794-1
- Automated Functional Testing for Malleable Mobile Apps from User Intent (arXiv 2604.02079): https://arxiv.org/pdf/2604.02079
</content>
</invoke>
