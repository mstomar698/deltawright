import { test, expect } from '@playwright/test';
import { selectCounter } from '../bench/token-counter';
import { tokenCount } from '../src/index';

// The admissible-benchmark (#25) pluggable token counter: OpenAI cl100k offline by default,
// real Anthropic count_tokens (ANTHROPIC_API_KEY) or Gemini countTokens (GEMINI_API_KEY /
// GOOGLE_API_KEY) as the deployment counter. All the selection + integrity logic is exercised
// here WITHOUT real network by stubbing globalThis.fetch.

test('with no key, selects the OFFLINE cl100k proxy (not the deployment counter)', async () => {
  const c = selectCounter({});
  expect(c.name).toBe('cl100k-proxy');
  expect(c.isDeploymentCounter).toBe(false);
});

test('proxy counts match the src cl100k tokenCount exactly (same offline number)', async () => {
  const c = selectCounter({});
  const s = '+ listitem "buy milk" [r3]\n- listitem "write report" [r4]';
  expect(await c.count(s)).toBe(tokenCount(s));
  expect(await c.count('')).toBe(tokenCount('')); // empty is well-defined
});

test('with a key, selects the Anthropic deployment counter; model is overridable', async () => {
  const def = selectCounter({ ANTHROPIC_API_KEY: 'sk-test' });
  expect(def.name).toBe('anthropic-count_tokens');
  expect(def.isDeploymentCounter).toBe(true);
  expect(def.label).toContain('claude-sonnet-5'); // default model

  const over = selectCounter({
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_TOKENIZER_MODEL: 'claude-opus-4-8',
  });
  expect(over.label).toContain('claude-opus-4-8');
});

test('a blank/whitespace key falls back to the proxy (no accidental network mode)', async () => {
  expect(selectCounter({ ANTHROPIC_API_KEY: '   ' }).name).toBe('cl100k-proxy');
  expect(selectCounter({ ANTHROPIC_API_KEY: undefined }).name).toBe('cl100k-proxy');
});

test('Anthropic counter: empty text short-circuits to 0 with NO network call', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('should not be called');
  }) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(await c.count('')).toBe(0);
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('Anthropic counter: parses input_tokens and MEMOIZES (one call for repeated text)', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ input_tokens: 42 }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(await c.count('hello world')).toBe(42);
    expect(await c.count('hello world')).toBe(42); // memo hit
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('Anthropic counter: FAILS LOUD on a non-retryable 401 without retrying', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'authentication_error',
    } as Response;
  }) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-bad' });
    await expect(c.count('some delta text')).rejects.toThrow(/count_tokens failed \(HTTP 401\)/);
    await expect(c.count('some delta text')).rejects.toThrow(/Refusing to silently fall back/);
    expect(calls).toBe(2); // one fetch per count() call — a 4xx caller error is NEVER retried
  } finally {
    globalThis.fetch = orig;
  }
});

test('Anthropic counter: retries a transient 429 with backoff, then succeeds', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null }, // no Retry-After → exponential backoff
        json: async () => ({}),
        text: async () => 'rate_limit_error',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ input_tokens: 17 }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(await c.count('rate me')).toBe(17);
    expect(calls).toBe(2); // one 429, retried once, then success
  } finally {
    globalThis.fetch = orig;
  }
});

test('Anthropic counter: throws on a malformed (no token count) response', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
      text: async () => '',
    }) as Response) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-test' });
    await expect(c.count('x')).rejects.toThrow(
      /Anthropic count_tokens returned no valid token count/,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

// --- Gemini deployment counter ---------------------------------------------------------

test('with GEMINI_API_KEY (and no Anthropic key), selects the Gemini deployment counter', async () => {
  const def = selectCounter({ GEMINI_API_KEY: 'g-test' });
  expect(def.name).toBe('gemini-count_tokens');
  expect(def.isDeploymentCounter).toBe(true);
  expect(def.label).toContain('gemini-2.5-flash'); // default model
  // GOOGLE_API_KEY is an accepted alias.
  expect(selectCounter({ GOOGLE_API_KEY: 'g-test' }).name).toBe('gemini-count_tokens');
  // model override
  expect(
    selectCounter({ GEMINI_API_KEY: 'g-test', GEMINI_TOKENIZER_MODEL: 'gemini-2.5-pro' }).label,
  ).toContain('gemini-2.5-pro');
});

test('Anthropic takes precedence when both an Anthropic and a Gemini key are present', async () => {
  const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' });
  expect(c.name).toBe('anthropic-count_tokens');
});

test('Gemini counter: parses totalTokens and MEMOIZES; empty text is 0 with no network', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ totalTokens: 55 }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    const c = selectCounter({ GEMINI_API_KEY: 'g-test' });
    expect(await c.count('')).toBe(0);
    expect(calls).toBe(0); // empty short-circuits, no request
    expect(await c.count('hello')).toBe(55);
    expect(await c.count('hello')).toBe(55); // memo hit
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('Gemini counter: FAILS LOUD on a non-retryable 401 (never silently falls back)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'API key not valid',
    }) as Response) as typeof fetch;
  try {
    const c = selectCounter({ GEMINI_API_KEY: 'g-bad' });
    await expect(c.count('some delta text')).rejects.toThrow(
      /Gemini countTokens failed \(HTTP 401\)/,
    );
    await expect(c.count('some delta text')).rejects.toThrow(/Refusing to silently fall back/);
  } finally {
    globalThis.fetch = orig;
  }
});
