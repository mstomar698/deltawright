// Pluggable token counter for the ADMISSIBLE benchmark (issue #25).
//
// WHY THIS EXISTS (the real use case): Deltawright's headline claim is that its action-scoped
// delta is a MORE COMPACT "what changed" than the incumbents an agent would otherwise read
// (re-dumping the a11y tree, or a full snapshot diff). For an LLM agent, tokens are money +
// latency + context-window pressure, so "is the delta actually cheaper to read?" is THE
// go/no-go. This module counts those tokens; the benchmark (run-admissible.ts) turns it into
// delta-vs-incumbent ratios. Without measuring tokens, the compactness claim is hand-waving.
//
// WHY PER-PROVIDER (why an Anthropic endpoint at all, and a Gemini one, etc.): there is NO
// universal tokenizer — every model family splits text differently, so the SAME text is a
// different token count on GPT vs Claude vs Gemini. Only OpenAI publishes an offline
// tokenizer; Anthropic and Google are API-only. So to get the EXACT number for a given
// deployment you must count with THAT model's tokenizer. You use the ONE counter matching
// your target model — never all three at once; the others are just there for other users'
// deployments. IMPORTANT: the offline OpenAI tokenizer already answers the go/no-go
// DIRECTION for everyone (ratios cancel most tokenizer differences), so a deployment key is
// OPTIONAL — it only pins the exact absolute number for your specific model.
//
// The counter is selectable by which deployment key is present:
//
//   DEFAULT — OpenAI's tokenizer OFFLINE (cl100k via gpt-tokenizer; src `tokenCount`). No
//     network, no key, deterministic. This is the REAL deployment counter for OpenAI
//     (GPT-4 / 3.5-class) targets, and a close cross-model PROXY for the rest — ratios cancel
//     most tokenizer-vocabulary differences, so the go/no-go DIRECTION holds regardless. It
//     counts RAW text; a real API counter additionally includes that provider's small
//     per-message framing, so absolute numbers differ slightly across modes.
//
//   OPT-IN (deployment counters) — the real tokenizer of the target model, used when its key
//     is set. ANTHROPIC_API_KEY → Anthropic `POST /v1/messages/count_tokens`; else
//     GEMINI_API_KEY (or GOOGLE_API_KEY) → Gemini `models/{m}:countTokens`. Both count a
//     REQUEST (content + that provider's small per-message framing), which is what a delta
//     actually costs in production, and both are FREE (no per-token cost) but auth-gated +
//     rate-limited. So we memoize per unique text: the STRUCTURAL views (delta-lite /
//     struct-diff / re-snapshot) are byte-identical across the N reps and memoize to ONE
//     call each; the FULL delta text embeds geometry rects that vary sub-pixel per rep, so
//     it does NOT fully memoize — a run can make ~N calls for that column. Transient
//     429/overload is retried with backoff below, so this stays well-behaved.
//
// INTEGRITY: on a NON-retryable failure (bad key/model/request, or exhausted retries) we
// throw — we do NOT silently fall back to the proxy, because a run that quietly mixes
// counters and labels every number with the deployment model would corrupt the §10
// statistic. Fix the key/model, or unset the env var to use the proxy.
//
// This module lives in bench/ ONLY — the published package stays offline + dep-free; no
// network tokenizer ships in the library.
import { tokenCount as cl100kProxy } from '../src/index';

export type CounterName = 'cl100k-proxy' | 'anthropic-count_tokens' | 'gemini-count_tokens';

export interface TokenCounter {
  /** Machine name of the active counter (printed in the results header). */
  readonly name: CounterName;
  /** True for a real API deployment counter (Anthropic or Gemini), not the offline proxy. */
  readonly isDeploymentCounter: boolean;
  /** Human label for the results header. */
  readonly label: string;
  count(text: string): Promise<number>;
}

const proxyCounter: TokenCounter = {
  name: 'cl100k-proxy',
  isDeploymentCounter: false,
  label:
    'OpenAI cl100k OFFLINE (gpt-tokenizer, raw-text) — exact for OpenAI targets, a proxy otherwise; set ANTHROPIC_API_KEY or GEMINI_API_KEY for another model',
  count: (text) => Promise.resolve(cl100kProxy(text)),
};

// Transient statuses worth retrying (rate-limit + server/overload). 4xx caller errors
// (bad key/model/request) are NOT retried — retrying cannot fix them, so we fail loud.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Shared deployment-counter engine: memoized, retries transient rate-limit/overload with
 * backoff, and FAILS LOUD (never silently falls back to the proxy) on a non-retryable error
 * or exhausted retries. `doFetch` performs the provider request; `parse` pulls the token
 * count out of the (ok) JSON body, returning undefined for a malformed response.
 */
function apiCounter(opts: {
  name: CounterName;
  label: string;
  provider: string; // e.g. 'Anthropic count_tokens' — used in error messages
  fixHint: string; // provider-specific "how to fix the key/model" note
  doFetch: (text: string) => Promise<Response>;
  parse: (json: unknown) => number | undefined;
}): TokenCounter {
  const memo = new Map<string, number>();

  async function request(text: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const res = await opts.doFetch(text);

      if (res.ok) {
        const n = opts.parse(await res.json());
        if (typeof n !== 'number') {
          throw new Error(`${opts.provider} returned no valid token count.`);
        }
        return n;
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
        `${opts.provider} failed (HTTP ${res.status}${retried}). Refusing to silently fall ` +
          `back to the cl100k proxy and mislabel §10 numbers. ${opts.fixHint} Response: ` +
          `${body.slice(0, 300)}`,
      );
    }
  }

  return {
    name: opts.name,
    isDeploymentCounter: true,
    label: opts.label,
    async count(text) {
      // The APIs reject empty content; an empty delta/diff is never sent to the model, so its
      // real deployment cost is 0 (matches the proxy, which also yields 0).
      if (text === '') return 0;
      const hit = memo.get(text);
      if (hit !== undefined) return hit;
      const n = await request(text);
      memo.set(text, n);
      return n;
    },
  };
}

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

function anthropicCounter(apiKey: string, model: string): TokenCounter {
  return apiCounter({
    name: 'anthropic-count_tokens',
    label: `Anthropic count_tokens (model=${model}, incl. per-message framing) — the real deployment counter`,
    provider: 'Anthropic count_tokens',
    fixHint: `Fix the key/model (ANTHROPIC_TOKENIZER_MODEL, currently "${model}") or unset ANTHROPIC_API_KEY to use the offline proxy.`,
    doFetch: (text) =>
      fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      }),
    parse: (json) => (json as { input_tokens?: number }).input_tokens,
  });
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function geminiCounter(apiKey: string, model: string): TokenCounter {
  const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:countTokens`;
  return apiCounter({
    name: 'gemini-count_tokens',
    label: `Gemini countTokens (model=${model}) — the real deployment counter`,
    provider: 'Gemini countTokens',
    fixHint: `Fix the key/model (GEMINI_TOKENIZER_MODEL, currently "${model}") or unset GEMINI_API_KEY to use the offline proxy.`,
    // Key goes in a header, never the URL/query, so it can't leak into logs.
    doFetch: (text) =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
      }),
    parse: (json) => (json as { totalTokens?: number }).totalTokens,
  });
}

/**
 * Select the token counter from the environment. Precedence: ANTHROPIC_API_KEY (Anthropic),
 * else GEMINI_API_KEY / GOOGLE_API_KEY (Gemini), else the offline cl100k proxy. Model is
 * overridable per provider via ANTHROPIC_TOKENIZER_MODEL / GEMINI_TOKENIZER_MODEL.
 */
export function selectCounter(env: NodeJS.ProcessEnv = process.env): TokenCounter {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    const model = env.ANTHROPIC_TOKENIZER_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
    return anthropicCounter(anthropicKey, model);
  }
  const geminiKey = (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim();
  if (geminiKey) {
    const model = env.GEMINI_TOKENIZER_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    return geminiCounter(geminiKey, model);
  }
  return proxyCounter;
}
