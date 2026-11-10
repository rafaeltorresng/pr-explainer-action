const { describe, expect, test } = require('bun:test');
const { resolveConfig, PROVIDERS } = require('../src/config');
const {
  callProvider,
  callChatCompletions,
  callAnthropicMessages,
  sanitizeLogMessage,
  isPermanentError,
  parseRetryAfter,
  calculateDelay
} = require('../src/providers/transport');

describe('provider resolution & config precedence', () => {
  test('defaults to openrouter when no provider is specified', () => {
    const config = resolveConfig({});
    expect(config.provider).toBe('openrouter');
    expect(config.model).toBe('deepseek/deepseek-v4-flash');
    expect(config.apiBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  test('normalizes provider aliases (google -> gemini, claude -> anthropic, grok -> xai)', () => {
    expect(resolveConfig({ AI_PROVIDER: 'google' }).provider).toBe('gemini');
    expect(resolveConfig({ AI_PROVIDER: 'claude' }).provider).toBe('anthropic');
    expect(resolveConfig({ AI_PROVIDER: 'grok' }).provider).toBe('xai');
  });

  test('throws on unsupported provider', () => {
    expect(() => resolveConfig({ AI_PROVIDER: 'unsupported-ai' })).toThrow(/unsupported ai provider/i);
  });

  test('uses DeepSeek V4.1 Flash as the default Featherless model', () => {
    const config = resolveConfig({
      AI_PROVIDER: 'featherless',
      FEATHERLESS_API_KEY: 'ft_test_123'
    });
    expect(config.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
  });

  test('resolves provider-specific api keys and models', () => {
    const featherlessConfig = resolveConfig({
      AI_PROVIDER: 'featherless',
      FEATHERLESS_API_KEY: 'ft_test_123'
    });
    expect(featherlessConfig.provider).toBe('featherless');
    expect(featherlessConfig.apiKey).toBe('ft_test_123');
    expect(featherlessConfig.model).toBe(PROVIDERS.featherless.defaultModel);

    const openaiConfig = resolveConfig({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk_test_456'
    });
    expect(openaiConfig.provider).toBe('openai');
    expect(openaiConfig.apiKey).toBe('sk_test_456');
    expect(openaiConfig.model).toBe(PROVIDERS.openai.defaultModel);

    const anthropicConfig = resolveConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-789'
    });
    expect(anthropicConfig.provider).toBe('anthropic');
    expect(anthropicConfig.apiKey).toBe('sk-ant-test-789');
    expect(anthropicConfig.model).toBe(PROVIDERS.anthropic.defaultModel);
  });

  test('AI_API_KEY overrides provider-specific env variables', () => {
    const config = resolveConfig({
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'override_key',
      OPENAI_API_KEY: 'fallback_key'
    });
    expect(config.apiKey).toBe('override_key');
  });

  test('caps output tokens per provider and honors explicit overrides', () => {
    expect(resolveConfig({}).maxOutputTokens).toBe(16384);
    expect(resolveConfig({ AI_PROVIDER: 'anthropic' }).maxOutputTokens).toBe(8192);
    expect(resolveConfig({ AI_PROVIDER: 'anthropic', MAX_OUTPUT_TOKENS: '12000' }).maxOutputTokens).toBe(8192);
    expect(resolveConfig({ AI_PROVIDER: 'featherless', MAX_OUTPUT_TOKENS: '4096' }).maxOutputTokens).toBe(4096);
  });

  test('backward compatibility: accepts OPENROUTER_API_KEY and OPENROUTER_MODEL directly', () => {
    const config = resolveConfig({
      OPENROUTER_API_KEY: 'legacy_or_key',
      OPENROUTER_MODEL: 'anthropic/claude-3-opus'
    });
    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('legacy_or_key');
    expect(config.model).toBe('anthropic/claude-3-opus');
  });
});

describe('security: log and error sanitization', () => {
  test('redacts Bearer tokens and API keys from error messages', () => {
    const rawMsg = 'Failed with header Authorization: Bearer sk-ant-api03-secret123456789 and api_key=sk-998877665544332211';
    const sanitized = sanitizeLogMessage(rawMsg);

    expect(sanitized).not.toContain('secret123456789');
    expect(sanitized).not.toContain('998877665544332211');
    expect(sanitized).toContain('Bearer [REDACTED]');
    expect(sanitized).toContain('api_key=[REDACTED]');
  });
});

describe('provider contract tests (mocked HTTP)', () => {
  test('Chat Completions transport sends proper headers and payload for OpenAI-compatible providers', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};
    let capturedBody = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = JSON.parse(options.body);

      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({
          choices: [
            {
              message: { content: '{"summary":{"problem":"test"}}' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
        })
      };
    };

    try {
      const result = await callChatCompletions({
        provider: 'featherless',
        apiBaseUrl: 'https://api.featherless.ai/v1',
        apiKey: 'test-key',
        model: 'meta-llama/test-model',
        systemInstruction: 'sys prompt',
        userPrompt: 'user prompt',
        timeoutMs: 5000,
        maxRetries: 1,
        maxOutputTokens: 8192
      });

      expect(capturedUrl).toBe('https://api.featherless.ai/v1/chat/completions');
      expect(capturedHeaders['Authorization']).toBe('Bearer test-key');
      expect(capturedBody.model).toBe('meta-llama/test-model');
      expect(capturedBody.messages).toHaveLength(2);
      expect(capturedBody.response_format).toEqual({ type: 'json_object' });
      expect(capturedBody.max_tokens).toBe(8192);
      expect(result.usage.total_tokens).toBe(40);
      expect(result.rawContent).toContain('summary');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('OpenRouter provider attaches HTTP-Referer and X-Title headers', async () => {
    let capturedHeaders = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      capturedHeaders = options.headers;
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{}' }, finish_reason: 'stop' }]
        })
      };
    };

    try {
      await callChatCompletions({
        provider: 'openrouter',
        apiBaseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-test-key',
        model: 'deepseek/deepseek-v4-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr'
      });

      expect(capturedHeaders['HTTP-Referer']).toBe('https://github.com/rafaeltorresng/pr-explainer-action');
      expect(capturedHeaders['X-Title']).toBe('PR Explainer AI');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Anthropic adapter sends x-api-key, anthropic-version, max_tokens and system field', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};
    let capturedBody = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = JSON.parse(options.body);

      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: '{"summary":{"problem":"claude test"}}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 80 }
        })
      };
    };

    try {
      const result = await callAnthropicMessages({
        apiBaseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
        model: 'claude-3-5-sonnet-20241022',
        systemInstruction: 'System instruction text',
        userPrompt: 'User prompt diff text'
      });

      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
      expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
      expect(capturedBody.system).toBe('System instruction text');
      expect(capturedBody.max_tokens).toBeGreaterThan(1000);
      expect(result.usage.total_tokens).toBe(130);
      expect(result.rawContent).toContain('claude test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('normalizes Anthropic stop_reason max_tokens to finishReason length', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify({
        content: [{ type: 'text', text: '{"partial":true}' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    });

    try {
      const result = await callAnthropicMessages({
        apiBaseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
        model: 'claude-3-5-sonnet-20241022',
        systemInstruction: 'sys',
        userPrompt: 'usr'
      });

      expect(result.finishReason).toBe('length');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Fails fast on permanent 401 Unauthorized without retrying', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      callCount++;
      return {
        status: 401,
        ok: false,
        headers: new Headers(),
        text: async () => '{"error":{"message":"Invalid API key"}}'
      };
    };

    try {
      await expect(callChatCompletions({
        provider: 'openai',
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'bad-key',
        model: 'gpt-4o-mini',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        maxRetries: 2
      })).rejects.toThrow(/status 401/i);

      // Must be called exactly 1 time — no retries on 401!
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Retries on transient 500 error with backoff', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 2) {
        return {
          status: 503,
          ok: false,
          headers: new Headers(),
          text: async () => 'Service Temporarily Unavailable'
        };
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      };
    };

    try {
      const res = await callChatCompletions({
        provider: 'openrouter',
        apiBaseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'test',
        model: 'deepseek/deepseek-v4-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        maxRetries: 2
      });

      expect(callCount).toBe(2);
      expect(res.rawContent).toBe('{"ok":true}');
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('Respects Retry-After header for rate limits (429)', () => {
    const headers = new Headers();
    headers.set('retry-after', '12');
    const delay = parseRetryAfter({ headers });
    expect(delay).toBe(12000); // 12s in ms
  });

  test('Retry-After delay replaces, rather than stacks with, exponential backoff', async () => {
    let callCount = 0;
    const delays = [];
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = (fn, ms) => {
      delays.push(ms);
      fn();
      return 0;
    };

    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        const headers = new Headers();
        headers.set('retry-after', '7');
        return {
          status: 429,
          ok: false,
          headers,
          text: async () => 'rate limited'
        };
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };

    try {
      const result = await callChatCompletions({
        provider: 'openrouter',
        apiBaseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'test',
        model: 'deepseek/deepseek-v4-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        maxRetries: 1
      });

      expect(callCount).toBe(2);
      expect(result.rawContent).toBe('{"ok":true}');
      expect(delays.filter((ms) => ms === 7000)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
