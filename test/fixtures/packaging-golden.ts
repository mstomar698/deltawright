// A representative, fully-formed Delta used to lock the default serializer output
// (test/packaging.spec.ts). It exercises the interesting serializer paths: an added
// non-interactive container (topmost), nested ACTIONABLE / NOT-actionable buttons, a
// covered element, an attrChanged input, and a geometry<->Playwright disagreement
// ([geom:]). GOLDEN_TEXT below is the byte-exact serialize() output; the packaging
// test asserts both the source and the built package reproduce it identically.
import type { Delta, GeometryRead } from '../../src/host/types';

function geom(over: Partial<GeometryRead> & Pick<GeometryRead, 'rect'>): GeometryRead {
  return {
    inViewport: true,
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto',
    hitSelf: true,
    coveredBy: null,
    offscreen: false,
    ...over,
  };
}

export const GOLDEN_DELTA: Delta = {
  action: 'click button "Save"',
  stats: {
    rawRecords: 12,
    settleMs: 140,
    hitMaxWait: false,
    animationsAwaited: 0,
    droppedBackground: 0,
  },
  nodes: [
    {
      ref: 'e1',
      kind: 'added',
      tag: 'div',
      role: 'dialog',
      name: 'Confirm',
      interactive: false,
      parentRef: null,
      geometry: geom({ rect: { x: 10, y: 20, width: 300, height: 200 }, hitSelf: true }),
      actionability: {
        verdict: 'n/a',
        reason: null,
        geometryVerdict: 'n/a',
        playwright: null,
        agreed: true,
      },
    },
    {
      ref: 'e2',
      kind: 'added',
      tag: 'button',
      role: 'button',
      name: 'OK',
      interactive: true,
      parentRef: 'e1',
      geometry: geom({ rect: { x: 40, y: 150, width: 80, height: 32 }, display: 'inline-block' }),
      actionability: {
        verdict: 'ACTIONABLE',
        reason: null,
        geometryVerdict: 'ACTIONABLE',
        playwright: { actionable: true },
        agreed: true,
      },
    },
    {
      ref: 'e3',
      kind: 'added',
      tag: 'button',
      role: 'button',
      name: 'Cancel',
      interactive: true,
      parentRef: 'e1',
      geometry: geom({
        rect: { x: 140, y: 150, width: 80, height: 32 },
        display: 'inline-block',
        hitSelf: false,
        coveredBy: 'div.overlay',
      }),
      actionability: {
        verdict: 'NOT-actionable',
        reason: 'covered-by div.overlay',
        geometryVerdict: 'NOT-actionable',
        playwright: { actionable: false, error: 'element intercepts pointer events' },
        agreed: true,
      },
    },
    {
      ref: 'e4',
      kind: 'attrChanged',
      tag: 'input',
      role: 'textbox',
      name: 'email',
      interactive: true,
      parentRef: null,
      changedAttrs: ['aria-invalid', 'class'],
      geometry: geom({ rect: { x: 10, y: 250, width: 200, height: 24 } }),
      actionability: {
        verdict: 'ACTIONABLE',
        reason: null,
        geometryVerdict: 'NOT-actionable',
        playwright: { actionable: true },
        agreed: false,
      },
    },
  ],
};

// Byte-exact serialize(GOLDEN_DELTA). Regenerate deliberately (never blindly) if the
// serializer format changes on purpose — a diff here is the whole point of the test.
export const GOLDEN_TEXT = [
  'after click button "Save":',
  '  + dialog "Confirm" [e1] @ (10,20 300x200) topmost',
  '    + button "OK" [e2] @ (40,150 80x32) ACTIONABLE',
  '    + button "Cancel" [e3] @ (140,150 80x32) NOT-actionable (covered-by div.overlay)',
  '  ~ textbox "email" [e4] @ (10,250 200x24) changed:aria-invalid,class ACTIONABLE [geom:NOT-actionable]',
].join('\n');
