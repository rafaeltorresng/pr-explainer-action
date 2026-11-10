const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    apiType: 'chat_completions'
  },
  featherless: {
    id: 'featherless',
    name: 'Featherless',
    defaultBaseUrl: 'https://api.featherless.ai/v1',
    defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    apiType: 'chat_completions'
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiType: 'chat_completions'
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-20241022',
    apiType: 'anthropic_messages'
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-beta',
    apiType: 'chat_completions'
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-1.5-flash',
    apiType: 'chat_completions'
  }
};

const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_MAX_LINES = 15000;
const DEFAULT_MAX_CONTEXT_FILES = 2;
const DEFAULT_MAX_CONTEXT_BYTES = 8192; // 8 KB
const DEFAULT_RETENTION_DAYS = 14;

function normalizeProviderName(raw) {
  if (!raw) return DEFAULT_PROVIDER;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'google' || normalized === 'google-gemini') return 'gemini';
  if (normalized === 'claude') return 'anthropic';
  if (normalized === 'grok') return 'xai';
  if (!PROVIDERS[normalized]) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unsupported AI provider "${raw}". Supported providers: ${supported}`);
  }
  return normalized;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveConfig(env = process.env, overrides = {}) {
  const rawProvider = overrides.aiProvider || env.INPUT_AI_PROVIDER || env.AI_PROVIDER || DEFAULT_PROVIDER;
  const providerKey = normalizeProviderName(rawProvider);
  const providerMeta = PROVIDERS[providerKey];

  // Resolve API key with clear precedence
  let apiKey = overrides.apiKey || env.INPUT_AI_API_KEY || env.AI_API_KEY;

  if (!apiKey) {
    if (providerKey === 'openrouter') {
      apiKey = overrides.openrouterApiKey || env.INPUT_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
    } else if (providerKey === 'featherless') {
      apiKey = env.FEATHERLESS_API_KEY;
    } else if (providerKey === 'openai') {
      apiKey = env.OPENAI_API_KEY;
    } else if (providerKey === 'anthropic') {
      apiKey = env.ANTHROPIC_API_KEY;
    } else if (providerKey === 'xai') {
      apiKey = env.XAI_API_KEY;
    } else if (providerKey === 'gemini') {
      apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    }
  }

  // Model resolution
  let model = overrides.model || env.INPUT_AI_MODEL || env.AI_MODEL;
  if (!model && providerKey === 'openrouter') {
    model = overrides.openrouterModel || env.INPUT_OPENROUTER_MODEL || env.OPENROUTER_MODEL;
  }
  if (!model) {
    model = providerMeta.defaultModel;
  }

  // Base URL resolution
  let apiBaseUrl = overrides.apiBaseUrl || env.INPUT_AI_BASE_URL || env.AI_BASE_URL;
  if (!apiBaseUrl && providerKey === 'openrouter') {
    apiBaseUrl = overrides.openrouterApiBaseUrl || env.INPUT_OPENROUTER_API_BASE_URL || env.OPENROUTER_API_BASE_URL;
  }
  if (!apiBaseUrl) {
    apiBaseUrl = providerMeta.defaultBaseUrl;
  }

  // Context retrieval
  const enableContext = parseBoolean(
    overrides.enableContextRetrieval !== undefined
      ? overrides.enableContextRetrieval
      : (env.INPUT_ENABLE_CONTEXT_RETRIEVAL || env.ENABLE_CONTEXT_RETRIEVAL || 'true'),
    true
  );

  const maxContextFiles = positiveNumber(
    overrides.maxContextFiles || env.INPUT_MAX_CONTEXT_FILES || env.MAX_CONTEXT_FILES,
    DEFAULT_MAX_CONTEXT_FILES
  );
  const maxContextBytes = positiveNumber(
    overrides.maxContextBytes || env.INPUT_MAX_CONTEXT_BYTES || env.MAX_CONTEXT_BYTES,
    DEFAULT_MAX_CONTEXT_BYTES
  );
  const maxLines = positiveNumber(
    overrides.maxLines || env.INPUT_MAX_LINES || env.MAX_LINES,
    DEFAULT_MAX_LINES
  );

  // Pages publication is opt-in and only prepares a directory. A URL is never
  // inferred; it must be supplied explicitly after a real deployment.
  const publishPages = parseBoolean(
    overrides.publishPages !== undefined
      ? overrides.publishPages
      : (env.INPUT_PUBLISH_PAGES || env.PUBLISH_PAGES || 'false'),
    false
  );

  return {
    provider: providerKey,
    providerMeta,
    apiKey,
    model,
    apiBaseUrl,
    enableContext,
    maxContextFiles: Math.max(1, Math.floor(maxContextFiles)),
    maxContextBytes: Math.max(512, Math.floor(maxContextBytes)),
    maxLines: Math.max(1, Math.floor(maxLines)),
    publishPages,
    pagesOutputDir: overrides.pagesOutputDir || env.PAGES_OUTPUT_DIR || 'pages-dist',
    pagesDeploymentUrl: overrides.pagesDeploymentUrl || env.PAGES_DEPLOYMENT_URL || '',
    githubToken: env.GITHUB_TOKEN || env.INPUT_GITHUB_TOKEN || '',
    retentionDays: positiveNumber(env.INPUT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  };
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_CONTEXT_FILES,
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_RETENTION_DAYS,
  normalizeProviderName,
  resolveConfig
};
