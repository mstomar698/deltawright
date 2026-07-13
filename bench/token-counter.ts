// Pluggable token counter for the ADMISSIBLE benchmark (issue #25).
//
// The §10 go/no-go wants the ACTUAL deployment counter (Anthropic's tokenizer), but the
// benchmark must also stay reproducible offline. So the counter is selectable:
//
//   DEFAULT — the offline cl100k proxy (src `tokenCount`, gpt-tokenizer). Deterministic,
//     no network, no key. The frozen corpus makes its counts exact; ratios are the
//     tokenizer-robust signal. This is what runs in CI and with no key present.
//
//   OPT-IN — Anthropic `POST /v1/messages/count_tokens`, used when ANTHROPIC_API_KEY is
//     set. This is the real deployment counter. The call is FREE (no per-token cost) but
//     auth-gated + rate-limited, so we memoize per unique text: the corpus is
//     deterministic → each rendered delta/diff text is identical across the N reps → only
//     a handful of distinct calls total, well within limits.
//
// INTEGRITY: if the Anthropic call fails we throw — we do NOT silently fall back to the
// proxy, because a run that quietly mixes counters and labels every number "Claude" would
// corrupt the §10 statistic. Fix the key/model, or unset the env var to use the proxy.
//
// This module lives in bench/ ONLY — the published package stays offline + dep-free; no
// network tokenizer ships in the library.
import { tokenCount as cl100kProxy } from '../src/index';

export type CounterName = 'cl100k-proxy' | 'anthropic-count_tokens';

export interface TokenCounter {
  /** Machine name of the active counter (printed in the results header). */
  readonly name: CounterName;
  /** True only for the real Anthropic deployment counter (not the offline proxy). */
  readonly isDeploymentCounter: boolean;
  /** Human label for the results header. */
  readonly label: string;
  count(text: string): Promise<number>;
}

const proxyCounter: TokenCounter = {
  name: 'cl100k-proxy',
  isDeploymentCounter: false,
  label:
    'cl100k proxy (gpt-tokenizer, OFFLINE) — set ANTHROPIC_API_KEY for the real Claude counter',
  count: (text) => Promise.resolve(cl100kProxy(text)),
};

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';

function anthropicCounter(apiKey: string, model: string): TokenCounter {
  const memo = new Map<string, number>();
  return {
    name: 'anthropic-count_tokens',
    isDeploymentCounter: true,
    label: `Anthropic count_tokens (model=${model}) — the real deployment counter`,
    async count(text) {
      // count_tokens rejects empty message content; an empty delta/diff is 0 tokens.
      if (text === '') return 0;
      const hit = memo.get(text);
      if (hit !== undefined) return hit;

      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      });

      if (!res.ok) {
        // Body may name the problem (bad model, auth) — never contains the key. Trim it.
        const body = await res.text().catch(() => '');
        throw new Error(
          `Anthropic count_tokens failed (HTTP ${res.status}). Refusing to silently fall ` +
            `back to the cl100k proxy and mislabel §10 numbers as Claude. Fix the key/model ` +
            `(ANTHROPIC_TOKENIZER_MODEL, currently "${model}") or unset ANTHROPIC_API_KEY to ` +
            `use the offline proxy. Response: ${body.slice(0, 300)}`,
        );
      }

      const json = (await res.json()) as { input_tokens?: number };
      if (typeof json.input_tokens !== 'number') {
        throw new Error(
          `Anthropic count_tokens returned no input_tokens field: ${JSON.stringify(json).slice(0, 300)}`,
        );
      }
      memo.set(text, json.input_tokens);
      return json.input_tokens;
    },
  };
}

/**
 * Select the token counter from the environment. Returns the offline cl100k proxy unless
 * ANTHROPIC_API_KEY is set, in which case the real Anthropic count_tokens counter is used
 * (model overridable via ANTHROPIC_TOKENIZER_MODEL, default claude-sonnet-5).
 */
export function selectCounter(env: NodeJS.ProcessEnv = process.env): TokenCounter {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return proxyCounter;
  const model = env.ANTHROPIC_TOKENIZER_MODEL?.trim() || DEFAULT_MODEL;
  return anthropicCounter(key, model);
}
