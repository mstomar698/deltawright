// Deltawright injected page script. Bundled by esbuild into a self-contained IIFE
// and installed as window.__deltawright. Runs entirely in the page.
//
// Responsibilities (the "arm -> settle -> collect" side that must live in the page):
//   - arm():          start ONE MutationObserver, buffering raw records.
//   - waitForSettle(): the settle heuristic (structural quiescence, tunable). SEE NOTE.
//   - collect():      stop, coalesce records into a net set of changed elements,
//                     wait for animations so geometry is final, then read
//                     geometry + elementFromPoint for each and stamp data-dw-ref.
//
// It knows NOTHING about Playwright actionability — that reconciliation happens in
// the host. This file only produces the geometry-based half of the delta.

import type {
  RawNode,
  GeometryRead,
  ChangeKind,
  SettleOptions,
  SettleResult,
  CollectResult,
  BaselineOptions,
} from '../host/types';

interface DeltawrightApi {
  arm(): void;
  sampleBaseline(opts: BaselineOptions): Promise<{ sampledMs: number; footprintSize: number }>;
  waitForSettle(opts: SettleOptions): Promise<SettleResult>;
  collect(opts: SettleOptions): Promise<CollectResult>;
  reset(): void;
}

declare global {
  interface Window {
    __deltawright?: DeltawrightApi;
  }
}

(function install() {
  if (window.__deltawright) return; // idempotent

  let observer: MutationObserver | null = null;
  let records: MutationRecord[] = [];
  let firstMutationAt: number | null = null;
  let lastMutationAt: number | null = null;
  // Structural = a childList mutation that adds/removes ELEMENT nodes. Background
  // churn (attribute changes + text-node updates) is NOT structural, so tracking
  // structural quiescence lets settle resolve on a live-ticking page (#13).
  let lastStructuralAt: number | null = null;
  let sawStructural = false;
  let armStart = 0;

  // Background footprint (#15, causal attribution): the (element -> channels) that
  // were ALREADY churning before the action. Populated by sampleBaseline; consumed
  // and cleared by collect. `bgText` = elements with recurring text churn; `bgAttr`
  // = per-element set of attribute names with recurring churn. Excluding these keeps
  // the delta to the action's effect instead of the whole live page.
  let bgText = new Set<Element>();
  let bgAttr = new Map<Element, Set<string>>();

  // Open shadow roots the observer is attached to (web components), so shadow-DOM
  // changes appear in the delta. Reset per arm; observer.disconnect() clears them. (#19)
  let observedRoots = new Set<ShadowRoot>();

  const isElement = (n: Node): n is Element => n.nodeType === 1;
  const isText = (n: Node): n is Text => n.nodeType === 3;

  const listHasElement = (list: NodeList): boolean => {
    for (const n of list) if (n.nodeType === 1) return true;
    return false;
  };

  const OBSERVE_OPTIONS: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  };

  // Attach the observer to every OPEN shadow root at/under `root` (recursively), so
  // web-component internals are observed. Closed shadow roots are inaccessible. (#19)
  function observeShadowRoots(root: ParentNode): void {
    if (!observer) return;
    const check = (el: Element) => {
      const sr = el.shadowRoot;
      if (sr && !observedRoots.has(sr)) {
        observedRoots.add(sr);
        observer!.observe(sr, OBSERVE_OPTIONS);
        observeShadowRoots(sr);
      }
    };
    if (root instanceof Element) check(root);
    for (const el of root.querySelectorAll('*')) check(el);
  }

  function onMutations(muts: MutationRecord[]): void {
    const now = performance.now();
    if (firstMutationAt === null) firstMutationAt = now;
    lastMutationAt = now;
    for (const m of muts) {
      records.push(m);
      if (m.type === 'childList') {
        if (listHasElement(m.addedNodes) || listHasElement(m.removedNodes)) {
          lastStructuralAt = now;
          sawStructural = true;
        }
        // A newly added element may host (or contain) open shadow roots to observe.
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) observeShadowRoots(n as Element);
        });
      }
    }
  }

  function arm(): void {
    reset();
    // Clear stale refs from a prior action so ids (e1, e2, ...) can't collide
    // across sequential actions on one page load. Done before observe(), so
    // these removals are not themselves recorded.
    document.querySelectorAll('[data-dw-ref]').forEach((el) => el.removeAttribute('data-dw-ref'));
    armStart = performance.now();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, OBSERVE_OPTIONS);
    observeShadowRoots(document); // open shadow roots (web components)
  }

  function reset(): void {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    records = [];
    firstMutationAt = null;
    lastMutationAt = null;
    lastStructuralAt = null;
    sawStructural = false;
    observedRoots = new Set();
  }

  function stop(): void {
    if (observer) {
      const pending = observer.takeRecords();
      if (pending.length) onMutations(pending);
      observer.disconnect();
      observer = null;
    }
  }

  // --- Settle detection (v0.5) --------------------------------------------
  // LABELED, TUNABLE heuristic (design-watch DW-01). Two quiescence signals:
  //   - STRUCTURAL quiescence: once a structural change (element add/remove) is seen,
  //     wait until no NEW structural change for `quietMs`. Background ticker churn
  //     (attribute/text) is not structural, so this resolves promptly on a LIVE page
  //     and still waits through a delayed insert (the insert IS the structural signal).
  //   - ANY quiescence: the DOM is fully quiet for `quietMs` (the quiet-page path). It
  //     never fires on a continuously-churning page, so it cannot settle early there.
  // Resolve on either, or at the `maxWaitMs` cap. `*At` start null so "nothing yet"
  // never counts as settled (defeats the delayed-insert trap).
  //
  // Known residuals (→ #15 causal attribution): (1) a purely non-structural
  // (attribute/text-only) action effect on a live page can't be told apart from
  // background churn and waits to the cap; (2) background churn that ADDS elements
  // every tick (toasts, virtualized lists) reads as structural — a recurrence-footprint
  // refinement (classify a repeatedly-inserted container as background) is future work.
  function waitForSettle(opts: SettleOptions): Promise<SettleResult> {
    const start = performance.now();
    const deadline = start + opts.maxWaitMs;
    return new Promise<SettleResult>((resolve) => {
      const check = () => {
        const now = performance.now();
        const structuralQuiet =
          sawStructural && lastStructuralAt !== null && now - lastStructuralAt >= opts.quietMs;
        const anyQuiet = lastMutationAt !== null && now - lastMutationAt >= opts.quietMs;
        const capped = now >= deadline;
        if (structuralQuiet || anyQuiet || capped) {
          resolve({
            settleMs: Math.round(now - armStart),
            hitMaxWait: capped && !structuralQuiet && !anyQuiet,
          });
          return;
        }
        setTimeout(check, Math.min(opts.quietMs, 25));
      };
      check();
    });
  }

  // --- Baseline (causal attribution, #15) ----------------------------------
  function noteBackground(m: MutationRecord): void {
    if (m.type === 'attributes' && isElement(m.target)) {
      const name = m.attributeName ?? '';
      (bgAttr.get(m.target) ?? bgAttr.set(m.target, new Set<string>()).get(m.target)!).add(name);
    } else if (m.type === 'characterData') {
      const parent = (m.target as CharacterData).parentElement;
      if (parent) bgText.add(parent);
    } else if (m.type === 'childList' && isElement(m.target)) {
      // textContent updates land as text-node childList churn on the parent element.
      m.addedNodes.forEach((n) => {
        if (isText(n) && n.parentElement) bgText.add(n.parentElement);
      });
      m.removedNodes.forEach((n) => {
        if (isText(n)) bgText.add(m.target as Element);
      });
    }
  }

  // Observe the page briefly BEFORE the action to learn what is already churning, so
  // background can be excluded from the delta. Early-exits on a quiet page so it adds
  // little latency there. Never drops the action's real change: it only excludes
  // (element, channel) pairs that were recurring before the action existed.
  function sampleBaseline(
    opts: BaselineOptions,
  ): Promise<{ sampledMs: number; footprintSize: number }> {
    bgText = new Set();
    bgAttr = new Map();
    return new Promise((resolve) => {
      let sawAny = false;
      const obs = new MutationObserver((muts) => {
        sawAny = true;
        for (const m of muts) noteBackground(m);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      const start = performance.now();
      const check = () => {
        const elapsed = performance.now() - start;
        if ((!sawAny && elapsed >= opts.earlyExitMs) || elapsed >= opts.baselineMs) {
          obs.disconnect();
          resolve({ sampledMs: Math.round(elapsed), footprintSize: bgText.size + bgAttr.size });
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
  }

  // --- Coalescing ----------------------------------------------------------
  interface NetDelta {
    addedRoots: Element[];
    removed: Element[];
    attrChanged: Array<{ el: Element; attrs: string[] }>;
    textChanged: Element[];
    droppedBackground: number;
  }

  function ancestorInSet(el: Element, set: Set<Element>): boolean {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function coalesce(recs: MutationRecord[]): NetDelta {
    const addedCand = new Set<Element>();
    const removedCand = new Set<Element>();
    // First childList polarity per element, in record order: 'add' if the first
    // time we saw it was an insertion (=> born this window), 'remove' if the first
    // touch was a removal (=> it pre-existed). This distinguishes a droppable
    // add-then-remove transient from a real net-removal of a pre-existing element
    // that was also moved (moved => removedNodes fires first, then addedNodes).
    const firstTouch = new Map<Element, 'add' | 'remove'>();
    // Earliest observed oldValue per (element, attribute), for a net-compare
    // against the current value (drops churn that reverts to the original).
    const attrOld = new Map<Element, Map<string, string | null>>();
    const textCand = new Set<Element>();

    for (const rec of recs) {
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          if (isElement(n)) {
            addedCand.add(n);
            if (!firstTouch.has(n)) firstTouch.set(n, 'add');
          } else if (isText(n) && n.parentElement) textCand.add(n.parentElement);
        });
        rec.removedNodes.forEach((n) => {
          if (isElement(n)) {
            removedCand.add(n);
            if (!firstTouch.has(n)) firstTouch.set(n, 'remove');
          } else if (isText(n) && rec.target && isElement(rec.target)) textCand.add(rec.target);
        });
      } else if (rec.type === 'attributes' && isElement(rec.target)) {
        const el = rec.target;
        const name = rec.attributeName ?? '';
        const perEl = attrOld.get(el) ?? attrOld.set(el, new Map()).get(el)!;
        if (!perEl.has(name)) perEl.set(name, rec.oldValue);
      } else if (rec.type === 'characterData') {
        const parent = (rec.target as CharacterData).parentElement;
        if (parent) textCand.add(parent);
      }
    }

    // Net added = inserted AND still connected, reduced to subtree roots only.
    const addedConnected = [...addedCand].filter((el) => el.isConnected);
    const addedSet = new Set(addedConnected);
    const addedRoots = addedConnected.filter((el) => !ancestorInSet(el, addedSet));
    const rootSet = new Set(addedRoots);
    const inAddedSubtree = (el: Element) => rootSet.has(el) || ancestorInSet(el, rootSet);

    // Net removed = disconnected now AND first touched as a removal (pre-existing).
    // A node first touched as an add that ends disconnected is an add-then-remove
    // transient and nets to nothing. (A removed subtree reports only its root in
    // removedNodes, so no ancestor reduction is needed here.)
    const removed = [...removedCand].filter(
      (el) => !el.isConnected && firstTouch.get(el) === 'remove',
    );

    // attr changes on surviving elements NOT inside a freshly added subtree, with a
    // net-compare: keep an attribute only if its current value differs from the
    // earliest observed oldValue (drops churn-to-original; skips our own stamp).
    // Attributes already churning in the pre-arm baseline are dropped as background.
    let droppedBackground = 0;
    const attrChanged: Array<{ el: Element; attrs: string[] }> = [];
    for (const [el, perEl] of attrOld) {
      if (!el.isConnected || inAddedSubtree(el)) continue;
      const bg = bgAttr.get(el);
      const attrs: string[] = [];
      for (const [name, old] of perEl) {
        if (name === 'data-dw-ref') continue;
        if (el.getAttribute(name) === old) continue; // no net change
        if (bg && bg.has(name)) {
          droppedBackground++; // background attribute churn — not the action's effect
          continue;
        }
        attrs.push(name);
      }
      if (attrs.length) attrChanged.push({ el, attrs });
    }

    // text changes on surviving elements, excluding elements already churning text in
    // the pre-arm baseline (background).
    const textChanged: Element[] = [];
    for (const el of textCand) {
      if (!el.isConnected || inAddedSubtree(el)) continue;
      if (bgText.has(el)) {
        droppedBackground++;
        continue;
      }
      textChanged.push(el);
    }

    return { addedRoots, removed, attrChanged, textChanged, droppedBackground };
  }

  // --- Node classification & labeling -------------------------------------
  const INTERACTIVE_SELECTOR =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], ' +
    '[role="textbox"], [role="checkbox"], [role="menuitem"], [contenteditable=""], ' +
    '[contenteditable="true"], [tabindex]';

  const IMPLICIT_ROLE: Record<string, string> = {
    button: 'button',
    a: 'link',
    select: 'combobox',
    textarea: 'textbox',
    dialog: 'dialog',
    nav: 'navigation',
  };

  function isInteractive(el: Element): boolean {
    return el.matches(INTERACTIVE_SELECTOR);
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit') return 'button';
      return 'textbox';
    }
    return IMPLICIT_ROLE[tag] ?? null;
  }

  function nameOf(el: Element): string | null {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const placeholder = el.getAttribute('placeholder');
    if (isInteractive(el)) {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 40);
      if (placeholder) return placeholder.trim();
    }
    return null;
  }

  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const cls = el.classList[0] ? '.' + el.classList[0] : '';
    const role = el.getAttribute('role');
    const rolePart = role ? `[role=${role}]` : '';
    return `${tag}${cls}${rolePart}`;
  }

  const round = (n: number) => Math.round(n);

  function readGeometry(el: Element): GeometryRead {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inViewport =
      r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const centerInViewport = cx >= 0 && cy >= 0 && cx < vw && cy < vh;

    let hitSelf = false;
    let coveredBy: string | null = null;
    let offscreen = false;

    if (!centerInViewport) {
      offscreen = true;
    } else {
      // A shadow-DOM element: document.elementFromPoint retargets to the host, so query
      // the element's own root to hit-test shadow content. (#19)
      const rootNode = el.getRootNode();
      const fromPoint = rootNode instanceof ShadowRoot ? rootNode : document;
      const top = fromPoint.elementFromPoint(cx, cy);
      if (!top) {
        offscreen = true; // null despite in-viewport center: treat as unreachable
      } else if (top === el || el.contains(top)) {
        // Topmost is the element itself or one of its descendants => reachable.
        hitSelf = true;
      } else {
        // A foreign element OR an ANCESTOR painted on top counts as covered —
        // this matches Playwright's "hit target must be self or a descendant".
        coveredBy = describe(top);
      }
    }

    return {
      rect: { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) },
      inViewport,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      hitSelf,
      coveredBy,
      offscreen,
    };
  }

  // --- Animation settling --------------------------------------------------
  // CSS transitions move geometry WITHOUT firing mutations, so after quiescence
  // the rect may still be animating. Wait for running animations on the changed
  // subtree to finish (raced against animMaxMs) before reading geometry.
  async function settleAnimations(roots: Element[], animMaxMs: number): Promise<number> {
    const anims = new Set<Animation>();
    for (const el of roots) {
      if (typeof el.getAnimations !== 'function') continue;
      for (const a of el.getAnimations({ subtree: true })) {
        if (a.playState === 'running' || a.playState === 'paused' || (a as any).pending)
          anims.add(a);
      }
    }
    if (anims.size === 0) return 0;
    const finished = [...anims].map((a) => a.finished.catch(() => undefined));
    const timeout = new Promise<void>((res) => setTimeout(res, animMaxMs));
    await Promise.race([Promise.all(finished), timeout]);
    return anims.size;
  }

  // --- Collect -------------------------------------------------------------
  async function collect(opts: SettleOptions): Promise<CollectResult> {
    stop();
    const rawRecords = records.length;
    const net = coalesce(records);

    // Elements whose geometry we care about (connected ones), for animation wait.
    const geomRoots = [...net.addedRoots, ...net.attrChanged.map((a) => a.el), ...net.textChanged];
    const animationsAwaited = await settleAnimations(geomRoots, opts.animMaxMs);

    // Build the reported node set: added roots + their interactive descendants,
    // plus removed / attrChanged / textChanged elements.
    const reported: Array<{ el: Element; kind: ChangeKind; attrs?: string[] }> = [];
    const seen = new Set<Element>();
    const push = (el: Element, kind: ChangeKind, attrs?: string[]) => {
      if (seen.has(el)) return;
      seen.add(el);
      reported.push({ el, kind, attrs });
    };

    for (const root of net.addedRoots) {
      push(root, 'added');
      root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((d) => push(d, 'added'));
    }
    for (const el of net.removed) push(el, 'removed');
    for (const { el, attrs } of net.attrChanged) push(el, 'attrChanged', attrs);
    for (const el of net.textChanged) push(el, 'textChanged');

    // Stamp refs (only on connected nodes — the observer is already stopped, so
    // this does not pollute the delta). Removed nodes get a ref but no stamp.
    const elToRef = new Map<Element, string>();
    reported.forEach((item, i) => {
      const ref = 'e' + (i + 1);
      elToRef.set(item.el, ref);
      if (item.el.isConnected) item.el.setAttribute('data-dw-ref', ref);
    });

    const nearestReportedAncestor = (el: Element): string | null => {
      let p = el.parentElement;
      while (p) {
        const ref = elToRef.get(p);
        if (ref) return ref;
        p = p.parentElement;
      }
      return null;
    };

    const nodes: RawNode[] = reported.map((item) => {
      const { el, kind, attrs } = item;
      const ref = elToRef.get(el)!;
      const node: RawNode = {
        ref,
        kind,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: nameOf(el),
        interactive: isInteractive(el),
        parentRef: nearestReportedAncestor(el),
        geometry: el.isConnected ? readGeometry(el) : null,
      };
      if (attrs && attrs.length) node.changedAttrs = attrs;
      return node;
    });

    // Consume the baseline footprint so a subsequent action without a fresh
    // sampleBaseline starts clean (no stale background exclusions).
    bgText = new Set();
    bgAttr = new Map();

    return { nodes, rawRecords, animationsAwaited, droppedBackground: net.droppedBackground };
  }

  window.__deltawright = { arm, sampleBaseline, waitForSettle, collect, reset };
})();

// Ensure this file is treated as a module (for `import type` above) without
// emitting any runtime export.
export {};
