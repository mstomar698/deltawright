// Pluggable token counter for the ADMISSIBLE benchmark (issue #25).
//
// The §10 go/no-go wants the ACTUAL deployment counter (Anthropic's tokenizer), but the
// benchmark must also stay reproducible offline. So the counter is selectable:
//
//   DEFAULT — the offline cl100k proxy (src `tokenCount`, gpt-tokenizer). Deterministic,
//     no network, no key. It counts RAW text; the frozen corpus makes its counts exact.
//     Taking ratios cancels most tokenizer-VOCABULARY differences, so a proxy CI number
//     tracks the deployment number's DIRECTION. But it is not the same metric as the
//     Anthropic counter (see the framing caveat below), so absolute numbers — and, to a
//     small degree, ratios — are not directly comparable across the two modes.
//
//   OPT-IN — Anthropic `POST /v1/messages/count_tokens`, used when ANTHROPIC_API_KEY is
//     set. This is the real deployment counter: it counts a user MESSAGE (the content PLUS
//     the fixed per-message framing Claude adds, ~7-10 tokens), which is exactly what a
//     delta costs in production. The proxy does not model that framing term — so within a
//     run every column shares it (direction is preserved) but a proxy row and an Anthropic
//     row are different quantities. The call is FREE (no per-token cost) but auth-gated +
//     rate-limited, so we memoize per unique text. The STRUCTURAL views (delta-lite /
//     struct-diff / re-snapshot) are byte-identical across the N reps and memoize to ONE
//     call each; the FULL delta text embeds geometry rects that vary sub-pixel per rep, so
//     it does NOT fully memoize — a run can make ~N calls for that column. count_tokens's
//     limits are generous, and transient 429/overload is retried with backoff below, so
//     this stays well-behaved.
//
// INTEGRITY: on a NON-retryable failure (bad key/model/request, or exhausted retries) we
// throw — we do NOT silently fall back to the proxy, because a run that quietly mixes
// counters and labels every number "Claude" would corrupt the §10 statistic. Fix the
// key/model, or unset the env var to use the proxy.
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
    'cl100k proxy (gpt-tokenizer, OFFLINE, raw-text) — set ANTHROPIC_API_KEY for the real Claude counter',
  count: (text) => Promise.resolve(cl100kProxy(text)),
};

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
// Transient statuses worth retrying (rate-limit + server/overload). 4xx caller errors
// (bad key/model/request) are NOT retried — retrying cannot fix them, so we fail loud.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function anthropicCounter(apiKey: string, model: string): TokenCounter {
  const memo = new Map<string, number>();

  async function request(text: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      });

      if (res.ok) {
        const json = (await res.json()) as { input_tokens?: number };
        if (typeof json.input_tokens !== 'number') {
          throw new Error(
            `Anthropic count_tokens returned no input_tokens field: ${JSON.stringify(json).slice(0, 300)}`,
          );
        }
        return json.input_tokens;
      }

      // Retry transient rate-limit/overload with backoff (respect Retry-After if present).
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30_000, 500 * 2 ** attempt); // 0.5s,1s,2s,4s,8s (capped)
        await sleep(waitMs);
        continue;
      }

      // Non-retryable, or retries exhausted → fail loud (never a silent proxy fallback).
      const body = await res.text().catch(() => '');
      const retried = attempt > 0 ? ` after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}` : '';
      throw new Error(
        `Anthropic count_tokens failed (HTTP ${res.status}${retried}). Refusing to silently ` +
          `fall back to the cl100k proxy and mislabel §10 numbers as Claude. Fix the key/model ` +
          `(ANTHROPIC_TOKENIZER_MODEL, currently "${model}") or unset ANTHROPIC_API_KEY to use ` +
          `the offline proxy. Response: ${body.slice(0, 300)}`,
      );
    }
  }

  return {
    name: 'anthropic-count_tokens',
    isDeploymentCounter: true,
    label: `Anthropic count_tokens (model=${model}, incl. per-message framing) — the real deployment counter`,
    async count(text) {
      // count_tokens rejects empty message content; an empty delta/diff is never sent to
      // Claude, so its real deployment cost is 0 (matches the proxy, which also yields 0).
      if (text === '') return 0;
      const hit = memo.get(text);
      if (hit !== undefined) return hit;
      const n = await request(text);
      memo.set(text, n);
      return n;
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
