// Deltawright injected page script. Bundled by esbuild into a self-contained IIFE
// and installed as window.__deltawright. Runs entirely in the page.
//
// Responsibilities (the "arm -> settle -> collect" side that must live in the page):
//   - arm():          start ONE MutationObserver, buffering raw records.
//   - waitForSettle(): the v0.1 settle heuristic (quiescence, tunable). SEE NOTE.
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
} from '../host/types';

interface DeltawrightApi {
  arm(): void;
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
  let armStart = 0;

  const isElement = (n: Node): n is Element => n.nodeType === 1;
  const isText = (n: Node): n is Text => n.nodeType === 3;

  function onMutations(muts: MutationRecord[]): void {
    const now = performance.now();
    if (firstMutationAt === null) firstMutationAt = now;
    lastMutationAt = now;
    for (const m of muts) records.push(m);
  }

  function arm(): void {
    reset();
    // Clear stale refs from a prior action so ids (e1, e2, ...) can't collide
    // across sequential actions on one page load. Done before observe(), so
    // these removals are not themselves recorded.
    document.querySelectorAll('[data-dw-ref]').forEach((el) => el.removeAttribute('data-dw-ref'));
    armStart = performance.now();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
  }

  function reset(): void {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    records = [];
    firstMutationAt = null;
    lastMutationAt = null;
  }

  function stop(): void {
    if (observer) {
      const pending = observer.takeRecords();
      if (pending.length) onMutations(pending);
      observer.disconnect();
      observer = null;
    }
  }

  // --- Settle detection (v0.1) --------------------------------------------
  // HEURISTIC, intentionally simple and tunable. This is the #1 thing to harden
  // in v0.5. Rule: resolve when we've seen at least one mutation AND the DOM has
  // been quiet for `quietMs`, OR when `maxWaitMs` elapses. `lastMutationAt`
  // starts null so "no mutations yet" NEVER counts as settled — that defeats the
  // delayed-insert trap (click -> silence -> insert-after-timeout).
  function waitForSettle(opts: SettleOptions): Promise<SettleResult> {
    const start = performance.now();
    const deadline = start + opts.maxWaitMs;
    return new Promise<SettleResult>((resolve) => {
      const check = () => {
        const now = performance.now();
        const quiet = lastMutationAt !== null && now - lastMutationAt >= opts.quietMs;
        const capped = now >= deadline;
        if (quiet || capped) {
          resolve({ settleMs: Math.round(now - armStart), hitMaxWait: capped && !quiet });
          return;
        }
        setTimeout(check, Math.min(opts.quietMs, 25));
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
    const attrChanged: Array<{ el: Element; attrs: string[] }> = [];
    for (const [el, perEl] of attrOld) {
      if (!el.isConnected || inAddedSubtree(el)) continue;
      const attrs: string[] = [];
      for (const [name, old] of perEl) {
        if (name === 'data-dw-ref') continue;
        if (el.getAttribute(name) !== old) attrs.push(name);
      }
      if (attrs.length) attrChanged.push({ el, attrs });
    }
    const textChanged = [...textCand].filter((el) => el.isConnected && !inAddedSubtree(el));

    return { addedRoots, removed, attrChanged, textChanged };
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
      const top = document.elementFromPoint(cx, cy);
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

    return { nodes, rawRecords, animationsAwaited };
  }

  window.__deltawright = { arm, waitForSettle, collect, reset };
})();

// Ensure this file is treated as a module (for `import type` above) without
// emitting any runtime export.
export {};
