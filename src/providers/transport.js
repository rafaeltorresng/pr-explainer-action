const FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLogMessage(message) {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key[:=]\s*)[A-Za-z0-9_\-\.]{10,}/gi, '$1[REDACTED]')
    .replace(/(x-api-key[:=]\s*)[A-Za-z0-9_\-\.]{10,}/gi, '$1[REDACTED]');
}

function isPermanentError(status) {
  // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found
  return status >= 400 && status < 429;
}

function parseRetryAfter(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 60000); // max 60s
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    if (diff > 0) return Math.min(diff, 60000);
  }
  return null;
}

function calculateDelay(attempt, retryAfterMs) {
  if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

async function fetchWithFullTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    // Consuming response body within the same timeout!
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callChatCompletions({
  provider,
  apiBaseUrl,
  apiKey,
  model,
  systemInstruction,
  userPrompt,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  maxOutputTokens = null
}) {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/rafaeltorresng/pr-explainer-action';
    headers['X-Title'] = 'PR Explainer AI';
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  const outputLimit = Number(maxOutputTokens);
  if (Number.isFinite(outputLimit) && outputLimit > 0) {
    payload.max_tokens = Math.floor(outputLimit);
  }

  let lastError;
  let retryDelayMs = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      const delay = retryDelayMs !== null ? retryDelayMs : calculateDelay(attempt, null);
      retryDelayMs = null;
      console.warn(`[${provider}] Attempt ${attempt}/${maxRetries + 1} after ${delay}ms...`);
      await sleep(delay);
    }

    try {
      const res = await fetchWithFullTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        },
        timeoutMs
      );

      if (!res.ok) {
        const errorDetail = sanitizeLogMessage(res.text.slice(0, 300));
        const err = new Error(`${provider} API error: status ${res.status} - ${errorDetail}`);
        err.status = res.status;

        if (isPermanentError(res.status)) {
          // Fail fast on 400, 401, 403, 404
          throw err;
        }

        const retryAfter = parseRetryAfter(res);
        if (attempt <= maxRetries && retryAfter) {
          console.warn(`[${provider}] Respecting Retry-After header: ${retryAfter}ms`);
          retryDelayMs = retryAfter;
        }
        throw err;
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch (parseErr) {
        throw new Error(`${provider} returned non-JSON response: ${sanitizeLogMessage(res.text.slice(0, 200))}`);
      }

      if (!data || !data.choices || data.choices.length === 0 || !data.choices[0].message) {
        throw new Error(`${provider} returned a response without choices or message.`);
      }

      const choice = data.choices[0];
      if (choice.finish_reason === 'length') {
        console.warn(`[${provider}] Warning: completion finish_reason is 'length' (response may be truncated).`);
      }

      const rawContent = choice.message.content || '';
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const nativeCost = (data.usage && typeof data.usage.cost === 'number') ? data.usage.cost : null;

      return {
        rawContent,
        usage,
        nativeCost,
        finishReason: choice.finish_reason || 'stop',
        attempt
      };
    } catch (err) {
      lastError = err;
      console.warn(`[${provider}] Attempt ${attempt} failed: ${sanitizeLogMessage(err.message)}`);
      if (isPermanentError(err.status)) {
        break; // Do not retry permanent errors
      }
    }
  }

  throw lastError;
}

async function callAnthropicMessages({
  apiBaseUrl,
  apiKey,
  model,
  systemInstruction,
  userPrompt,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  maxOutputTokens = 4096
}) {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  const payload = {
    model,
    system: systemInstruction,
    messages: [
      { role: 'user', content: userPrompt }
    ],
    max_tokens: Math.max(1, Math.floor(Number(maxOutputTokens) || 4096)),
    temperature: 0.1
  };

  let lastError;
  let retryDelayMs = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      const delay = retryDelayMs !== null ? retryDelayMs : calculateDelay(attempt, null);
      retryDelayMs = null;
      console.warn(`[anthropic] Attempt ${attempt}/${maxRetries + 1} after ${delay}ms...`);
      await sleep(delay);
    }

    try {
      const res = await fetchWithFullTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        },
        timeoutMs
      );

      if (!res.ok) {
        const errorDetail = sanitizeLogMessage(res.text.slice(0, 300));
        const err = new Error(`Anthropic API error: status ${res.status} - ${errorDetail}`);
        err.status = res.status;

        if (isPermanentError(res.status)) {
          throw err;
        }

        const retryAfter = parseRetryAfter(res);
        if (attempt <= maxRetries && retryAfter) {
          console.warn(`[anthropic] Respecting Retry-After header: ${retryAfter}ms`);
          retryDelayMs = retryAfter;
        }
        throw err;
      }

      let data;
      try {
        data = JSON.parse(res.text);
      } catch (parseErr) {
        throw new Error(`Anthropic returned non-JSON response: ${sanitizeLogMessage(res.text.slice(0, 200))}`);
      }

      if (!data || !Array.isArray(data.content) || data.content.length === 0) {
        throw new Error('Anthropic returned empty content array.');
      }

      const textBlock = data.content.find((block) => block.type === 'text') || data.content[0];
      const rawContent = textBlock.text || '';
      const usage = {
        prompt_tokens: (data.usage && data.usage.input_tokens) || 0,
        completion_tokens: (data.usage && data.usage.output_tokens) || 0,
        total_tokens: ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.output_tokens) || 0)
      };

      return {
        rawContent,
        usage,
        nativeCost: null,
        finishReason: data.stop_reason === 'max_tokens' ? 'length' : (data.stop_reason || 'stop'),
        attempt
      };
    } catch (err) {
      lastError = err;
      console.warn(`[anthropic] Attempt ${attempt} failed: ${sanitizeLogMessage(err.message)}`);
      if (isPermanentError(err.status)) {
        break;
      }
    }
  }

  throw lastError;
}

async function callProvider({
  provider,
  providerMeta,
  apiBaseUrl,
  apiKey,
  model,
  systemInstruction,
  userPrompt,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  maxOutputTokens = null
}) {
  if (providerMeta && providerMeta.apiType === 'anthropic_messages') {
    return callAnthropicMessages({
      apiBaseUrl,
      apiKey,
      model,
      systemInstruction,
      userPrompt,
      timeoutMs,
      maxRetries,
      maxOutputTokens
    });
  }

  return callChatCompletions({
    provider,
    apiBaseUrl,
    apiKey,
    model,
    systemInstruction,
    userPrompt,
    timeoutMs,
    maxRetries,
    maxOutputTokens
  });
}

module.exports = {
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  callProvider,
  callChatCompletions,
  callAnthropicMessages,
  sanitizeLogMessage,
  isPermanentError,
  parseRetryAfter,
  calculateDelay
};
