const { describe, expect, test } = require('bun:test');
const {
  escapeHtml,
  stripMarkdownFences,
  parseModelContent,
  validateExplanation,
  normalizeSemanticContent
} = require('../src/content/parser');

const {
  renderEditorialDocument,
  renderEvidenceSection,
  renderSimulationSection,
  renderQuizHtml
} = require('../src/render/editorial-template');

const {
  COMMENT_MARKER,
  sanitizeInlineText,
  safeCodeSpan,
  generateMarkdownComment,
  generateOutdatedComment
} = require('../src/render/markdown-comment');

describe('content parsing & semantic normalization', () => {
  test('normalizes rich semantic format preserving evidence and simulation', () => {
    const raw = {
      summary: {
        problem: 'Memory leaks from unbound map growth',
        solution: 'Introduces LRU eviction bounded to capacity',
        invariants: ['Oldest key is evicted when size reaches capacity']
      },
      mechanism: {
        overview: 'Map keys re-inserted on access to move to end of iteration order',
        insights: ['Constant-time operations using ES Map order']
      },
      evidence: {
        verifiedCodeFacts: ['Map.delete then Map.set on get()', 'values.keys().next().value on eviction'],
        authorIntent: ['Bound memory usage in production'],
        unknownsOrRisks: ['No thread locks']
      },
      visualizations: [
        {
          type: 'flow',
          title: 'Cache Eviction Flow',
          nodes: [
            { id: '1', label: 'set(key, value)', description: 'Entry point' },
            { id: '2', label: 'Check capacity', description: 'size >= capacity' },
            { id: '3', label: 'Evict oldest', description: 'Remove map head' }
          ]
        }
      ],
      simulation: {
        enabled: true,
        title: 'Cache Operation Simulation',
        description: 'Predict whether get() hits or causes eviction',
        rule: 'Keys accessed most recently are preserved',
        scenarios: [
          {
            id: 'hit',
            label: 'Get Existing Key',
            outcome: { action: 'Cache Hit', status: '200' },
            explanation: 'Key was present and moved to end of queue'
          }
        ]
      },
      quiz: [
        {
          question: 'What ensures constant time eviction?',
          options: ['ES Map iteration order', 'Binary tree search', 'Periodic garbage collection', 'LRU linked list'],
          correctOptionIndex: 0,
          explanations: ['Correct: Map preserves insertion order', 'No: Map is used', 'No', 'No external list used']
        }
      ]
    };

    const normalized = normalizeSemanticContent(raw, { prBody: 'PR description text' });

    expect(normalized.summary.problem).toContain('Memory leaks');
    expect(normalized.mechanism.overview).toContain('Map keys re-inserted');
    expect(normalized.evidence.verifiedCodeFacts).toHaveLength(2);
    expect(normalized.simulation.enabled).toBe(true);
    expect(normalized.visualizations).toHaveLength(1);
    expect(normalized.quiz).toHaveLength(1);
  });

  test('gracefully maps legacy format (background, intuition, diagrams, codeWalkthrough)', () => {
    const legacy = {
      background: '<p>Prior background</p>',
      intuition: '<p>Core intuition</p>',
      diagrams: '<div>Legacy diagram</div>',
      codeWalkthrough: '<pre>const x = 1;</pre>',
      quiz: []
    };

    const normalized = normalizeSemanticContent(legacy, { prBody: 'Author intent' });

    expect(normalized.summary.problem).toBe('Prior background');
    expect(normalized.mechanism.overview).toBe('Core intuition');
    expect(normalized.background).toBe('Prior background');
    expect(normalized.diagrams).toBe('Legacy diagram');
    expect(normalized.codeWalkthrough).toBe('const x = 1;');
    expect(normalized.evidence.authorIntent[0]).toContain('Author intent');
  });

  test('repairs a response that is missing only the opening root brace', () => {
    const payload = '"summary":{"problem":"P","solution":"S"},"quiz":[]}';
    const parsed = parseModelContent(payload);
    expect(parsed.summary.problem).toBe('P');
    expect(parsed.summary.solution).toBe('S');
  });

  test('still rejects genuinely truncated JSON', () => {
    expect(() => parseModelContent('{"summary":{"problem":"unfinished')).toThrow(/truncado|Failed to parse JSON/);
  });
});

describe('walkthrough line references', () => {
  test('prefixes numeric ranges with L and leaves symbols untouched', () => {
    const content = normalizeSemanticContent({
      summary: { problem: 'P', solution: 'S' },
      mechanism: { overview: 'M' },
      walkthrough: [
        {
          groupTitle: 'Group',
          files: [
            { path: 'a.ts', keyLines: '22-30' },
            { path: 'b.ts', keyLines: 'calculatePagination' },
            { path: 'c.ts', keyLines: 'L42' }
          ]
        }
      ]
    });

    const html = renderEditorialDocument({
      prNumber: '1',
      prTitle: 'P',
      generationDate: 'Date',
      language: 'en',
      model: 'test/model',
      content,
      usage: { total_tokens: 1 }
    });

    expect(html).toContain('>L22-30<');
    expect(html).toContain('>calculatePagination<');
    expect(html).toContain('>L42<');
    expect(html).not.toContain('LcalculatePagination');
    expect(html).not.toContain('LL42');
  });
});

describe('editorial HTML template rendering', () => {
  const sampleContent = {
    summary: {
      problem: 'HTTP 4xx client errors were triggering automatic retries.',
      solution: 'Classify 4xx as non-retryable known_rejection.',
      invariants: ['Status 429 parses Retry-After header']
    },
    mechanism: {
      overview: 'Inspects HTTP status code and headers before queuing retry jobs.',
      insights: ['Avoids hammering upstream services with rejected requests.']
    },
    evidence: {
      verifiedCodeFacts: [
        'status >= 400 && status < 500 returns retryable: false',
        'status === 429 returns retryable: true with Retry-After delay'
      ],
      authorIntent: ['Prevent infinite retry loops on billing rejections'],
      unknownsOrRisks: ['Transport drop network errors still default to retryable']
    },
    simulation: {
      enabled: true,
      title: 'HTTP Error Retry Simulator',
      description: 'Check how different HTTP status codes are handled',
      rule: '4xx client errors are rejected immediately; 429 waits for Retry-After',
      scenarios: [
        {
          id: 's400',
          label: 'HTTP 400 Bad Request',
          outcome: { action: 'Reject Immediately', status: 'known_rejection' },
          explanation: 'Client errors without usage are not retryable.'
        },
        {
          id: 's429',
          label: 'HTTP 429 Rate Limited',
          outcome: { action: 'Retry with Delay', status: 'rate_limited' },
          explanation: 'Respects Retry-After header and queues retry.'
        }
      ]
    },
    walkthrough: [
      {
        groupTitle: 'HTTP Error Classification',
        description: 'Logic modified in client handler',
        files: [
          {
            path: 'src/client/http-handler.ts',
            role: 'Error classifier',
            summary: 'Added 4xx guard and 429 header parsing',
            keyLines: '22-30',
            diffSnippet: '+  if (status >= 400 && status < 500) return { retryable: false };'
          }
        ]
      }
    ],
    quiz: [
      {
        question: 'How is HTTP 429 handled?',
        options: ['Retried with Retry-After delay', 'Never retried', 'Retried immediately', 'Throws fatal exception'],
        correctOptionIndex: 0,
        explanations: ['Correct: parses header', 'No: 429 is retryable', 'No: uses delay', 'No exception']
      },
      {
        question: 'Are 404 errors retried?',
        options: ['No, classified as known_rejection', 'Yes, up to 3 times', 'Only in staging', 'Always'],
        correctOptionIndex: 0,
        explanations: ['Correct: 400-499 are not retryable', 'No', 'No', 'No']
      }
    ],
    limitations: {
      omissions: [],
      unknowns: ['Server side processing cost of 4xx'],
      unverifiedClaims: []
    }
  };

  test('renders full editorial document with light/dark theme, evidence, and simulation', () => {
    const html = renderEditorialDocument({
      prNumber: '3010',
      prTitle: 'fix: avoid retrying 4xx client errors',
      generationDate: 'November 10, 2026',
      language: 'en',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      commitSha: 'a1b2c3d4e5f6',
      usage: { prompt_tokens: 500, completion_tokens: 300, total_tokens: 800 },
      formattedPrice: '$0.000099',
      rateChip: 'Input / Output: $0.09 / $0.18 per 1M',
      content: sampleContent,
      contextMetadata: {
        retrievedFiles: [{ path: 'scripts/deploy-policy.sh' }],
        diffMeta: { isTruncated: false }
      }
    });

    expect(html).toContain('PR #3010');
    expect(html).toContain('fix: avoid retrying 4xx client errors');
    expect(html).toContain('a1b2c3d');
    expect(html).toContain('deepseek/deepseek-v4-flash');
    expect(html).toContain('Evidence &amp; Verified Facts');
    expect(html).toContain('Verified in Code / Tests');
    expect(html).toContain('Author Stated Intent');
    expect(html).toContain('HTTP Error Retry Simulator');
    expect(html).toContain('HTTP 400 Bad Request');
    expect(html).toContain('HTTP 429 Rate Limited');
    expect(html).toContain('src/client/http-handler.ts');
    expect(html).toContain('Context Enriched (1)');
    expect(html).toContain('Toggle Theme');
    // Quiz score denominator matches question count (2 questions -> / 2, NOT / 5)
    expect(html).toContain('/ 2');
    expect(html).toContain('Cost');
  });

  test('renders Portuguese editorial document correctly', () => {
    const html = renderEditorialDocument({
      prNumber: '3010',
      prTitle: 'correção no tratamento de erros HTTP',
      generationDate: '10 de novembro de 2026',
      language: 'pt-BR',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      commitSha: 'a1b2c3d4e5f6',
      usage: { prompt_tokens: 500, completion_tokens: 300, total_tokens: 800 },
      formattedPrice: '$0.000099',
      rateChip: 'Entrada / saída: $0.09 / $0.18 por 1M',
      content: sampleContent
    });

    expect(html).toContain('Explicação do PR #3010');
    expect(html).toContain('Evidências &amp; Fatos Verificados');
    expect(html).toContain('Verificado em Código / Testes');
    expect(html).toContain('Alternar Tema');
    expect(html).toContain('Teste seu Entendimento');
  });

  test('adaptive quiz renders cleanly with 0 questions', () => {
    const emptyQuizHtml = renderQuizHtml([], 'en');
    expect(emptyQuizHtml).toContain('No quiz is required for this concise change.');
  });

  test('escapes hostile model fields in every rendered section and attribute', () => {
    const hostile = '<img src=x onerror="alert(1)">"><script>alert(2)</script></style>';
    const rawContent = {
      summary: { problem: hostile, solution: hostile, invariants: [hostile] },
      mechanism: { overview: hostile, insights: [hostile] },
      evidence: {
        verifiedCodeFacts: [hostile],
        authorIntent: [hostile],
        unknownsOrRisks: [hostile]
      },
      visualizations: [
        {
          type: 'flow',
          title: hostile,
          caption: hostile,
          nodes: [{ id: '1', label: hostile, description: hostile }]
        }
      ],
      walkthrough: [
        {
          groupTitle: hostile,
          description: hostile,
          files: [
            {
              path: hostile,
              role: hostile,
              summary: hostile,
              keyLines: hostile,
              diffSnippet: hostile
            }
          ]
        }
      ],
      simulation: {
        enabled: true,
        title: hostile,
        description: hostile,
        rule: hostile,
        scenarios: [
          {
            id: 'x',
            label: `${hostile}" onmouseover="alert(3)`,
            outcome: { action: hostile, status: hostile },
            explanation: hostile
          }
        ]
      },
      quiz: [
        {
          question: hostile,
          options: [hostile, hostile, hostile, hostile],
          correctOptionIndex: 0,
          explanations: [hostile, hostile, hostile, hostile]
        }
      ],
      limitations: { omissions: [hostile], unknowns: [hostile], unverifiedClaims: [hostile] }
    };

    const content = normalizeSemanticContent(rawContent, { prBody: hostile });
    const html = renderEditorialDocument({
      prNumber: '7',
      prTitle: hostile,
      generationDate: 'November 10, 2026',
      language: 'en',
      provider: 'openrouter',
      model: 'test/model',
      commitSha: 'abcdef1234567890',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      formattedPrice: '$0.000001',
      rateChip: 'Rate',
      content
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('onmouseover="alert(3)"');
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
});

describe('Markdown PR comment generation', () => {
  test('generates markdown comment with marker, evidence breakdown, and action links', () => {
    const sampleContent = {
      summary: { problem: 'Memory leak in session manager' },
      mechanism: { overview: 'Adds TTL eviction timer' },
      evidence: {
        verifiedCodeFacts: ['setInterval runs every 60s', 'Expired sessions deleted'],
        authorIntent: ['Fixes crash on long-running workers'],
        unknownsOrRisks: ['Timer precision varies under high load']
      }
    };

    const comment = generateMarkdownComment({
      prNumber: 42,
      commitSha: '998877665544',
      provider: 'OpenRouter',
      model: 'deepseek/deepseek-v4-flash',
      language: 'en',
      content: sampleContent,
      runUrl: 'https://github.com/org/repo/actions/runs/12345',
      artifactName: 'pr-explanation-html',
      pagesUrl: 'https://org.github.io/repo/pr-explains/pr-42/',
      contextMetadata: {
        retrievedFiles: [{ path: 'scripts/check.sh' }]
      }
    });

    expect(comment).toContain(COMMENT_MARKER);
    expect(comment).toContain('### PR Explainer AI');
    expect(comment).toContain('**Commit:** `9988776`');
    expect(comment).toContain('Memory leak in session manager');
    expect(comment).toContain('Verified in Code:');
    expect(comment).toContain('setInterval runs every 60s');
    expect(comment).toContain('Author-Stated Intent:');
    expect(comment).toContain('*Additional context inspected:* `scripts/check.sh`');
    expect(comment).toContain('Open Interactive Page (GitHub Pages)');
    expect(comment).toContain('Download Interactive HTML (Artifact)');
  });

  test('generates outdated warning prefix for older comment', () => {
    const original = `${COMMENT_MARKER}\n### PR Explainer AI\nPrevious content`;
    const outdated = generateOutdatedComment(original, '112233445566', 'en');

    expect(outdated).toContain('[!WARNING]');
    expect(outdated).toContain('This explanation is outdated');
    expect(outdated).toContain('1122334');
    expect(outdated).toContain('Previous content');
  });

  test('neutralizes Markdown control syntax, mentions, links, and HTML from model text', () => {
    const comment = generateMarkdownComment({
      prNumber: 42,
      commitSha: 'abcdef1234567890',
      provider: 'OpenRouter',
      model: 'test/model',
      language: 'en',
      content: {
        summary: {
          problem: '# Heading\n@maintainer https://evil.example/path [click](https://evil.example) `x` <script>alert(1)</script>'
        },
        mechanism: {
          overview: '1. ordered item\n- bullet item\n> quote'
        },
        evidence: {
          verifiedCodeFacts: ['<custom-tag> **bold** _italic_ | table']
        }
      }
    });

    // Model HTML must never survive into the comment; script contents are dropped.
    expect(comment).not.toContain('<script>');
    expect(comment).not.toContain('alert(1)');
    expect(comment).toContain('\\<custom-tag\\>');

    // Line-leading Markdown controls are escaped after newlines collapse.
    expect(comment).not.toContain('\n# Heading');
    expect(comment).toContain('\\# Heading');
    expect(comment).toContain('1\\. ordered item - bullet item \\> quote');

    // Mentions, URLs, and link syntax are defused.
    expect(comment).toContain('&#64;maintainer');
    expect(comment).toContain('https&#58;//evil.example/path');
    expect(comment).not.toContain('](https://evil.example)');
    expect(comment).toContain('\\[click\\]');
    expect(comment).toContain('\\`x\\`');
    expect(comment).toContain('\\*\\*bold\\*\\*');
  });

  test('does not link Pages when no deployment URL was confirmed', () => {
    const base = {
      prNumber: 42,
      commitSha: 'abcdef1234567890',
      model: 'test/model',
      language: 'en',
      content: { summary: { problem: 'Problem' } }
    };

    const prepared = generateMarkdownComment({ ...base, pagesPrepared: true, pagesUrl: null });
    expect(prepared).toContain('Pages output prepared locally');
    expect(prepared).not.toContain('Open Interactive Page (GitHub Pages)');

    const unsafe = generateMarkdownComment({
      ...base,
      pagesPrepared: false,
      pagesUrl: 'http://org.github.io/repo/pr-explains/pr-42/'
    });
    expect(unsafe).not.toContain('Open Interactive Page (GitHub Pages)');
    expect(unsafe).not.toContain('http://org.github.io');
  });

  test('sanitizeInlineText and safeCodeSpan bound and flatten single-line fields', () => {
    expect(sanitizeInlineText('a\nb\tc', 10)).toBe('a b c');
    expect(sanitizeInlineText('x'.repeat(50), 10)).toHaveLength(10);
    expect(safeCodeSpan('a`b\nc')).toBe('a b c');
    expect(safeCodeSpan('x'.repeat(300))).toHaveLength(200);
  });
});

describe('localized simulation and quiz labels', () => {
  const simulation = {
    enabled: true,
    title: 'Classificador de Erros HTTP',
    description: 'Teste os cenários',
    rule: '4xx não é retentável',
    scenarios: [
      {
        label: 'HTTP 400',
        outcome: { action: 'Rejeitar Imediatamente', status: 'known_rejection' },
        explanation: 'Erro de cliente.'
      },
      {
        outcome: { action: 'Retentar', status: 'rate_limited' },
        explanation: 'Aguarda Retry-After.'
      }
    ]
  };

  test('renders Portuguese kicker, scenario fallback, and outcome status', () => {
    const html = renderSimulationSection(simulation, 'pt-BR');

    expect(html).toContain('Simulação Interativa');
    expect(html).not.toContain('Interactive Simulation');
    expect(html).toContain('Cenário 2');
    expect(html).toContain('Resultado Avaliado');
    expect(html).toContain('known_rejection');
    expect(html).toContain('id="sim-outcome-status"');
  });

  test('document script updates the localized outcome status', () => {
    const html = renderEditorialDocument({
      prNumber: '8',
      prTitle: 'fix: teste localizado',
      generationDate: '10 de novembro de 2026',
      language: 'pt-BR',
      model: 'test/model',
      content: {
        summary: { problem: 'P', solution: 'S' },
        mechanism: { overview: 'M' },
        simulation
      },
      usage: { total_tokens: 1 }
    });

    expect(html).toContain("getElementById('sim-outcome-status')");
    expect(html).toContain('Simulação Interativa');
    expect(html).toContain('Cenário 2');
  });

  test('hides the status badge when a scenario has no status', () => {
    const html = renderSimulationSection(
      {
        enabled: true,
        scenarios: [{ label: 'Only', outcome: { action: 'Proceed' }, explanation: 'No status' }]
      },
      'en'
    );

    expect(html).toContain('id="sim-outcome-status" hidden');
    expect(html).toContain('Interactive Simulation');
  });

  test('localizes quiz question counts for singular and plural', () => {
    const question = {
      question: 'Pergunta?',
      options: ['A', 'B'],
      correctOptionIndex: 0,
      explanations: ['Certa', 'Errada']
    };

    expect(renderQuizHtml([question], 'pt-BR')).toContain('1 pergunta');
    expect(renderQuizHtml([question], 'pt-BR')).not.toContain('1 question');
    expect(renderQuizHtml([question, question], 'pt-BR')).toContain('2 perguntas');
    expect(renderQuizHtml([question, question], 'en')).toContain('2 questions');
  });

  test('keeps the meta CSP free of directives that browsers ignore', () => {
    const html = renderEditorialDocument({
      prNumber: '9',
      prTitle: 'fix: csp',
      generationDate: 'date',
      language: 'en',
      model: 'test/model',
      content: { summary: { problem: 'P' } },
      usage: { total_tokens: 1 }
    });

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('script-src &#39;nonce-');
    expect(html).not.toContain('frame-ancestors');
    expect(html).toContain('img-src data:');
  });
});
