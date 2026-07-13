import { test, expect } from '@playwright/test';
import { selectCounter } from '../bench/token-counter';
import { tokenCount } from '../src/index';

// The admissible-benchmark (#25) pluggable token counter: offline cl100k proxy by
// default, real Anthropic count_tokens when ANTHROPIC_API_KEY is set. All the selection +
// integrity logic is exercised here WITHOUT real network by stubbing globalThis.fetch.

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

test('Anthropic counter: FAILS LOUD on a non-ok response (never silently falls back)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'authentication_error',
    }) as Response) as typeof fetch;
  try {
    const c = selectCounter({ ANTHROPIC_API_KEY: 'sk-bad' });
    await expect(c.count('some delta text')).rejects.toThrow(/count_tokens failed \(HTTP 401\)/);
    await expect(c.count('some delta text')).rejects.toThrow(/Refusing to silently fall back/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('Anthropic counter: throws if input_tokens is missing (malformed response)', async () => {
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
    await expect(c.count('x')).rejects.toThrow(/no input_tokens field/);
  } finally {
    globalThis.fetch = orig;
  }
});
