// A by-name consumer of the published package. It is typechecked against the built
// dist/ types the way an installed consumer resolves them (package self-reference via
// the `exports` map, nodenext resolution) — see test/fixtures/packaging/tsconfig.json.
// It never runs; it exists purely to prove the shipped types are importable and usable.
import {
  actAndObserve,
  serialize,
  render,
  checksum,
  type Delta,
  type DeltaNode,
  type ActAndObserveOptions,
} from 'deltawright';

export const primitive = actAndObserve;
export const opts: ActAndObserveOptions = { label: 'demo' };

export function summarize(delta: Delta): { line: string; tokens: number; sum: string } {
  const first: DeltaNode | undefined = delta.nodes[0];
  const text = serialize(delta);
  const out = render(delta);
  return {
    line: `${first?.ref ?? '-'}:${text.length}`,
    tokens: out.tokens,
    sum: checksum(delta),
  };
}
