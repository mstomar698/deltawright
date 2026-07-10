# Ideation & Decision Doc — An Action-Scoped "Delta Layer" for Agent-Driven Browser Testing

*Working codename: **DeltaDOM** (placeholder — naming options at the end)*
*Status: pre-decision ideation. Purpose: decide go / no-go, and if go, use as the initial spec.*

---

## 0. Bottom line (read this first)

**Is it viable?** Yes. Not theoretically hard, not blocked, and the building blocks are proven and off-the-shelf.

**Is this just your problem, or a real shared gap?** It's a real, *documented* gap — not a private pain. The exact failure you hit is an open issue on Microsoft's own Playwright repo, and the same limitation exists in Google's Chrome DevTools MCP. Two first-party incumbents, same blind spot.

**Is the idea novel?** The *concept* (observe DOM changes, read geometry) is not novel — these are standard web APIs. What's novel is the **assembly**: nobody ships an *action-scoped* delta that combines "what changed after this specific action" + "where it is on screen" + "can the agent actually act on it," packaged for an LLM and tuned for test generation. That specific artifact does not exist today.

**Does it fit your goal** (put a real solution in the OSS market, not compete, earn recognition for good work)? Yes — and unusually well. It's a small, sharp, buildable tool that fills a named gap, complements the incumbents instead of fighting them, and the "recognition" comes precisely because it solves something people are visibly working around badly right now.

**Recommendation:** Build it. Scope it as a **complement to Playwright MCP**, not a browser and not a Playwright replacement. Spend one week proving the core primitive on a single north-star case (a button-click that opens a popup). That week tells you whether the value is real before you commit the month.

**When it would be a dud** (honest): if, in your real cases, plain re-snapshot-and-diff turns out to be "good enough" and the marginal value of scoped deltas is thin; or if mutation noise on heavy SPA frameworks proves intractable to filter cleanly; or if the incumbents close the geometry/viewport gap fast (issue #39955 is open — they might). The week de-risks all three.

---

## 1. The problem, stated precisely

You drive Chromium headless with Playwright + an LLM to generate and verify tests. Two things hurt:

1. **Debugging via DOM snapshots is heavy, slow, costly, and fails ~60% of the time** — "the agent can't find things that are there."
2. **Detecting what a click did requires a before/after DOM diff** — e.g. a button opens a popup, and to know *which* popup appeared and *where*, you snapshot before, snapshot after, and diff the two.

Reframed into the actual root causes:

**(a) DOM presence is not actionability.** The element *is* in the DOM, so the representation says "it exists" and the agent picks it — but it's covered by an overlay, zero-size, off-screen, `pointer-events:none`, or mid-animation, so the real interaction fails. The snapshot says yes; the rendered reality says no. Your selector injection let you *name* elements but couldn't fix this, because the missing information was never selectors — it was **geometry and stacking**, which don't live in the DOM at all (layout is computed at runtime).

> Note on terminology: what you called "position not in the source map" isn't source maps (those map minified JS back to original JS — unrelated). What you mean is that the *page representation the agent receives* carries no position. Correct — and it's carried by nothing until you query it live.

**(b) The before/after diff reconstructs, after the fact, information the browser already had and threw away.** When the click inserts the popup, the browser fires mutation events and recomputes layout — it knows exactly which nodes were added, their geometry, and their stacking, *at that instant*. Paying two full snapshots plus a noisy diff is paying to recover a delta the browser could have handed you directly.

---

## 2. Evidence this is a shared, documented gap (not just yours)

Both major agent-facing browser tools represent pages the same way, with the same blind spots.

**Playwright MCP (Microsoft, Apache-2.0):**
- Represents pages as an **accessibility-tree snapshot** (YAML-ish, role + name + `ref`), ~200–400 tokens per snapshot. Deliberately **layout-independent** — no coordinates, no geometry.
- The snapshot returns **all DOM elements regardless of viewport** — off-screen items, closed-modal items, unreachable footer links all show up as if directly interactive. This is **open issue #39955** on the Playwright repo. The reporter's own workaround is `getBoundingClientRect()` filtering, which they describe as "unreliable and requires manual maintenance per page," and they request a `viewportOnly` mode that doesn't exist yet.
- Interaction model is **re-snapshot after each change** ("refs are invalidated when the page changes"). No action-scoped delta — you diff full snapshots yourself.

**Chrome DevTools MCP (Google, CDP-based, Puppeteer under the hood):**
- Same `take_snapshot` = **a11y-tree text snapshot** with `uid`s; screenshots are the pixel fallback; coordinate clicking is gated behind an `--experimentalVision` flag needing a computer-use model.
- Rich on *debug* signals (network, console, performance traces, heap) but has **no action-scoped mutation delta, no geometry in the snapshot, and no actionability verdict** beyond "it's in the a11y tree."

**Corroborating the actionability failure:** web.dev's own "agent-friendly websites" guidance warns that agents "discard nodes that are covered, even if the node appears transparent," and that off-screen / ghost-overlay elements confuse them. Browser vendors are telling *site authors* to work around exactly the gap you want to close from the *tooling* side.

**Net:** the "present-but-not-actionable" failure and the "diff-it-yourself" burden are structural to the current a11y-snapshot approach, and they span both first-party incumbents. Your 60% isn't you doing it wrong — it's the representation missing two dimensions (geometry, actionability) and offering no scoped change signal.

---

## 3. The idea, crisply

**An inversion of the loop.** Today: *snapshot-first* — dump the page, hunt for things, diff full snapshots when confused. Proposed: **delta-first** — the agent performs an action and receives a compact, structured description of **exactly what changed, where it is, and whether it's actionable**. Full snapshots become the rare fallback, not the default.

**One-line definition:** a browser-observation layer that turns *an action* into *a scoped, geometry-and-actionability-aware delta*, emitted in a tiny LLM-friendly format, purpose-built for the test-generation loop.

**The core primitive (per action):**
1. Arm a **`MutationObserver`** (or Mutation Summary) just before the action → captures *what* changed (the popup's subtree), scoped, cost proportional to the change not the page.
2. Perform the action.
3. Wait for the page to **settle** (mutation quiescence + Playwright auto-wait, optional network-idle).
4. For the changed nodes only: **`getBoundingClientRect`** (where), **`getComputedStyle` + `document.elementFromPoint(x,y)`** (visible? topmost? actually hittable?), cross-checked against **Playwright's own actionability judgment** (visible / stable / receives-events / enabled).
5. Emit one compact delta, e.g.:

```
after click "Sign in" [ref=e12]:
  + dialog "Session expired" @ (640,300 380x220), topmost, ACTIONABLE
      + button "Renew"  [ref=e40] @ center, ACTIONABLE
      + button "Cancel" [ref=e41], ACTIONABLE
      + textbox "Password" [ref=e42], covered-by e40 overlay, NOT-actionable-yet
  ~ button "Sign in" [ref=e12] now disabled
```

That's tens-to-low-hundreds of tokens for the popup case, versus re-dumping a full SPA a11y tree (and versus the ~114K-token full-run figure Microsoft cites for MCP-driven sessions). Cheap, scoped, and it directly answers the agent's next question: *what appeared, and what can I click?*

---

## 4. What already exists vs. what's genuinely yours

| Piece | Status | Who owns it |
|---|---|---|
| a11y-tree page snapshot for agents | Exists, mature | Playwright MCP, Chrome DevTools MCP |
| `MutationObserver` (change detection) | Native web API | Browser platform |
| Concise DOM **delta** computation | Exists (Mutation Summary): cost scales with #changes, not doc size | rafaelw/mutation-summary (proven, but old — use as foundation/reference) |
| Element geometry | Native (`getBoundingClientRect`) | Browser platform |
| Actionability judgment | Exists inside Playwright (visible/stable/receives-events/enabled) | Playwright |
| Terminal rendering of a page | Exists (Carbonyl, Browsh) + protocols (kitty graphics, sixel, iTerm2, chafa) | Various OSS |
| **Action-scoped delta = change + geometry + actionability, LLM-formatted, tuned for test-gen** | **Does not exist as a packaged artifact** | **← your wedge** |

**The moat is the assembly + the opinion**, not any single primitive. "Structured snapshot for agents" is taken. "**Action-scoped, actionability-aware delta, optimized for generating good tests, local and OSS**" is open ground. The reason it hasn't been built isn't difficulty — it's that the incumbents optimized for the *general* "let an agent drive a browser" case, and the *test-generation* case has sharper needs (stable-selector candidates, flagged dynamic regions, "what changed after this step," actionability) that nobody has served head-on.

---

## 5. Architecture (the realistic build)

**Do not build a browser. Do not build a rendering engine. Do not reimplement actionability.** Stand on Playwright + CDP and add the thin layer that's missing.

```
        ┌───────────────────────────────────────────────────────┐
        │  Agent / Claude Code  (consumes deltas via MCP)        │
        └───────────────▲───────────────────────────────────────┘
                        │  compact structured delta (tokens)
        ┌───────────────┴───────────────────────────────────────┐
        │  DeltaDOM layer                                        │
        │   • arm → act → settle → collect loop                 │
        │   • mutation coalescing / noise filter                │
        │   • geometry + actionability annotator                │
        │   • delta serializer (LLM-friendly)                   │
        │   • MCP server surface (tools: act_and_observe, ...)  │
        └───────────────▲───────────────────────────────────────┘
                        │  Playwright API + injected page script
        ┌───────────────┴───────────────────────────────────────┐
        │  Playwright  →  headless Chromium (CDP)                │
        │   (navigation, actionability engine, refs, auto-wait) │
        └───────────────────────────────────────────────────────┘
                        │ (optional, later)
        ┌───────────────┴───────────────────────────────────────┐
        │  Terminal observability: render changed region into   │
        │  a tmux pane (chafa / kitty protocol) — for the HUMAN  │
        └───────────────────────────────────────────────────────┘
```

Two components do the work:
- **An injected page script** (runs in the page): the MutationObserver/Mutation-Summary, the per-node `getBoundingClientRect` / `getComputedStyle` / `elementFromPoint` reads, scoped to changed nodes.
- **A host wrapper** (Node/TS around Playwright): arms the observer, issues the action through Playwright (inheriting its actionability + auto-wait), detects settle, pulls the delta, serializes it, and exposes it over MCP so Claude Code consumes deltas natively.

**Build on Playwright (not raw CDP, not a fork of a terminal browser)** because you inherit navigation, refs, cross-browser, and — critically — the actionability engine you'd otherwise reimplement badly. Raw CDP is an option only if you later need something Playwright hides; a terminal-browser fork (Carbonyl/Browsh) is the wrong base entirely (it optimizes human rendering, which is not the agent's input).

---

## 6. The hard parts (honest risk register — this is where the month goes)

The happy path is a week. These are what make the *usable* version take a month, roughly in priority order:

1. **Settle detection (biggest risk).** When is the page "done" changing after the action? Too early → you miss the popup; too late → you're slow. Animations, lazy loads, debounced handlers all lie. Approach: Playwright auto-wait + mutation quiescence (no mutations for N ms) + optional network-idle, tuned. If this can't be made reliable, the whole tool wobbles — so prove it first.

2. **Mutation noise on SPA frameworks (where the value is earned).** React/Vue/Angular churn the DOM constantly — re-renders, keyed-list reorders, hydration. A naive observer fires on all of it and you've just moved the noise from "diff" to "mutation stream." Coalescing, `attributeFilter`, and Mutation-Summary-style "net difference between two states" (it ignores transient intermediate states) are the tools. Getting the filter right *is* the product; a good chunk of the month is tuning it against real apps.

3. **The DOM-less boundary.** Shadow DOM needs observers attached into each root; iframes are separate documents (Playwright frame-switching, cross-origin limits); `<canvas>`/WebGL apps have **no DOM to observe** — a popup there is painted pixels. Fallback: screenshot-diff the changed region for those. Scope honestly — DOM-based attribution covers most sites, not all. State that limitation loudly rather than pretending to cover canvas apps.

4. **Keeping the actionability verdict aligned with Playwright's.** Your `elementFromPoint` heuristic and Playwright's "receives events" check must agree, or you'll tell the agent "actionable" and Playwright will then refuse the click (or vice-versa). Closing the gap between *what the agent thinks it can click* and *what Playwright will actually click* is most of your 60%. Prefer deriving/exposing Playwright's judgment over inventing a parallel one. (Caveat: Playwright doesn't expose a clean "explain why actionability failed" API, so part of the work is surfacing that verdict usefully — a legitimate contribution in itself.)

---

## 7. Scope: v0.1 → v0.5 → v1.0 (mapped to your week / month)

**v0.1 — the week (your 30–50% of phase 1). North-star: the popup case, end to end, on a DOM-based site.**
- Injected observer + geometry + actionability reporter.
- Playwright wrapper: arm → act → settle → collect.
- Compact JSON/text delta emitted.
- One tool (`act_and_observe`) callable manually or via a thin MCP stub.
- **Success = "click → structured delta with position and actionability, no before/after diff" works on one real popup.** The day that works, the idea is proven.

**v0.5 — the differentiated core (bulk of the month).**
- Mutation noise filtering tuned across React/Vue/(Angular) real apps.
- Robust settle detection.
- Shadow DOM + same-origin iframe traversal.
- Screenshot-diff fallback for the changed region (canvas/cross-origin).
- Clean MCP packaging so Claude Code consumes deltas natively; a couple of tools (`act_and_observe`, `describe_changes`, `full_snapshot` fallback).
- **Test-gen opinion** starts here: stable-selector candidates per changed node, "assertion suggestions" (e.g. "assert dialog 'Session expired' visible").

**v1.0 — usable-in-the-real-world for people like you.**
- Reliability hardening across a corpus of real sites.
- Optional **terminal observability**: render the changed region into a tmux pane (chafa/kitty) with the delta highlighted, so *you* can eyeball whether the agent's attribution was right when a run goes wrong. (Terminal view = human verification, not agent input — see §8.)
- Docs, examples, a demo GIF of the popup case, and a clear "how this complements Playwright MCP" story.

---

## 8. The terminal-rendering piece — where it actually belongs

Your original instinct was "render the site in the terminal." Keep it, but relocate it. **An agent reads tokens, not pixels** — rendering a page to the terminal and then feeding *that* to the LLM is strictly lossier than handing it a structured delta. So terminal rendering is **not** the agent's input.

Its real job is **human observability**: you, over SSH in a tmux pane, watching the agent, and — when a run misbehaves — seeing the highlighted changed region so you can tell at a glance whether the agent attributed the popup correctly. That's genuinely useful, it plays to your headless-systems strength, and it's a clean, separable v1.0 add-on. It's also good "recognition" surface (it demos beautifully). Just don't let it become the core, and don't route the agent through it.

Feasibility here is settled: terminal image protocols (kitty graphics, sixel, iTerm2 inline) and libraries (chafa) already do bitmap-in-terminal; Carbonyl/Browsh prove full pages render in a TUI. This part is low-risk and can wait.

---

## 9. Positioning & OSS strategy (given "recognition, not competition")

**Position as a complement, not a rival.** The framing that maximizes both adoption and goodwill: *"Playwright MCP tells the agent what's on the page. DeltaDOM tells it what just changed and whether it can act on it."* A **delta / actionability layer** that sits alongside Playwright MCP, not a replacement for it and definitely not "a new browser."

Why this framing wins:
- It sidesteps the fatal "why not just use Playwright MCP?" question by answering it directly: *use both — we add the two dimensions it's missing.*
- It's honest (you *are* building on Playwright), which the OSS community rewards.
- It gives you a crisp, quotable one-liner and a demo (the popup) that instantly shows the gap.
- It ties to a live, visible pain (issue #39955 and its ilk) — contributing toward a documented need is how small OSS projects get noticed.

**Adoption path:** ship as an MCP server (drop-in for Claude Code / Cursor / Copilot) *and* a plain library/CLI (the ecosystem is trending toward token-efficient CLI-over-MCP for coding agents, so offering both hedges well). License permissively (MIT/Apache-2.0) to match Playwright MCP and lower the barrier.

**Naming directions** (pick one; codename above is a placeholder):
- Descriptive: *DeltaDOM*, *ActionDelta*, *WhatChanged*.
- Test-gen-flavored: *Diffwright*, *StepScope*, *Actionable*.
- Headless/terminal-flavored: *pane* / *tmux*-adjacent if you lean into the observability angle.

---

## 10. Go / No-Go decision framework

**Green-light if the week produces:** on your own real target app, a click that opens a popup yields a correct, compact delta — the popup identified, positioned, and marked actionable — *without* a manual before/after diff, and the actionability verdict matches what Playwright then actually does.

**Kill (or radically rescope) if the week reveals any of:**
- Plain re-snapshot-and-diff on your real cases is already "good enough," and the scoped delta doesn't measurably cut tokens/time/failures. (Test: run your current flow vs. the delta on 3–5 real interactions and compare.)
- Mutation noise on your target framework is so heavy that the filter can't isolate the meaningful change without per-site tuning — i.e. you've recreated the noise you were escaping.
- Settle detection can't be made reliable enough to trust the delta.

**Watch (external risk):** issue #39955 is open. If Microsoft/Google add viewport filtering + geometry to snapshots, part of your wedge (geometry, reachability) narrows. But the **action-scoped delta** and the **actionability verdict aligned to the click** are deeper than a viewport flag and unlikely to be subsumed soon — that's the durable core. Bias the design toward those, not toward just "geometry in the snapshot."

---

## 11. One-paragraph summary for a future you

An agent-facing, action-scoped **delta layer** built on Playwright + headless Chromium: instead of dumping and re-dumping accessibility snapshots (which carry no geometry, list unreachable elements, and force you to diff them yourself — a documented gap in both Playwright MCP and Chrome DevTools MCP), it arms a MutationObserver, performs one action, waits for settle, and emits a tiny structured delta of *what changed + where it is + whether it's actionable*, using Playwright's own actionability judgment. The primitives are all proven (MutationObserver, Mutation Summary, getBoundingClientRect, Playwright actionability); the novelty is assembling them into one artifact tuned for test generation, which nobody ships. A week proves it on a single popup; a month makes it real (noise filtering + settle + shadow/iframe + canvas fallback + MCP packaging); terminal rendering comes last, as human observability, not agent input. Position it as a complement to Playwright MCP, not a browser and not a competitor — which is exactly how a small, sharp OSS tool that fills a visible gap earns recognition.
