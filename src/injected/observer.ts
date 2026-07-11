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
  AttrStateChange,
  GeometryRead,
  ChangeKind,
  SettleOptions,
  SettleResult,
  CollectResult,
  BaselineOptions,
  DeltawrightApi,
} from '../host/types';

declare global {
  interface Window {
    __deltawright?: DeltawrightApi;
  }
}

(function install() {
  if (window.__deltawright) return; // idempotent

  let observer: MutationObserver | null = null;
  // A short-lived, separate observer for the gap-E late-wave watch (#49). It only sets a
  // flag; it never appends to `records`, so a late wave is DETECTED, never CAPTURED.
  let lateObserver: MutationObserver | null = null;
  let lateSeen = false;
  let lateWatchDeadline = 0;
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
  // Recurring element-INSERTION signatures seen in the baseline (toasts / live-feed
  // rows / virtualized lists), so background-added subtrees are excluded too (#30).
  let bgInsert = new Set<string>();
  let bgInsertCount = new Map<string, number>();
  // In-window insertion-signature tally (#7 detection). Counts RAW insertion events during the
  // settle window (add-then-remove churn still counts), so a container that only STARTS churning
  // AFTER the action — invisible to the pre-arm baseline `bgInsert` — is still detectable. Read at
  // collect to report the peak non-baseline recurrence as a SUSPECTED signal. It does NOT change
  // settle timing or attribution (the delta still keeps every node; per #30, in-window signal must
  // not DROP — flag, don't drop).
  let winInsertCount = new Map<string, number>();

  // Trusted-event anchor (#30, KEEP-ONLY): the action's origin element + click point
  // inside the page, learned from the FIRST isTrusted event during the window. It can
  // only RESCUE the action's own instance of a would-be background drop, never cause a
  // drop and never promote a signature to background. Gated behind the opt-in
  // inWindowRecurrence flag — when off, no listeners are installed, anchorLatched stays
  // false, and the rescue branch in coalesce is unreachable (default path unchanged).
  const ANCHOR_RADIUS = 64; // px: point-to-rect radius for the geometry fallback
  const TRUSTED_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'input', 'click', 'change'];
  let anchorTarget: Element | null = null;
  let anchorPoint: { x: number; y: number } | null = null;
  let anchorLatched = false;

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
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            const el = n as Element;
            // A newly added element may host (or contain) open shadow roots to observe.
            observeShadowRoots(el);
            // Tally its insertion signature (raw event) for the in-window recurrence signal (#7). The
            // node is connected here, so insertSig's parentElement read is valid.
            const sig = insertSig(el);
            winInsertCount.set(sig, (winInsertCount.get(sig) ?? 0) + 1);
          }
        });
      }
    }
  }

  // --- Trusted-event anchor (#30) -----------------------------------------
  // Latch the FIRST trusted event of the window as the action's origin. Playwright's
  // real actions dispatch isTrusted events; a script-dispatched .click() does not, so
  // an untrusted action leaves the anchor null and behavior falls back to shipped.
  function onTrusted(e: Event): void {
    if (!e.isTrusted || anchorLatched) return; // latch once, on the first trusted event
    anchorLatched = true;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    anchorTarget =
      path[0] instanceof Element ? path[0] : e.target instanceof Element ? e.target : null;
    const me = e as MouseEvent;
    if (typeof me.clientX === 'number' && (me.clientX || me.clientY)) {
      anchorPoint = { x: me.clientX, y: me.clientY };
    } else if (anchorTarget) {
      // keyboard/input events carry no coordinates — use the target's center.
      const r = anchorTarget.getBoundingClientRect();
      anchorPoint = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }

  function installAnchorCapture(): void {
    for (const t of TRUSTED_EVENTS)
      document.addEventListener(t, onTrusted, { capture: true, passive: true });
  }
  function removeAnchorCapture(): void {
    for (const t of TRUSTED_EVENTS) document.removeEventListener(t, onTrusted, { capture: true });
  }

  // The KEEP-override predicate: is this added root the action's OWN output? True when
  // it shares DOM lineage with the trusted target (primary) or sits within
  // ANCHOR_RADIUS of the click point (geometry fallback, for an instance visually at the
  // click but not in the target's subtree). The geometry fallback can over-KEEP a
  // genuine background insert that merely renders near the click — a deliberate
  // bias-to-KEEP (a leaked node is tolerable; dropping the action's output is not).
  // Note `.contains` does not cross shadow boundaries, so a shadow-retargeted anchor
  // relies on the geometry fallback for lineage-across-boundary cases.
  function isActionLocal(r: Element): boolean {
    if (
      anchorTarget &&
      (r === anchorTarget || r.contains(anchorTarget) || anchorTarget.contains(r))
    )
      return true;
    if (anchorPoint) {
      try {
        const b = r.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) {
          const dx = Math.max(b.left - anchorPoint.x, 0, anchorPoint.x - b.right);
          const dy = Math.max(b.top - anchorPoint.y, 0, anchorPoint.y - b.bottom);
          if (dx * dx + dy * dy <= ANCHOR_RADIUS * ANCHOR_RADIUS) return true;
        }
      } catch {
        // a detached/throwing rect — fall through to not-local (never a NEW drop).
      }
    }
    return false;
  }

  function arm(inWindowRecurrence?: boolean): void {
    reset();
    // Clear stale refs from a prior action so ids (e1, e2, ...) can't collide
    // across sequential actions on one page load. Done before observe(), so
    // these removals are not themselves recorded.
    document.querySelectorAll('[data-dw-ref]').forEach((el) => el.removeAttribute('data-dw-ref'));
    armStart = performance.now();
    if (inWindowRecurrence === true) installAnchorCapture(); // #30 anchor (opt-in)
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, OBSERVE_OPTIONS);
    observeShadowRoots(document); // open shadow roots (web components)
  }

  function reset(): void {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (lateObserver) {
      lateObserver.disconnect();
      lateObserver = null;
    }
    lateSeen = false;
    lateWatchDeadline = 0;
    removeAnchorCapture(); // #30: drop any capture listeners from a prior window
    records = [];
    firstMutationAt = null;
    lastMutationAt = null;
    lastStructuralAt = null;
    sawStructural = false;
    anchorTarget = null;
    anchorPoint = null;
    anchorLatched = false;
    observedRoots = new Set();
    winInsertCount = new Map(); // fresh in-window recurrence tally per action
  }

  function stop(): void {
    if (observer) {
      const pending = observer.takeRecords();
      if (pending.length) onMutations(pending);
      observer.disconnect();
      observer = null;
    }
    // The window is over; stop listening for trusted events (the latched anchor stays
    // available for coalesce, and is cleared by the next arm()'s reset()).
    removeAnchorCapture();
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
    const lateWatchMs = opts.lateWatchMs ?? 0;
    return new Promise<SettleResult>((resolve) => {
      const check = () => {
        const now = performance.now();
        const structuralQuiet =
          sawStructural && lastStructuralAt !== null && now - lastStructuralAt >= opts.quietMs;
        const anyQuiet = lastMutationAt !== null && now - lastMutationAt >= opts.quietMs;
        const capped = now >= deadline;
        if (structuralQuiet || anyQuiet || capped) {
          // Gap-E (#49): begin watching for a late structural wave FROM the settle point with a
          // SEPARATE observer. It is read later via lateResult(); it never touches `records`.
          // Crucially, waitForSettle still resolves NOW (not after the window), so the host's
          // collect() runs at the settle point and the delta is frozen exactly as the default
          // path — enabling this cannot alter, cover, or erase captured content. (Capturing
          // the late wave itself was declined-as-unsafe in #30.)
          if (lateWatchMs > 0) startLateWatch(now + lateWatchMs);
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

  // Watch for a late structural wave until `deadline`, setting `lateSeen`. The callback
  // ignores mutations after the deadline, so detection is bounded to the window regardless of
  // when lateResult() reads it. Light DOM only: a late wave inside an existing open shadow
  // root is not detected — an accepted false-negative for a SUSPECTED hint (not capture).
  function startLateWatch(deadline: number): void {
    lateSeen = false;
    lateWatchDeadline = deadline;
    lateObserver = new MutationObserver((muts) => {
      if (performance.now() > lateWatchDeadline) return;
      for (const m of muts) {
        if (
          m.type === 'childList' &&
          (listHasElement(m.addedNodes) || listHasElement(m.removedNodes))
        ) {
          lateSeen = true;
        }
      }
    });
    lateObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Wait out the remainder of the late-watch window (if any), then report + tear down. Called
  // by the host AFTER collect + reconcile, so the watch overlaps that work — usually zero
  // added latency. No-ops safely when no late-watch was started (deadline 0).
  function lateResult(): Promise<{ lateStructural: boolean }> {
    return new Promise((resolve) => {
      const done = () => {
        if (lateObserver) {
          lateObserver.disconnect();
          lateObserver = null;
        }
        resolve({ lateStructural: lateSeen });
      };
      const poll = () => {
        const remaining = lateWatchDeadline - performance.now();
        if (remaining <= 0) {
          done();
          return;
        }
        setTimeout(poll, Math.min(remaining, 25));
      };
      poll();
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
    } else if (m.type === 'childList') {
      if (isElement(m.target)) {
        // textContent updates land as text-node childList churn on the parent element.
        m.addedNodes.forEach((n) => {
          if (isText(n) && n.parentElement) bgText.add(n.parentElement);
        });
        m.removedNodes.forEach((n) => {
          if (isText(n)) bgText.add(m.target as Element);
        });
      }
      // Tally element-insertion signatures — one added repeatedly in the baseline is a
      // background insertion pattern (toast, live-feed row, virtualized list item).
      m.addedNodes.forEach((n) => {
        if (isElement(n)) {
          const s = insertSig(n);
          bgInsertCount.set(s, (bgInsertCount.get(s) ?? 0) + 1);
        }
      });
    }
  }

  // Signature of an inserted element: parentTag > tag . firstClass|role. Specific
  // enough that a unique modal never collides with a recurring background toast.
  function insertSig(el: Element): string {
    const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
    const cls = el.classList[0] ?? el.getAttribute('role') ?? '';
    return `${parent}>${el.tagName.toLowerCase()}.${cls}`;
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
    bgInsert = new Set();
    bgInsertCount = new Map();
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
          // A signature inserted >= 2x during the baseline is a background pattern.
          for (const [sig, count] of bgInsertCount) if (count >= 2) bgInsert.add(sig);
          resolve({
            sampledMs: Math.round(elapsed),
            footprintSize: bgText.size + bgAttr.size + bgInsert.size,
          });
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
    attrChanged: Array<{ el: Element; attrs: string[]; stateChanges: AttrStateChange[] }>;
    textChanged: Element[];
    droppedBackground: number;
    /**
     * Freshly-added subtree roots that were DETACHED again before collect (#71 fix #3): the
     * action's own output was inserted and then torn down within the settle window (a React
     * re-render / list virtualization swap). Such a node nets out of the reported delta entirely
     * (added-then-removed => neither net-added, still connected, nor net-removed, pre-existing),
     * so its transience is otherwise invisible. Counted here to ground `detached-re-render`.
     */
    detachedInWindow: number;
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
    // Insertion signature captured AT ADD TIME (#71 fix #3). An added element that is later
    // detached has a null parentElement by collect, so insertSig() (which reads parentElement)
    // would degrade to `>tag.cls` and never match a baseline `parentTag>tag.cls`. The record's
    // target IS the parent the node was inserted into (valid even after detach), so we snapshot
    // the signature here to let the detach counter honor the same bgInsert background exclusion
    // the connected added-root path applies.
    const addSig = new Map<Element, string>();
    // Earliest observed oldValue per (element, attribute), for a net-compare
    // against the current value (drops churn that reverts to the original).
    const attrOld = new Map<Element, Map<string, string | null>>();
    const textCand = new Set<Element>();

    for (const rec of recs) {
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          if (isElement(n)) {
            addedCand.add(n);
            if (!firstTouch.has(n)) {
              firstTouch.set(n, 'add');
              const parentTag = isElement(rec.target) ? rec.target.tagName.toLowerCase() : '';
              const cls = n.classList[0] ?? n.getAttribute('role') ?? '';
              addSig.set(n, `${parentTag}>${n.tagName.toLowerCase()}.${cls}`);
            }
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

    // Net added = inserted AND still connected, reduced to subtree roots only. An added
    // root whose insertion signature recurred in the baseline is background (a toast /
    // virtualized row) and is dropped — the modal's unique signature is never in the set.
    let droppedBackground = 0;
    const addedConnected = [...addedCand].filter((el) => el.isConnected);
    const addedSet = new Set(addedConnected);
    const addedRoots: Element[] = [];
    for (const el of addedConnected) {
      if (ancestorInSet(el, addedSet)) continue; // a descendant of another added root
      if (bgInsert.size > 0 && bgInsert.has(insertSig(el))) {
        // The pre-arm baseline says this signature is background (a toast / feed row).
        // But if the action's OWN trusted target produced THIS instance (in the DOM
        // lineage of the click, or at the click point), KEEP it — the anchor turns the
        // all-or-nothing per-signature drop into a per-root one, sparing the action's
        // own output (#30). anchorLatched is only ever true when the opt-in
        // inWindowRecurrence flag armed the capture AND a trusted event fired, so the
        // default path is byte-unchanged; the anchor can only rescue an added ROOT,
        // never cause a drop. (Rescuing a root also re-scopes its descendants into the
        // added subtree — as every added root does — which correctly subsumes a
        // descendant's standalone attr/text node instead of orphaning it under a
        // dropped parent. That is more correct, not a regression; see rescue.spec.ts.)
        if (anchorLatched && isActionLocal(el)) {
          addedRoots.push(el);
          continue;
        }
        droppedBackground++;
        continue;
      }
      addedRoots.push(el);
    }
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
    const attrChanged: Array<{ el: Element; attrs: string[]; stateChanges: AttrStateChange[] }> =
      [];
    for (const [el, perEl] of attrOld) {
      if (!el.isConnected || inAddedSubtree(el)) continue;
      const bg = bgAttr.get(el);
      const attrs: string[] = [];
      const stateChanges: AttrStateChange[] = [];
      for (const [name, old] of perEl) {
        if (name === 'data-dw-ref') continue;
        const current = el.getAttribute(name);
        if (current === old) continue; // no net change
        if (bg && bg.has(name)) {
          droppedBackground++; // background attribute churn — not the action's effect
          continue;
        }
        attrs.push(name);
        // Capture the VALUE transition for an allowlisted state attribute (#8) — the old/new are
        // already in hand here, so this is nearly free.
        if (ARIA_STATE_ATTRS.has(name)) stateChanges.push({ attr: name, old, new: current });
      }
      if (attrs.length) attrChanged.push({ el, attrs, stateChanges });
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

    // Detached-re-render signal (#71 fix #3): elements first touched as an ADD that are now
    // disconnected were inserted and then torn down within the window. They net out of the
    // reported delta above (excluded from addedRoots by `isConnected`, and from `removed` by
    // firstTouch !== 'remove'), so counting them here is the ONLY place their transience
    // surfaces. A recurring BACKGROUND insertion learned in the baseline (a toast / spinner /
    // virtualized row that appears-then-vanishes) is excluded HERE too — using the add-time
    // signature, since the detached node's parentElement is gone — so the detach counter honors
    // the same background quarantine as addedRoots (line ~490) and never re-asserts churn the
    // delta already dropped. Reduced to subtree roots (parentElement still links a detached tree)
    // so a detached subtree counts once. Zero added latency — coalesce already walks addedCand.
    const detachedAdded = [...addedCand].filter(
      (el) =>
        firstTouch.get(el) === 'add' &&
        !el.isConnected &&
        !(bgInsert.size > 0 && bgInsert.has(addSig.get(el) ?? '')),
    );
    const detachedSet = new Set(detachedAdded);
    const detachedInWindow = detachedAdded.filter((el) => !ancestorInSet(el, detachedSet)).length;

    return { addedRoots, removed, attrChanged, textChanged, droppedBackground, detachedInWindow };
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

  // Accessibility STATE attributes (#8) whose value TRANSITION (old→new) is worth surfacing — kept
  // aligned with checksum.ts's STATE_ATTR_ALLOWLIST (minus `class`, whose value is not a clean state).
  const ARIA_STATE_ATTRS = new Set<string>([
    'aria-expanded',
    'aria-selected',
    'aria-pressed',
    'aria-checked',
    'aria-current',
    'aria-disabled',
    'aria-invalid',
    'aria-hidden',
    'aria-busy',
    'aria-required',
    'disabled',
    'checked',
    'open',
    'hidden',
    'readonly',
    'selected',
    'contenteditable',
  ]);

  // Live-region politeness for a node (#8): if the node is inside a region that ANNOUNCES changes to
  // assistive tech, return its politeness. `aria-live="off"` (and an empty value = default off) does
  // NOT announce, so it is treated as no live region — the field means "was announced", never claim it
  // for a silenced region.
  function liveRegionOf(el: Element): string | null {
    const region = el.closest('[aria-live],[role="status"],[role="alert"],[role="log"]');
    if (!region) return null;
    const live = region.getAttribute('aria-live');
    if (live === 'off' || live === '') return null; // explicitly silenced → not announced
    if (live) return live; // polite | assertive
    return region.getAttribute('role') === 'alert' ? 'assertive' : 'polite'; // status/log → polite
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
    const reported: Array<{
      el: Element;
      kind: ChangeKind;
      attrs?: string[];
      stateChanges?: AttrStateChange[];
    }> = [];
    const seen = new Set<Element>();
    const push = (
      el: Element,
      kind: ChangeKind,
      attrs?: string[],
      stateChanges?: AttrStateChange[],
    ) => {
      if (seen.has(el)) return;
      seen.add(el);
      reported.push({ el, kind, attrs, stateChanges });
    };

    for (const root of net.addedRoots) {
      push(root, 'added');
      root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((d) => push(d, 'added'));
    }
    for (const el of net.removed) push(el, 'removed');
    for (const { el, attrs, stateChanges } of net.attrChanged)
      push(el, 'attrChanged', attrs, stateChanges);
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
      const { el, kind, attrs, stateChanges } = item;
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
      // #8: additive a11y-state annotations — never relabel role/name (DW-03), no verdict impact.
      if (stateChanges && stateChanges.length) node.stateChanges = stateChanges;
      if (el.isConnected) {
        const live = liveRegionOf(el);
        if (live) node.ariaLive = live;
      }
      return node;
    });

    // Peak in-window insertion recurrence for a signature NOT already known to be background from the
    // pre-arm baseline (#7 detection) — i.e. churn that STARTED after the action. Computed before the
    // bgInsert reset below. Reported raw; the host applies the SUSPECTED threshold.
    let recurringInsert = 0;
    for (const [sig, c] of winInsertCount)
      if (c > recurringInsert && !bgInsert.has(sig)) recurringInsert = c;

    // Consume the baseline footprint so a subsequent action without a fresh
    // sampleBaseline starts clean (no stale background exclusions).
    bgText = new Set();
    bgAttr = new Map();
    bgInsert = new Set();
    bgInsertCount = new Map();
    winInsertCount = new Map();

    return {
      nodes,
      rawRecords,
      animationsAwaited,
      droppedBackground: net.droppedBackground,
      detachedInWindow: net.detachedInWindow,
      recurringInsert,
    };
  }

  // Gap-F (#50, opt-in): a JS-timer reposition AFTER settle leaves a STALE annotated rect —
  // getAnimations() is empty for a plain style write, so settleAnimations never waited it out.
  // Called by the host AFTER collect + the authoritative Playwright probe, so the VERDICT is
  // decided at the settle point regardless of this delay (this cannot change it). Waits, then
  // re-reads the current geometry of every stamped node; the host compares to the settle-time
  // rect, adopts the later read on a move, and re-derives the geometry annotation. Light DOM
  // only (querySelectorAll does not cross shadow boundaries).
  async function recheckRects(
    rectRecheckMs: number,
  ): Promise<Array<{ ref: string; geometry: GeometryRead }>> {
    await new Promise<void>((r) => setTimeout(r, rectRecheckMs));
    const out: Array<{ ref: string; geometry: GeometryRead }> = [];
    document.querySelectorAll('[data-dw-ref]').forEach((el) => {
      const ref = el.getAttribute('data-dw-ref');
      if (ref) out.push({ ref, geometry: readGeometry(el) });
    });
    return out;
  }

  window.__deltawright = {
    arm,
    sampleBaseline,
    waitForSettle,
    collect,
    reset,
    lateResult,
    recheckRects,
    // Preflight (#53): stateless on-demand geometry read for the actionability matcher's [geom:]
    // annotation. Reuses the SAME readGeometry as collect (one source of truth for geometry); it
    // never touches observer/arm/collect state, so it is safe to call standalone.
    probeGeometry: readGeometry,
  };
})();

// Ensure this file is treated as a module (for `import type` above) without
// emitting any runtime export.
export {};
