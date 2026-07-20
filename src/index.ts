// Deltawright — a delta-and-actionability layer for Playwright agents.
// It tells the agent what changed after an action and whether it can act on it.

export { actAndObserve, DEFAULT_SETTLE, DEFAULT_BASELINE } from './host/actAndObserve';
export type { Action, ActAndObserveOptions } from './host/actAndObserve';
export { serialize, render, tokenCount } from './host/serialize';
export type { SerializeOptions } from './host/serialize';
export { pageMap, renderPageMap } from './host/page-map';
export type { PageMap, PageMapNode, PageMapOptions, RenderPageMapOptions } from './host/page-map';
export { diagnose } from './host/diagnose';
export { suggest } from './host/suggest';
export type {
  SuggestResult,
  SelectorSuggestion,
  AssertionSuggestion,
  SelectorTier,
} from './host/suggest';
export { annotateActionability, geometryVerdict } from './host/actionability';
export { ensureInjected, injectedSource } from './host/inject';
export { diffChangedRegion } from './host/screenshot-diff';
export type { ChangedRegion, DiffOptions } from './host/screenshot-diff';
export { checksum, normalizeDelta } from './host/checksum';
export {
  ROOT_CAUSE_TAXONOMY,
  ROOT_CAUSE_CODES,
  PRIMITIVE_SIGNALS,
  rootCauseSpec,
  toRootCauseCode,
} from './host/taxonomy';
export type {
  RootCauseCode,
  RootCauseCategory,
  PrimitiveSignal,
  RootCauseSpec,
} from './host/taxonomy';
export { assessConfidence, atLeastAsConfident, CONFIDENCE_ORDER } from './host/confidence';
export type { Confidence, EvidenceSource, Evidence } from './host/confidence';
export { classifyInput, LOSS_SHAPES } from './host/input-integrity';
export { buildLiveRouting } from './host/live-routing';
export type {
  LiveRoutingReport,
  LiveRoutingSignal,
  LiveSignalKind,
  CollectedLiveSignals,
  RawLiveSignal,
} from './host/live-routing';
export type {
  Delta,
  DeltaNode,
  DeltaStats,
  RawDelta,
  RawNode,
  GeometryRead,
  Rect,
  Verdict,
  Actionability,
  Diagnosis,
  DiagnosedDelta,
  ChangeKind,
  InputShape,
  InputIntegrityStat,
  SettleOptions,
  SettleResult,
  CollectResult,
  BaselineOptions,
  ScanOptions,
  RawPageMap,
  RawPageMapNode,
  PageMapLayer,
} from './host/types';
