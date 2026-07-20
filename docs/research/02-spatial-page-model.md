# R2 — A spatial + semantic page model ("screenshot-equivalent")

**Research block R2** of the Deltawright enhancer research (see `00-RESEARCH-CHARTER.md`).
Question: what is the right **compact representation** that fuses DW's per-node geometry
(rect, `coveredBy`, `offscreen`, z-order), role/name, actionability, and change-delta into a
spatial+semantic "map" an author or agent consumes like a screenshot — richer than Playwright's
accessibility/ARIA snapshot, and token-cheap enough for an LLM — **without** being an ARIA-snapshot
or OmniParser reskin.

**Bottom line up front.** The representation is genuinely differentiated **only if it leads with the
three fields no existing structured page model carries: deterministic occlusion (`coveredBy` / z-layer),
actionability-reconciliation (geometry-vs-Playwright disagreement), and recency (what just changed and
where).** The semantic half (role + name + nesting) *is* the ARIA snapshot and must be **borrowed, not
re-derived**, or the whole thing collapses into a reskin. The wedge where this matters most is exactly
where the a11y tree is weakest: **legacy / poor-accessibility apps and overlay-occlusion disambiguation**,
where geometry is always available but the accessibility tree is degraded.

---

## 1. Prior-art survey

### 1.1 Playwright's own representations (the thing we must beat / not reskin)

- **ARIA snapshot** — a YAML serialization of the page's **accessibility tree** for a locator: each line is
  `- role "name" [attribute=value]`, nested by a11y containment, with ARIA states (`checked`, `disabled`,
  `expanded`, `pressed`, `selected`, `level`, …). It **deliberately ignores** CSS, geometry, and wrapper
  elements. It carries **no** x/y/width/height, **no** occlusion / z-order, **no** viewport/offscreen state,
  and **no** record of what changed after an action — it is a *structural* assertion tool.
  ([Playwright docs](https://playwright.dev/docs/aria-snapshots),
  [source md](https://github.com/microsoft/playwright/blob/main/docs/src/aria-snapshots.md))
- **Playwright MCP accessibility snapshot** — the same accessibility tree, rendered as a ref-tagged tree
  (`checkbox "Toggle Todo" [ref=e10]`) that an LLM agent acts on by ref (`browser_click {ref:"e10"}`).
  ~200–400 tokens/page vs ~3–5k for a vision screenshot. Same omissions: **no geometry, no occlusion, no
  change-diff**; for "layout-dependent tasks" the docs tell you to *combine snapshots with screenshots.*
  ([Playwright MCP snapshots](https://playwright.dev/mcp/snapshots),
  [MCP repo](https://github.com/microsoft/playwright-mcp))
- Playwright also exposes `locator.boundingBox()` per element — but that is one round-trip per node, with
  **no** `coveredBy` / hit-test / z-order / actionability, and no fused map. (This is the closest DIY
  baseline; §4 explains why DW's one-pass fusion is more than "aria snapshot + boundingBox per node".)

**Takeaway:** Playwright already owns the *semantic* snapshot. DW must not re-ship role+name+hierarchy as
its headline. The unclaimed territory is everything *spatial and dynamic* the a11y tree throws away.

### 1.2 Set-of-Marks (SoM) and visual-grounding page models for UI agents

- **Set-of-Mark (SoM) prompting** — overlays a screenshot with alphanumeric IDs / boxes / masks over
  regions produced by a segmentation model (SAM / SEEM) so a vision-LLM can *refer* to a region by ID.
  It is a **visual prompt over pixels**; it has no notion of occlusion/z-order or of what changed, and it
  needs a screenshot plus a heavy segmentation model. ([arXiv 2310.11441](https://arxiv.org/abs/2310.11441))
- **VisualWebArena** adapts SoM as its observation space: every interactable element gets a bounding box +
  ID drawn on the screenshot; agents refer to elements by ID. WebArena's text baseline is the a11y tree.
  ([arXiv 2401.13649](https://arxiv.org/pdf/2401.13649),
  [VWA overview](https://www.emergentmind.com/topics/visualwebarena-vwa))
- **WebVoyager** — multimodal agent; primary observation is the screenshot (marked), with an a11y-tree
  text-only fallback. Multimodal 59.1% vs text-only (a11y tree) 40.1% success — the a11y tree alone is
  "highly complex and verbose … far less intuitive than screenshots."
  ([arXiv 2401.13919](https://arxiv.org/html/2401.13919v3), [repo](https://github.com/MinorJerry/WebVoyager))
- **OmniParser (v1/v2, Microsoft)** — a *pure-vision* screen parser: a fine-tuned YOLOv8 interactable-region
  detector + a BLIP-2 icon-captioner + OCR produce a "structured DOM-like" list of `{bounding box, numeric
  id, interactable, caption, text}` from a screenshot, with no DOM/a11y access. Authors explicitly note it
  **does not track z-order, occlusion, viewport state, or screenshot deltas**, and it fails on **repeated /
  overlapping elements** and small text.
  ([arXiv 2408.00203](https://arxiv.org/html/2408.00203v1), [repo](https://github.com/microsoft/OmniParser),
  [MSR](https://www.microsoft.com/en-us/research/articles/omniparser-for-pure-vision-based-gui-agent/))
- **UGround / SeeAct-V** — a visual grounding model producing **pixel coordinates** for an instruction,
  trained on 10M elements / 1.3M screenshots; argues *for* pixels because "text-based representations are
  noisy and incomplete," "HTML can consume up to 10× more tokens than the visual," obtaining the a11y tree
  is slow, and **"95.9% of home pages had accessibility conformance errors."** Produces a *coordinate*, not
  a structured map. ([arXiv 2410.05243](https://arxiv.org/html/2410.05243v1),
  [homepage](https://osu-nlp-group.github.io/UGround/))
- **Ferret-UI (Apple) / ScreenAI (Google)** — MLLMs for mobile-UI referring + grounding + widget-listing
  from a screenshot; learn layout implicitly. No deterministic occlusion or change-delta; representation is
  model-internal, not a compact serialized artifact.
  ([Ferret-UI arXiv 2404.05719](https://arxiv.org/abs/2404.05719),
  [Ferret-UI Lite](https://machinelearning.apple.com/research/ferret-ui))
- **browser-use** — DOM-extraction agents that index interactive elements `[n]` and draw colored boxes +
  numeric IDs (SoM-over-DOM), feeding the LLM `[index] <tag> text`. Uses interactability but **not**
  occlusion/z-order as a first-class field. ([DeepWiki](https://deepwiki.com/browser-use/browser-use/5.3-interactive-element-detection),
  [repo](https://github.com/browser-use/browser-use))

### 1.3 Compact-DOM / layout-graph / screen-reader representations

- **D2Snap ("Beyond Pixels: DOM Downsampling")** — compresses a DOM into a compact text snapshot (containers
  merged by depth, content → Markdown, interactive kept, junk dropped), ~7–19k tokens, beating raw DOM and
  matching grounded screenshots. Geometry / visibility / interactability signals are **"notably absent"** —
  it is purely DOM-type + LLM-rated-tag semantics. A gap DW's geometry fills.
  ([arXiv 2508.04412](https://arxiv.org/html/2508.04412v1))
- **UI layout graphs / hierarchical layout trees** — a research line representing a screen as a directed
  graph (nodes = elements; edges = spatial proximity / containment; feature vectors = normalized position,
  size, area, aspect ratio) or as nested region trees (global regions → leaf regions).
  ([UISearch arXiv 2511.19380](https://arxiv.org/pdf/2511.19380),
  ["hierarchical positional encodings" TDS](https://towardsdatascience.com/improving-ui-layout-understanding-with-hierarchical-positional-encodings-b19e1e9235e/))
- **Tree-of-Lens (ScreenPR)** — builds a **Hierarchical Layout Tree** from a screenshot point that
  "articulate[s] the layout and spatial relationships between elements," explicitly *differing from screen
  readers that just read content* — "layout information is crucial for accurately interpreting information
  on the screen." ([arXiv 2406.19263](https://arxiv.org/abs/2406.19263))
- **Screen-reader page model (the a11y-tree consumer)** — a screen reader linearizes the 2-D layout into a
  **1-D DOM/reading-order stream**; "a direct reduction of a spatial layout to a linear audio stream can
  result in a significant loss of information." Screen readers follow *DOM order, not visual order* — so the
  a11y model is precisely the one that **discards spatial position**.
  ([TestParty](https://testparty.ai/blog/how-screen-readers-parse-dom),
  [W3C C27](https://www.w3.org/TR/WCAG20-TECHS/C27.html))

### 1.4 Occlusion / z-order reasoning

- Occlusion / z-order is a **known-hard problem for vision models** — studied mostly in layout-to-image
  generation, where "most existing methods lack explicit occlusion information … which makes the generation
  in intersection regions inherently ambiguous," motivating dedicated z-order machinery.
  ([OcclusionFormer arXiv 2605.21343](https://arxiv.org/abs/2605.21343)) VLM UI parsers (SoM/OmniParser)
  draw boxes but do **not** reason about which box is *on top*. In the browser, occlusion is **deterministic
  and free** via `document.elementFromPoint()` hit-testing — the exact mechanism DW already uses for
  `coveredBy` / `hitSelf`.

### 1.5 The a11y-tree-degradation literature (why the gap is real on legacy apps)

Modern component architectures and legacy apps both **degrade** the a11y tree that ARIA snapshots and
a11y-first agents depend on: design-system wrappers emit `div` soup with generated class names and no role;
elements appear with blank names / wrong roles; **virtualized lists render only visible rows so off-viewport
content is unreachable**; and client state updates visually while ARIA goes stale. Automated a11y tooling
catches only ~30–40% of issues; ~95.9% of pages have conformance errors.
([isagentready](https://isagentready.com/en/blog/how-ai-agents-see-your-website-the-accessibility-tree-explained),
[Deque: legacy apps](https://www.deque.com/blog/legacy-applications-and-accessibility/),
[UGround, §1.2](https://arxiv.org/html/2410.05243v1)) **Geometry, hit-testing, and pixel-diff do not
degrade with a11y quality** — every element still has a rect and can be hit-tested. That asymmetry is the
whole opportunity.

---

## 2. Candidate representations

All candidates are **DOM-derived** (produced in-page, no screenshot upload, no external model). They differ
in how much structure they impose and their token cost.

| # | Representation | Shape | Strength | Token cost |
|---|---|---|---|---|
| **A** | **Marked salient list** (SoM-over-DOM, but with occlusion+actionability) | flat list of ID'd nodes, each `@rect`, `coveredBy`, `offscreen`, verdict, recency | simplest; agent-consumable; cheap | low |
| **B** | **Spatial-hierarchy / region graph** | nodes nested by geometric containment; edges = `covers` / `contains` / `adjacent` | answers "what group is this in / near" | medium–high |
| **C** | **Layered / occlusion-first model** | elements bucketed by z-layer (base vs overlay); active overlay foregrounded | directly encodes "a modal is open covering X" | low–medium |
| **D** | **Coarse spatial-zone index** | each node tagged with a 3×3 / grid zone ("top-right", "row 2") instead of raw pixels | cheap positional disambiguation, resolution-robust | very low |
| **E** | **Fusion (recommended): A/C + recency overlay + zone tags** | marked salient list, z-layer-grouped, zone-tagged, recency-marked, verdict-annotated | the "screenshot-equivalent": position + coverage + readiness + what-changed | low–medium |

**Why A/C/D over B:** a full region graph (B) is the most "complete" but is the most tokens and re-invents
what the a11y tree already nests; it drifts toward reskin. The differentiated value concentrates in
occlusion (C), cheap position (D), and recency — so the recommended fusion (E) is A's flat list *enriched
with* C's z-layers and D's zones, not a heavyweight graph.

---

## 3. How DW's existing primitives enable it

DW **already computes every field** of the fused model — but today only for the *changed* nodes in a
post-action delta, and it renders only geometry + verdict, not a full-page map. The building blocks
(`src/host/types.ts`, `src/host/serialize.ts`, `src/injected/observer.ts`):

| Field in the map | DW primitive that already produces it |
|---|---|
| viewport-relative `rect` (x,y,w,h) | `GeometryRead.rect` via `getBoundingClientRect`, rounded |
| **occlusion `coveredBy`** (what overlays this) | `GeometryRead.coveredBy` via `elementFromPoint(center)` hit-test |
| **`hitSelf`** (is this the topmost element at its center) | `GeometryRead.hitSelf` |
| `offscreen` / `inViewport` | `GeometryRead.offscreen`, `GeometryRead.inViewport` |
| stale/moved-rect flag | `GeometryRead.stable` (opt-in `rectRecheckMs`) |
| role / name / `interactive` | `RawNode.role` / `name` / `interactive` |
| a11y **state** (`aria-expanded` false→true = "menu open") | `RawNode.stateChanges`, `ariaLive` |
| **actionability + geometry-vs-Playwright disagreement** | `Actionability.{verdict, reason, geometryVerdict, agreed}` |
| **recency** ("this just changed", added/removed/changed) | `Delta.nodes[].kind` + the whole delta |
| on-demand single-element geometry | `probeGeometry(el)` (stateless, works without a prior action) |
| render to compact indented text | `serialize()` patterns in `serialize.ts` |

**What is missing is only the "scan" mode + a map serializer.** Today `actAndObserve` reports *what
changed*; `probeGeometry` reads *one* element. The page model needs a **third mode**: probe a *set* of
salient elements (interactive + recently-changed + landmarks) in one in-page pass and emit the fused map.
That is a moderate generalization of the geometry read the observer already performs per changed node —
the honest, hard part (occlusion via hit-testing, actionability reconciliation, recency) is **already
built and validated**; only the *coverage* (all salient nodes, not just changed ones) is new.

---

## 4. Honest differentiation check — new, or a reskin?

The charter's hard constraint: don't re-ship Playwright's ARIA snapshot or OmniParser under a new name.
Auditing the fused model **field by field**:

| Field | Also in ARIA snapshot / MCP? | Also in OmniParser / SoM? | Verdict |
|---|---|---|---|
| role / name / a11y state | **Yes (this IS the ARIA snapshot)** | partial (captions) | **Reskin if led with — BORROW, don't re-derive** |
| hierarchy / nesting | Yes (a11y containment) | no | Reskin risk — keep as annotation |
| `rect` (x,y,w,h) | No | Yes (vision boxes) | Overlaps OmniParser, but DW's are exact + free (DOM, not inferred) |
| **`coveredBy` / z-layer (occlusion)** | **No** | **No** (explicitly absent) | **NEW — nobody has this as a deterministic field** |
| **`hitSelf` / topmost** | No | No | **NEW** |
| **actionability + geom-vs-PW disagreement** | No | No | **NEW** |
| **recency / change-delta fused with position** | No | No (no deltas) | **NEW** |
| `offscreen` / virtualized-row honesty | No | No | **NEW-ish** (explicit off-viewport marking) |

**Conclusion — genuinely differentiated, conditionally.** The model is *not* a reskin **iff** it:
1. **Leads with the four NEW fields** — occlusion (`coveredBy`/z-layer), `hitSelf`, actionability-
   reconciliation, recency — and treats role/name/hierarchy as *annotations*.
2. **Borrows semantics from Playwright** (compose its ARIA snapshot / MCP refs) rather than re-deriving the
   a11y tree. DW's job is the *spatial + dynamic + actionability overlay on top*, not a second a11y tree.
3. Is honest that its `rect` overlaps OmniParser's boxes — but wins by being **exact, deterministic, free,
   offline, and carrying occlusion + actionability + recency that OmniParser explicitly lacks**, and by
   needing **no screenshot upload and no YOLO/BLIP/SAM weights**.

**The closest DIY baseline is "Playwright ARIA snapshot + `boundingBox()` per ref."** DW beats it three
ways, which is the honest boundary of the contribution: (a) **occlusion** — `boundingBox` never tells you
*what covers* a node or which of two overlapping boxes is on top; DW's `elementFromPoint` does; (b)
**actionability reconciliation** — "looks clickable, but Playwright can't click it because covered-by an
overlay glass pane" is a field no snapshot carries; (c) **one in-page pass + recency** — DW computes the
whole map in a single `evaluate` and fuses "what just changed," instead of N boundingBox round-trips with
no delta. **If DW ever ships role+name+hierarchy as the headline, it is an ARIA-snapshot reskin and should
be discarded** (per charter).

**Where the differentiation is largest: legacy / poor-a11y apps and overlay occlusion.** When the a11y tree
is div-soup with blank names and wrong roles (§1.5), the ARIA snapshot and a11y-first agents degrade — but
geometry + hit-testing are unaffected. DW can answer "which of three look-alike buttons is the live one"
by **position** and "is this control actually reachable" by **`coveredBy`**, precisely where the a11y model
is blind. The proven "covered-by an overlay glass pane" precision (a DW keep-strength, `00-FINDINGS-BACKLOG.md`)
is the small-scale proof this scales to a full-page map.

---

## 5. Feasibility + risks

**Feasibility: high.** Every field exists and is validated; the new surface is (1) a full-page **scan**
that probes a *bounded set* of salient nodes in one in-page pass, and (2) a **map serializer** reusing
`serialize.ts` patterns. No new browser capability, no model, no network.

**Risks / honesty guardrails:**
- **Cost of hit-testing many nodes.** `elementFromPoint` per element forces layout; O(n) over the whole DOM
  is too slow. **Mitigation:** cap the candidate set to *salient* nodes — interactive + recently-changed +
  landmark/heading roles — not every element. This also keeps tokens low. Make the scan opt-in and bounded.
- **Center-point occlusion is a heuristic.** `elementFromPoint(center)` catches full center-coverage but
  misses *partial* overlap (a node covered only at an edge). **Mitigation:** label the field's scope
  honestly ("center hit-test"); optionally sample a few points; never claim more than was tested (DW-03
  honesty contract: observe/label, never fabricate).
- **Virtualized / off-viewport content is invisible** — the same limitation every representation has (§1.5).
  **Mitigation:** DW's advantage is it can *explicitly mark* `offscreen`/out-of-viewport rather than
  silently drop, so the agent knows to scroll rather than conclude "absent."
- **z-layer inference from `coveredBy` chains is approximate** (not a true paint order). Present it as
  "apparent layering from hit-tests," not a claim about CSS `z-index`.
- **Reskin drift** (the biggest *product* risk) — if the map's headline becomes role+name+hierarchy, it is
  the ARIA snapshot. **Mitigation:** the serializer must foreground geometry+occlusion+actionability+recency
  and pull semantics from Playwright's snapshot, never re-implement a11y-name computation.
- **Cross-frame / closed shadow DOM** — partial capture (already flagged by DW as
  `crossBoundarySkipped`); carry that honesty into the map.
- **Token budget vs richness** — a raw-pixel `@rect` per node is heavier than a zone tag. Offer both a
  precise (`@x,y wxh`) and a coarse (`zone`) rendering so agents can trade cost for precision.

---

## 6. Recommended direction + minimal prototype sketch

### 6.1 Direction

Build a **DOM-derived "marked page map"** = candidate **E** (flat marked salient list, z-layer-grouped,
zone-taggable, recency- and actionability-annotated). Position it as the **spatial + dynamic + actionability
overlay on top of Playwright's own semantic snapshot**, not a replacement a11y tree. Ship it as a new host
primitive `pageMap(page, opts)` + a `renderPageMap()` serializer, reusing the geometry/occlusion/actionability
machinery DW already has. **Lead with occlusion, actionability-reconciliation, and recency; borrow role/name
from Playwright.** Target the legacy / poor-a11y + overlay-occlusion wedge as the differentiated use case.

### 6.2 Representation schema (draft)

```ts
interface PageMap {
  url: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  // salient nodes only: interactive + recently-changed + landmark/heading roles
  nodes: PageMapNode[];
  // apparent stacking inferred from hit-tests: base layer 0, each overlay a higher layer
  layers: { layer: number; label: string | null; nodeRefs: string[] }[];
  stats: { scanned: number; occludedCount: number; offscreenCount: number; capped: boolean };
  partial?: { crossBoundarySkipped?: number; injectionBlocked?: boolean }; // honesty flags
}

interface PageMapNode {
  ref: string;                      // reused DW ref; interop with Playwright aria-ref where available
  role: string | null;             // BORROWED from Playwright's ARIA snapshot, not re-derived
  name: string | null;             // "
  interactive: boolean;
  rect: Rect;                       // exact, from getBoundingClientRect
  zone: string;                    // coarse: e.g. "top-right", "center", "row3/col2" (cheap disambiguation)
  layer: number;                    // apparent z-layer (0 = base; >0 = on an overlay)
  coveredBy: string | null;         // NEW vs everyone: what overlays this node (or null)
  hitSelf: boolean;                 // is this the topmost element at its own center
  offscreen: boolean;               // explicitly marked, not dropped
  actionable: 'ACTIONABLE' | 'NOT-actionable' | 'n/a';
  actionabilityReason: string | null;      // e.g. "covered-by <overlay>"
  geomDisagreesWithPlaywright: boolean;     // the signal DW exists to surface
  recency: 'added' | 'removed' | 'changed' | null; // fused change-delta; null = pre-existing
  state?: Record<string, string>;   // a11y-state transitions (aria-expanded, etc.)
}
```

**Compact rendered form** (what an LLM/author reads — one line per node, occlusion & readiness up front):

```
page-map @ 1280x800 (scroll 0,0)  [layer0 base | layer1 overlay "Confirm dialog"]
 L1  button "Confirm" [e12] @center 640,420 88x36  ACTIONABLE  *added*
 L1  button "Cancel"  [e13] @center 760,420 88x36  ACTIONABLE
 L0  button "Save"    [e4]  @top-right 1180,60 72x32  NOT-actionable (covered-by overlay "Confirm dialog") [geom:NOT]
 L0  textbox "Search" [e2]  @top 320,60 400x32  ACTIONABLE
 L0  link "Row 42 …"  [e57] offscreen (below fold) — scroll to reach
(scanned 46, occluded 1, offscreen 12, capped false)
```

This reads like a picture: *what's on top* (layer 1 = the dialog), *what's covered and therefore not
clickable* (Save, behind the dialog), *what just changed* (`*added*` Confirm/Cancel), *where things are*
(zones), and *what you can act on now* — none of which the ARIA snapshot, MCP snapshot, SoM, or OmniParser
provide together, all deterministic, offline, and token-cheap.

### 6.3 How it's produced

1. **Collect candidates in-page (one `evaluate`).** Extend the injected script with a `scan(scope)` that
   selects salient nodes (interactive elements, landmark/heading roles, and — if a delta exists — the
   changed refs), then runs the *existing* per-node geometry read (`rect`, `elementFromPoint` occlusion,
   `hitSelf`, `offscreen`) on each. Cap the set (e.g. ≤ N) and set `capped`.
2. **Infer apparent layers.** Group nodes whose `coveredBy` points at a common overlay ancestor into a
   higher layer; the overlay's own subtree is the top layer. Label the top layer from its role/name.
3. **Assign zones.** Bucket each `rect` centre into a coarse grid (configurable 3×3 or NxM) for the `zone`
   tag; keep the exact `rect` too.
4. **Reconcile actionability.** For interactive nodes, reuse `annotateActionability` to attach Playwright's
   authoritative verdict + the geometry-disagreement flag (Playwright wins — DW-02).
5. **Fuse recency.** If produced right after an `actAndObserve`, mark nodes present in the delta with their
   `kind`; otherwise `recency = null`.
6. **Borrow semantics.** Fill `role`/`name` from Playwright's ARIA snapshot / accessible name where present
   (do **not** re-implement a11y-name computation) — the honesty + anti-reskin guarantee.
7. **Serialize** with a new `renderPageMap()` (mirrors `serialize.ts`): occlusion/layer/actionability lead,
   role/name annotate, precise-or-zone rect selectable, honesty flags always shown.

**Effort:** the injected `scan` is a bounded loop over the geometry read DW already ships; the serializer is
a variant of the existing one; semantics are borrowed. The novel, hard parts (occlusion, actionability
reconciliation, recency) are **already built and live-validated**. This is assembly, not invention.

---

## Sources

- Playwright ARIA snapshots — https://playwright.dev/docs/aria-snapshots · https://github.com/microsoft/playwright/blob/main/docs/src/aria-snapshots.md
- Playwright MCP snapshots — https://playwright.dev/mcp/snapshots · https://github.com/microsoft/playwright-mcp
- Set-of-Mark prompting — https://arxiv.org/abs/2310.11441
- VisualWebArena — https://arxiv.org/pdf/2401.13649 · https://www.emergentmind.com/topics/visualwebarena-vwa
- WebVoyager — https://arxiv.org/html/2401.13919v3 · https://github.com/MinorJerry/WebVoyager
- OmniParser — https://arxiv.org/html/2408.00203v1 · https://github.com/microsoft/OmniParser · https://www.microsoft.com/en-us/research/articles/omniparser-for-pure-vision-based-gui-agent/
- UGround / SeeAct-V — https://arxiv.org/html/2410.05243v1 · https://osu-nlp-group.github.io/UGround/
- Ferret-UI — https://arxiv.org/abs/2404.05719 · https://machinelearning.apple.com/research/ferret-ui
- browser-use element detection — https://deepwiki.com/browser-use/browser-use/5.3-interactive-element-detection · https://github.com/browser-use/browser-use
- Beyond Pixels: DOM Downsampling (D2Snap) — https://arxiv.org/html/2508.04412v1
- UI layout graphs / hierarchical positional encodings — https://arxiv.org/pdf/2511.19380 · https://towardsdatascience.com/improving-ui-layout-understanding-with-hierarchical-positional-encodings-b19e1e9235e/
- Tree-of-Lens / ScreenPR — https://arxiv.org/abs/2406.19263
- Screen-reader reading order vs visual order — https://testparty.ai/blog/how-screen-readers-parse-dom · https://www.w3.org/TR/WCAG20-TECHS/C27.html
- Occlusion / z-order reasoning (OcclusionFormer) — https://arxiv.org/abs/2605.21343
- a11y-tree degradation on modern/legacy apps — https://isagentready.com/en/blog/how-ai-agents-see-your-website-the-accessibility-tree-explained · https://www.deque.com/blog/legacy-applications-and-accessibility/
- Accessibility-tree token cost / formatting — https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a
</content>
</invoke>
