# Similo family — Similo → VON Similo → VON Similo LLM → LTR (JSS 2025) → Kluge & Stocco EMSE 2026 (HybridSimilo)

Every number is from the local full texts in §10 (plus the Similo replication-package source `WidgetLocator.java`). Unverifiable items are marked UNVERIFIED.

## 1. What it does

**Similo (Nass, Alégroth, Feldt, Leotta, Ricca — TOSEM 32(3) 2023; arXiv 2208.00677).** Re-identifies a *target* element recorded in an old DOM inside a new DOM: every visible candidate gets a weighted sum of 14 per-attribute similarities (DOM identity + rendered geometry + text context) and the arg-max is returned. On 598 targets from 40 Alexa-top-US homepages with 12–60-month gaps it fails on 72/598 (12%) vs 146/598 (24%) for the theoretical-limit multi-locator baseline (LML); ~3 ms per localisation.

**VON Similo (Nass, Alégroth, Feldt, Coppola — ICST 2023; arXiv 2301.03863).** One visual widget is usually several overlapping DOM nodes (a > span > span). Groups nodes whose screen rectangles have IoU ≥ 0.85 plus centre containment, lifts every property to the group's value list, and scores each attribute by the best pairwise match. Evaluated as a *binary classifier* on 1,163 matching + 1,163 non-matching pairs: accuracy 94.1% (thr 0.40) vs Similo 82.3% (thr 0.28); abstract says 94.7% vs 83.8% (+10.9 pp), conclusion "+9.9%". Also censuses which of 170 W3C attributes are populated.

**VON Similo LLM (Nass, Alégroth, Feldt — STVR 2024).** VON Similo ranks; the top-10 candidates plus target go to GPT-4 as one-line JSON; GPT-4 returns the winning id. On 804 pairs / 48 apps failures drop 70 → 40 (91.3% → 95.0%, −42.9%) at 1,934 ms (SD 537) vs 29 ms and $35.86 total (~$0.045/prompt).

**Ranking approaches (Coppola, Feldt, Nass, Alégroth — JSS 222:112286, 2025).** Similo as a ranking problem: 1,000 random weight vectors per variant (Similo 14 / VON 14 / Full 22 attrs), then LogReg, RandomForest and XGBoost learning-to-rank on the per-attribute similarities; best MeanRank 1.57, PctAt1 88.46%, PctAt10 98.87% on the 1,163-pair VON set.

**Kluge & Stocco (EMSE 31(6) 2026).** Replicates Similo and VON Similo on all three original benchmarks plus a new 10,376-pair / 30-site / 16-version benchmark at fixed 4-month gaps (Sept 2018–Sept 2023); optimises properties, similarity functions and weights with a genetic algorithm (Similo++, VON Similo++); proposes HybridSimilo (VON Similo++ shortlists 10 overlaps, Similo++ picks the exact node). Finds VON Similo *worse* than Similo at exact-node identification (77.5% vs 86.6%) and better only on overlap-tolerant metrics; optimisation lifts exact match 86.6% → 91.7% and broken-locator recovery 95.8% → 98.8% (4-month gaps). Ships a Selenium wrapper library.

**Nass et al. IST 2021 "Why many challenges … (will) remain"** — not on disk, Elsevier 403; not read.

## 2. Exact representation

**Candidate universe (Similo code).** One injected JS pass over `querySelectorAll('input,textarea,button,select,a,h1..h5,li,span,div,p,th,tr,td,label,svg')`, keeping nodes where `elementIsVisible()` holds, returning tag, className, type, name, id, value, href, textContent, placeholder, title, alt, x, y, width, height, child count, absolute XPath, id-relative XPath. x/y = upper-left corner via `getXPosition/getYPosition`; the helper `javascript.js` is not local, so page- vs viewport-relative is UNVERIFIED. No normalisation: Kluge reports that "browser versions and window size can alter coordinates, shapes and areas as well as neighboring text".

**14 locator parameters (code order; comparator; hand weight):** tag (equalsIgnoreCase, 1.5); class (Levenshtein, 0.5); name (equals, 1.5); id (equals, 1.5); href (Lev, 0.5); alt (Lev, 0.5); absolute XPath (Lev, 0.5); id-relative XPath (Lev, 0.5); is_button (equals, 0.5 — true iff tag=button, or input[type∈{button,submit,reset}], or `<a>` with "btn" in class); location (2-D distance, 0.5); area = w·h (integer sim, 0.5); shape = (w·100)/h integer (integer sim, 0.5); visible_text (Lev, 1.5 — first non-blank of textContent/value/placeholder, valid only if 3–50 chars, no newline/tab); neighbor_text (word overlap, 1.5). Max score 12. Weights: all 1.0, then +0.5 for the "stable" group (tag, name, id, visible text, neighbour text; from COLOR's stability data plus intuition), −0.5 for the rest.

**Similarity functions (code):** string = (len(longer) − Levenshtein)/len(longer), 0 if either empty; integer = (max − |a−b|)/max; **location = max(0, 100 − √(dx²+dy²))/100 — linear, 0 beyond 100 px** of upper-left displacement; neighbour text = character-weighted fraction of words of one string found in the other (equal, or prefix/suffix of each other), capped at 1. A value missing on either side contributes 0.

**Neighbour-text window (code only, not in the paper):** computed only for targets ≤ 100 px tall AND ≤ 600 px wide; neighbours = other extracted elements ≤ 100 px tall whose rectangle intersects the target rectangle dilated by 50 px on each side; their visible-text words are lower-cased, de-duplicated, space-joined.

**VON group (VON Similo §III; Kluge Alg. 2 l.51–57):** E1, E2 overlap iff IoU = |R1∩R2|/|R1∪R2| ≥ 0.85 (chosen "by experimenting") AND the centre of E2 lies in R1 (Kluge: the paper says "centre of W1", the code tests the other node; the LLM paper notes condition 2 is implied whenever the threshold > 0.5). Each property becomes the group's value list; VON-Similo(T,C) = Σ_i max_{t∈T.a_i, c∈C.a_i} sim(t,c)·c_i. Example: `<div class="sbib_b" id="sb_ifc50"><input id="search" name="search_query">` → `<div||input id="sb_ifc50||search" name="search_query">`.

**Textual overlap (LLM paper, formalised by Kluge):** also one unit if both visible texts are non-null, case-sensitively equal, and E1's absolute XPath is a prefix of E2's.

**Kluge's extended alphabet:** adds `type` (present 6–7%, stable 95–96%), `aria-label` (10–12%, 81–84%) and an `attributes` key→value map (Intersect-Value = |{(k,v)∈A∩B}|/max(|A|,|B|); Intersect-Key = Jaccard on keys). Strings: Equality, Levenshtein, Jaccard on char sets, Jaro-Winkler (p = 0.1, prefix ≤ 4), String-Set (Jaccard on lower-cased tokens). Distance: Linear (original), Manhattan/fixed max, exp-decay e^(−λd), λ ∈ {0.001, 0.005, 0.01}. Dimension: Area, Perimeter, Aspect-Ratio as min/max. Weights on a 0.05 grid in [0, 3]; 0 removes the attribute.

## 3. Algorithm

- **Similo:** extract once → score all candidates → arg-max (or sort). O(|C|·14); 0.01–0.02 ms/comparison, 2.96 ms/target single-threaded (Ryzen 9 3900X); 6.00 ms with 388 candidates (Amazon), 0.17 ms with 9.
- **VON Similo:** pairwise rectangle test clusters both sides (O(n²) as written), properties → lists, arg-max with max-over-pairs per attribute; the group score is shared by all members. 29 ms/localisation (LLM paper).
- **VON Similo LLM:** rank → top-10 → JSON (~1K chars each; GPT-4 8K context chosen over GPT-3.5's 4K) → one-shot prompt → id. 1,934 ms.
- **LTR:** the 14 similarities are the feature vector; 10-fold CV by application; XGBoost pairwise/map/ndcg (100/200 trees), LogReg, RandomForest.
- **Similo++ / VON Similo++:** greedy per-property similarity-function choice in random order over several rounds, brute force over ties, then a GA over weights against fitness M3/M4/M6; temporal 5-fold CV moved results by only 0.1%.
- **HybridSimilo:** VON Similo++ top-10 overlaps → Similo++ picks the node. 280,233 localisation attempts total.

## 4. Act step and verification

No paper performs an action. Oracles are XPath comparisons: Similo accepts the oracle XPath ± one trailing step (parent/child tolerance, explicitly because it may return the `div` inside the target `a`); the LLM paper accepts any XPath in the returned group; Kluge's M4 requires the exact node. VON Similo's own metric is pairwise classification under a normalised-score threshold, which Kluge shows does not transfer to localisation (|C| ≈ 800 ⇒ 0.97^799·0.92 ≈ 0).

The act-relevant caveat is Kluge's T4: all nodes in an overlap group get the same score, so VON Similo "selects a random element from the visual overlap" — fine for a click, unsafe for `sendKeys`, reading a value or asserting an attribute. HybridSimilo exists to restore node identity. Kluge's library wraps a Selenium locator, falls back to Similo on failure, caches properties in SQL, refreshes them after each success, re-picks the most stable of XPath/ID/ID-XPath, and "issues configurable warnings when low score matches occur" — the only runtime check in the family. Similo itself has no threshold and always returns something; the authors name the synchronisation consequence (a not-yet-rendered target is matched to a wrong node) and sketch, but do not implement, a threshold + re-poll loop.

## 5. Quantitative results

| method | dataset | metric | number | condition |
|---|---|---|---|---|
| abs XPath / id-rel XPath / Selenium IDE / Montoto / ROBULA+ | Similo 598 (40 sites, 12–60 mo) | non-located | 79 / 59 / 47 / 46 / 35% | single locators |
| LML theoretical limit | same | non-located | 146/598 = 24% | any of 5 correct |
| Similo (hand weights) | same | non-located | 72/598 = 12% | ±1-step XPath oracle; better on 24 sites, worse on 4 (by 1), tie 13 |
| Similo | same | time | 2.96 ms/target | 1 thread |
| Similo | VON set 1,163+1,163 | P / R / Acc | 0.796 / 0.898 / 0.823 | thr 0.28; P 1.0 & R 0.265 at 0.60 |
| VON Similo | same | P / R / Acc | 0.968 / 0.922 / 0.941 | thr 0.40; P 1.0 & R 0.475 at 0.60 |
| Similo vs VON | same, per-app (33) | Acc | 78.3 vs 88.0% | Wilcoxon p = 0.00016; AUC 0.88 vs 0.91 |
| attribute census | 40 sites | populated | 35 of 170 W3C attrs | XPath, ID-XPath variability×presence = 1.0; then class, text, href, id, tag |
| VON Similo | 804 pairs / 48 apps | located | 734 (91.3%), 29 ms | group XPath = oracle |
| VON Similo LLM (one-shot, top-10) | same | located | 764 (95.0%), 1,934 ± 537 ms, $35.86 | both right 724; LLM-only 40; VON-only 10; 13 answers outside top-10 (top-20 adds 5) |
| zero- vs one-shot | 70 VON-failed | located | 37 vs 41 (52.9 vs 58.6%) | |
| GPT-4 motivations | 428 for 70 cases | share | 47% context, 17% semantic, 36% comparison-op | |
| Similo standard weights | JSS 1,163 | MeanRank / At1 / At3 / At10 | 4.28 / 88.00 / 91.86 / 95.70 | 1,000 random sets: At1 best 90.50, mean 84.07, worst 74.89; best MeanRank 1.77 |
| VON standard | same | MeanRank / At1 / At3 / At10 | 3.13 / 85.52 / 93.34 / 97.06 | best At1 87.56; best MeanRank 1.89 |
| Full-Similo (22) | same | At1 | best 92.08, mean 88.59 | best MeanRank 2.71 |
| XGBoost ndcg (Similo) / XGB-200 ndcg (VON) | same, 10-fold | MeanRank / At1 | 1.570 / 88.462% ; 1.765 / 85.747% | At10 best 98.869; RF: VON MR 1.937 vs Similo 2.740 |
| replication | Similo bench 809 / LLM bench 803 | located | 88.99% (orig 88.64) / 91.65% (orig 91.29) | Kluge RQ0 |
| Similo / VON / Similo++ / Hybrid | Similo bench (809; 510 broken) | M4 exact | 86.6 / 77.5 / 90.7 / 91.7% | M5 broken-only 79.6 / 69.2 / 85.5 / 86.8% |
| VON Similo++ (M3-tuned) | same | M3 / M4 | 94.6% / 66.7% | overlap tuning kills exactness |
| HybridSimilo | LLM bench | M3 | 95.51% | vs LLM VON Similo 95.0% |
| Similo / VON / Similo++(Ext,M6) | Extended 10,376 (4-mo; 2,012 broken) | M4 exact | 99.0 / 91.0 / 99.7% | M5 95.8 / 83.9 / 98.8%; Tag+Text ≈ 82% (stated) |
| preliminary | unspecified | direct / top-5 | VON 85.5 / 95.5%; Similo 88 / 94% | Kluge §4.3.3 |

## 6. Invariances shown / NOT shown

- **Shown — DOM-structure drift** (index shifts, wrapper insertion, tag renames) over 1–5-year gaps; the ±1-step oracle tolerance itself shows returned nodes are often the parent/child.
- **Shown — small positional drift:** Kluge's "Minor change" class is ≤ 10 px shift and ≤ 5 px size change with same tag/text/attributes; 4-month gaps give 99.0% exact. Location similarity is linear to 100 px; beyond that the match must be carried by text/attributes.
- **Shown — which-node-in-the-widget ambiguity** via VON groups (M3 94–99%).
- **Shown — weight sensitivity:** random weights swing Similo At1 74.9–90.5%; hand weights sit between mean and best.
- **Shown — what survives optimisation (Kluge Table 3):** name 2.85–2.90, visible text 2.50–2.95, type 1.10–2.85, attributes map 1.00–2.50, neighbour text 1.00–2.30, location 1.20–2.15, aria-label 0.90–2.95; class and is_button dropped in most configs; absolute XPath 0.05–1.05. Location function chosen: exp-decay λ=0.005 (Ext M6), Manhattan (Sim M4), Linear (Sim M3), decay λ=0.001 (VON).
- **NOT shown — viewport/DPR/window invariance:** raw pixels; Kluge saw coordinate, area and neighbour-text drift from merely re-rendering the same snapshot. No responsive layouts.
- **NOT shown — dynamic state, non-homepage pages, tables/selects, iframes/shadow DOM, actions, synchronisation:** all benchmarks are static Wayback homepages.
- **NOT shown — icon-only widgets:** Similo dropped image hashes for speed; Kluge's error analysis names swapped look-alike icons as unfixable without visual features.
- **NOT shown — semantic text equivalence** ("Save"→"Store", input[type=button]→button) without the LLM.

## 7. Failure modes (as reported)

1. **Repeated siblings:** Aliexpress "Home & Garden" mapped to "Home Improvement" (Lev 0.43) not "Home" (0.30) although XPaths favoured the right sibling (0.91 vs 0.89); 3.21 vs 3.12. Same `dl[n]/dt/span` menu recurs in the LLM paper's prompt. 72/598 Similo failures overall, not classified.
2. **Always returns something:** wrong match if the target is absent/unloaded; test "will break at an arbitrary point" (Kluge). Thresholds cost recall (0.265/0.475 at 0.60).
3. **Tag change dominates:** "Join" `<a>`→`<button>` loses to same-tag "Sign Up Free"; "Log in" `<button>`→`<span>`.
4. **Position outweighs text:** new "Sign up" at the old "Log in" spot is chosen; GPT-4 made the same argument.
5. **Icon swaps** (Kluge).
6. **Group ambiguity:** VON exact match 77.5% (Similo bench) / 91.0% (extended), 66.7% when overlap-tuned.
7. **Silent false positives from structural CSS** (`li:nth-child(2) > a` returns "Support" instead of the phone link).
8. **LLM-specific:** 13/804 outside the shortlist; 10 regressions vs VON; bigger lists broke output format; ~2 s latency.
9. **Long gaps cap the family at ~88–92% exact;** 4-month gaps give 99%+ — hence the library refreshes stored properties.

## 8. What to borrow for a DOM-first geometric web locator (Playwright / CDP)

1. **Page census via `DOMSnapshot.captureSnapshot({computedStyles:[…], includeDOMRects:true})`** instead of Similo's injected `querySelectorAll` + per-node rect: every node's box, text and attributes in one round-trip. Filter to rendered nodes; convert to page coordinates with `scrollX/Y`; record viewport + DPR so location can be rescaled — the family never did and Kluge measured the drift.
2. **Fingerprint = Similo++ Ext-M6 vector, not the 14 originals:** name 2.85 Lev, visible text 2.80 Lev, type 2.75 eq, alt 1.85 eq, attributes-map 1.80 intersect-value, neighbour text 1.45 string-set, location 1.20 e^(−0.005·d), href 0.95 eq, aria-label 0.90 Jaccard, tag 0.80 Jaccard, id 0.50, id-XPath 0.45, area 0.35, abs-XPath 0.10, class/is_button 0. Accessible name from an aria snapshot can stand in for aria-label/visible text.
3. **Neighbour-text window exactly as coded:** dilate the box by 50 px, only for targets ≤ 100 px tall and ≤ 600 px wide, neighbours ≤ 100 px tall, token-set similarity. It is the family's only spatial-relation feature and keeps weight ≥ 1.0 under every optimisation; add directional bins (left/above), which the family never did.
4. **VON rule (IoU ≥ 0.85 ∧ centre containment) as a *hit-target* abstraction, not identity:** group boxes from the snapshot for click targets and score pooling, but keep the exact node (HybridSimilo) for `fill`, `inputValue`, attribute asserts. Kluge's data: hybrid ≈ Similo++ on short gaps, helps only on redesigns — group is fallback, not primary.
5. **Act = `page.mouse.click(cx, cy)` on the matched box centre (or `locator.click()` on the resolved node), verify with `document.elementFromPoint(cx, cy)` ∈ matched group;** for type/assert, check the resolved node's tag/`type` against the stored `type`/`is_button` first. This closes the loop the papers leave open.
6. **Score policy:** normalise by achievable max (the code's `calcMaxSimilarityScore` sums only weights of attributes the candidate has); keep the ranked list; gate on an absolute threshold (VON 0.40 ⇒ P 0.968) *and* the top-1/top-2 margin; on low margin re-poll before falling back (Similo §6 sketch); emit Kluge-style low-score warnings.
7. **Self-refresh after every success** (Kluge library): 4-month-gap 99.7%/98.8% vs 1–5-year 91.7% is the biggest lever in the family.
8. **LLM tie-break only on the top-10 and only on low margin:** −43% failures at 2 s / $0.045; shortlist quality bounds the gain (13/804 missed).

**Avoid:** absolute-XPath Levenshtein as a heavy feature (tuned to 0.05–0.10); `class`, `is_button` (dropped); the hard 100-px linear cutoff (replaced in every tuned config); node choice by group score for anything but clicks; the VON threshold-classifier metric as a localisation proxy; per-element screenshots in the hot path (Similo rejected for time); raw pixel coordinates across viewports.

## 9. Open questions

- No viewport/DPR/responsive normalisation of location/area/shape; the 100-px saturation was intuition and no sensitivity curve is reported for its decay replacements.
- No directional/relational geometry (left-of, above, contained-in, aligned); spatial context is an undirected 50-px word bag.
- Group→node disambiguation only partially solved (Hybrid ≈ Similo++ on extended); textual overlap never evaluated alone.
- Static Wayback homepages only: no dynamic state, shadow DOM, iframes, tables/selects, actions, or an implemented/tested threshold-retry policy.
- Icon-only widgets unaddressed; no visual features tried since image hashes were dropped.
- VON's gain is metric-dependent (+10.9 pp as classifier, −9 pp exact match); IoU 0.85 untested on modern large hit areas/overlays.
- LLM step irreproducible (GPT-4 version/temperature unspecified); its 10 regressions unexplained.
- Optimised weights fit 30 popular homepages; per-framework/per-app tuning hypothesised, not shown.

## 10. Sources read

| title | where | depth |
|---|---|---|
| Similo — "Similarity-based web element localization for robust test automation" (TOSEM 2023; arXiv 2208.00677) | `geo-research/similo.txt` + `geo-research/WidgetLocator.java` | full-text + code |
| VON Similo — "Robust web element identification for evolving applications by considering visual overlaps" (ICST 2023; arXiv 2301.03863) | `geo-research/vonsimilo.txt` | full-text |
| VON Similo LLM — "Improving web element localization by using a large language model" (STVR 2024) | `geo-research/verify-rl/vonllm.txt` | full-text (§I–VII; threats/refs skimmed) |
| Coppola et al. — "Ranking approaches for similarity-based web element location" (JSS 222:112286, 2025) | `geo-research/rl/coppola_jss2025.txt` | partial (abstract, §4, §5 Tables 1–2, §6) |
| Kluge & Stocco — "Web Element Relocalization in Evolving Web Applications: A Comparative Analysis and Extension Study" (EMSE 31(6) 2026) | `geo-research/2026-Kluge-EMSE.txt` | full-text |
| Nass et al. — "Why many challenges with GUI test automation (will) remain" (IST 2021) | not on disk (Elsevier 403); bibliography entry only | not read |
