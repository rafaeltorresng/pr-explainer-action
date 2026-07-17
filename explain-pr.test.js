const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_MODEL_NAME,
  FETCH_TIMEOUT_MS,
  buildUserPrompt,
  generateExplanation,
  getPrompt,
  normalizeLanguage,
  normalizeQuiz,
  parseModelContent,
  validateExplanation
} = require('./explain-pr.js');

describe('language configuration', () => {
  test('keeps the current OpenRouter default model', () => {
    expect(DEFAULT_MODEL_NAME).toBe('deepseek/deepseek-v4-flash');
  });

  test('normalizes supported language aliases', () => {
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('EN-US')).toBe('en');
    expect(normalizeLanguage('pt')).toBe('pt-BR');
    expect(normalizeLanguage('pt-br')).toBe('pt-BR');
  });

  test('loads separate prompts for English and Portuguese', () => {
    const englishPrompt = getPrompt('en');
    const portuguesePrompt = getPrompt('pt-BR');

    expect(englishPrompt).toContain('written strictly in English');
    expect(portuguesePrompt).toContain('português do Brasil');
    expect(englishPrompt).toContain('SOURCE OF TRUTH');
    expect(portuguesePrompt).toContain('FONTE DA VERDADE');
    expect(englishPrompt).toContain('BACKGROUND BREVITY');
    expect(portuguesePrompt).toContain('BREVIDADE DO CONTEXTO');
    expect(englishPrompt).toContain('diff-scoped');
    expect(portuguesePrompt).toContain('ancorado no diff');
    expect(englishPrompt).not.toContain('Deep background');
    expect(portuguesePrompt).not.toContain('Contexto profundo');
    expect(englishPrompt).toContain('at most 2 diagrams');
    expect(portuguesePrompt).toContain('no máximo 2 diagramas');
    expect(englishPrompt).not.toBe(portuguesePrompt);
  });
});

describe('user prompt construction', () => {
  test('includes the PR description section when a body is present (en)', () => {
    const prompt = buildUserPrompt({
      language: 'en',
      prTitle: 'Add caching layer',
      prNumber: '42',
      prBody: 'This PR introduces an LRU cache to cut repeated DB calls.',
      cappedDiff: 'diff --git a/x b/x'
    });

    expect(prompt).toContain('Here is the Pull Request description:');
    expect(prompt).toContain('This PR introduces an LRU cache to cut repeated DB calls.');
    expect(prompt.indexOf('description')).toBeLessThan(prompt.indexOf('diff --git'));
  });

  test('includes the PR description section when a body is present (pt-BR)', () => {
    const prompt = buildUserPrompt({
      language: 'pt-BR',
      prTitle: 'Adiciona camada de cache',
      prNumber: '42',
      prBody: 'Este PR introduz um cache LRU para reduzir chamadas repetidas ao banco.',
      cappedDiff: 'diff --git a/x b/x'
    });

    expect(prompt).toContain('Esta é a descrição do Pull Request:');
    expect(prompt).toContain('Este PR introduz um cache LRU para reduzir chamadas repetidas ao banco.');
  });

  test('omits the description section entirely when the PR has no body', () => {
    const englishPrompt = buildUserPrompt({
      language: 'en',
      prTitle: 'Add caching layer',
      prNumber: '42',
      prBody: '',
      cappedDiff: 'diff --git a/x b/x'
    });
    const portuguesePrompt = buildUserPrompt({
      language: 'pt-BR',
      prTitle: 'Adiciona camada de cache',
      prNumber: '42',
      prBody: undefined,
      cappedDiff: 'diff --git a/x b/x'
    });

    expect(englishPrompt).not.toContain('Pull Request description');
    expect(portuguesePrompt).not.toContain('descrição do Pull Request');
  });

  test('omits the description section when the PR body is only whitespace', () => {
    const prompt = buildUserPrompt({
      language: 'en',
      prTitle: 'Add caching layer',
      prNumber: '42',
      prBody: '   \n\t  ',
      cappedDiff: 'diff --git a/x b/x'
    });

    expect(prompt).not.toContain('Pull Request description');
  });
});

describe('quiz normalization', () => {
  test('redistributes correct answers away from a fixed position while keeping explanations aligned', () => {
    const sourceQuiz = Array.from({ length: 5 }, (_, index) => ({
      question: `Question ${index + 1}?`,
      options: ['A', 'B', 'C', 'D'],
      correctOptionIndex: 1,
      explanations: ['exp-A', 'exp-B', 'exp-C', 'exp-D']
    }));

    const normalizedQuiz = normalizeQuiz(sourceQuiz, 'seed:quiz');
    const positions = normalizedQuiz.map((entry) => entry.correctOptionIndex);
    const distinctPositions = new Set(positions);

    expect(normalizedQuiz).toHaveLength(5);
    expect(distinctPositions.size).toBeGreaterThan(2);
    expect(positions.every((index) => index >= 0 && index <= 3)).toBe(true);

    normalizedQuiz.forEach((entry) => {
      const explanationForCorrectAnswer = entry.explanations[entry.correctOptionIndex];
      expect(explanationForCorrectAnswer).toBe('exp-B');
    });
  });
});

describe('artifact rendering', () => {
  test('renders the Portuguese template when requested', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'pt-output.html');

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: join(process.cwd(), 'mock.json')
    });

    expect(existsSync(outputFilePath)).toBe(true);

    const html = readFileSync(outputFilePath, 'utf8');
    expect(html).toContain('Revisão Técnica Automatizada');
    expect(html).toContain('Teste seu Entendimento');
    expect(html).toContain('Pergunta 1.');
    expect(html).toContain('Selecionar');
    expect(html).toContain('Entrada / saída: $0.09 / $0.18 por 1M');
    expect(html).toContain('diagram-panel');
    expect(html).toContain('explanation-inner');
    expect(html).toContain('quiz-answered');
    expect(html).toContain('O estado anterior que este diff altera.');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('{{RATE_CHIP}}');
    expect(html).not.toContain('{{TOTAL_PRICE}}');
    expect(html).not.toContain('max-height: 300px');
  });

  test('English artifact moves cost chips to the footer and keeps section intros', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'en-output.html');

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'en',
      apiKey: 'test',
      mockResponsePath: join(process.cwd(), 'mock.json')
    });

    const html = readFileSync(outputFilePath, 'utf8');
    const footerIndex = html.indexOf('<footer');
    const costIndex = html.indexOf('Cost: $');
    expect(footerIndex).toBeGreaterThan(-1);
    expect(costIndex).toBeGreaterThan(footerIndex);
    expect(html).toContain('What this change is reacting to.');
    expect(html).toContain('How data and control move through the change.');
    expect(html).toContain('text-base font-sans flex items-center justify-between group');
  });

  test('marks cost as n/a when the OpenRouter model is overridden', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'custom-model-output.html');

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'en',
      apiKey: 'test',
      modelName: 'openai/gpt-4.1',
      mockResponsePath: join(process.cwd(), 'mock.json')
    });

    const html = readFileSync(outputFilePath, 'utf8');
    expect(html).toContain('Cost: n/a');
    expect(html).toContain('Rate: per selected OpenRouter model');
    expect(html).not.toContain('$0.09 / $0.18');
  });
});

describe('json resilience', () => {
  test('parseModelContent strips markdown fences before parsing', () => {
    const withFence = '```json\n{"background":"ok","intuition":"x","diagrams":"d","codeWalkthrough":"c","quiz":[]}\n```';
    const result = parseModelContent(withFence);
    expect(result.background).toBe('ok');
  });

  test('parseModelContent rejects truncated JSON (option A: always retry)', () => {
    // JSON truncado — chave "codeWalkthrough" cortada no meio
    const truncated = '{"background":"<p>bg</p>","intuition":"<p>int</p>","diagrams":"<div>d</div>","codeWalkthrough":"<pre>co';
    expect(() => parseModelContent(truncated)).toThrow(/truncado|parse/i);
  });

  test('parseModelContent throws on completely invalid JSON', () => {
    expect(() => parseModelContent('not json at all')).toThrow();
    expect(() => parseModelContent('')).toThrow();
  });

  test('validateExplanation throws when all essential fields are empty', () => {
    expect(() => validateExplanation({ background: '', intuition: '   ', diagrams: '', codeWalkthrough: '' })).toThrow(
      /campos essenciais vazios/i
    );
  });

  test('validateExplanation passes with at least one non-empty essential field', () => {
    // Não deve lançar — mesmo com outros campos vazios
    expect(() =>
      validateExplanation({ background: '<p>something</p>', intuition: '', diagrams: '', codeWalkthrough: '' })
    ).not.toThrow();
  });
});

describe('template injection safety', () => {
  test('PR title with $ special chars does not corrupt the template output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'dollar-output.html');

    // Títulos com $& e $$ são os padrões mais perigosos do String.replace()
    // sem o fix, $& seria substituído pelo match completo e $$ por um $ literal
    process.env.PR_TITLE = 'fix: handle $& edge case with $$discount';
    process.env.PR_NUMBER = '42';
    process.env.GITHUB_EVENT_PATH = '';

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: join(process.cwd(), 'mock.json')
    });

    const html = readFileSync(outputFilePath, 'utf8');
    // Com escapeHtml + replacer function: $& vira $&amp; no HTML (sem corrupção de template)
    expect(html).toContain('fix: handle $&amp; edge case with $$discount');
    expect(html).not.toContain('{{PR_TITLE}}');

    delete process.env.PR_TITLE;
    delete process.env.PR_NUMBER;
  });

  test('PR title with HTML special chars is escaped to prevent layout breakage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'html-escape-output.html');

    process.env.PR_TITLE = 'feat: <script>alert(1)</script> & "quotes"';
    process.env.PR_NUMBER = '99';
    process.env.GITHUB_EVENT_PATH = '';

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: join(process.cwd(), 'mock.json')
    });

    const html = readFileSync(outputFilePath, 'utf8');
    // Deve conter a versão escaped — nunca a tag <script> crua
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toContain('<script>alert(1)</script>');

    delete process.env.PR_TITLE;
    delete process.env.PR_NUMBER;
  });

  test('LLM content with $ chars does not corrupt the template output', async () => {
    const { writeFileSync: fsWrite } = require('node:fs');
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'dollar-llm-output.html');
    const mockPath = join(tempDir, 'mock-dollar.json');

    // Conteúdo da LLM contendo $& — o padrão mais perigoso
    const content = JSON.stringify({
      background: '<p>Cost is $&amp; per unit, $1 extra</p>',
      intuition: '<p>Normal</p>',
      diagrams: '<div>ok</div>',
      codeWalkthrough: '<pre>const x = 1;</pre>',
      quiz: []
    });

    fsWrite(mockPath, JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: mockPath
    });

    const html = readFileSync(outputFilePath, 'utf8');
    expect(html).toContain('$&amp; per unit, $1 extra');
  });
});
describe('fetch timeout', () => {
  test('FETCH_TIMEOUT_MS is set to 5 minutes', () => {
    expect(FETCH_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test('AbortError from fetch is converted to a readable timeout message', async () => {
    // Mocka fetch para lançar AbortError imediatamente
    const originalFetch = globalThis.fetch;
    // Mocka setTimeout/clearTimeout para que o sleep do retry não bloqueie o teste
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    globalThis.clearTimeout = () => {};

    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };

    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    try {
      await expect(
        generateExplanation({
          diffFilePath: join(process.cwd(), 'sample.patch'),
          outputFilePath: join(tempDir, 'out.html'),
          languageInput: 'en',
          apiKey: 'test-key'
        })
      ).rejects.toThrow(/timed out/i);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  }, 15000);
});

describe('quiz edge cases', () => {
  test('quiz with 0 valid questions does not crash — warns and produces empty quiz section', async () => {
    const { writeFileSync: fsWrite } = require('node:fs');
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'empty-quiz-output.html');
    const mockPath = join(tempDir, 'mock-empty-quiz.json');

    // Todas as questões têm estrutura inválida (falta correctOptionIndex)
    const content = JSON.stringify({
      background: '<p>bg</p>',
      intuition: '<p>int</p>',
      diagrams: '<div>d</div>',
      codeWalkthrough: '<pre>c</pre>',
      quiz: [
        { question: 'Q?', options: ['A', 'B'], correctOptionIndex: 0, explanations: ['e'] }, // options.length !== 4
        { question: 'Q2?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 9, explanations: ['e','e','e','e'] } // index out of range
      ]
    });

    fsWrite(mockPath, JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    // Não deve lançar — quiz vazio é um warning, não um erro fatal
    await expect(generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: mockPath
    })).resolves.toBeDefined();

    expect(existsSync(outputFilePath)).toBe(true);
  });

  test('quiz with empty array from LLM does not crash', async () => {
    const { writeFileSync: fsWrite } = require('node:fs');
    const tempDir = mkdtempSync(join(tmpdir(), 'pr-explainer-'));
    const outputFilePath = join(tempDir, 'no-quiz-output.html');
    const mockPath = join(tempDir, 'mock-no-quiz.json');

    const content = JSON.stringify({
      background: '<p>bg</p>',
      intuition: '<p>int</p>',
      diagrams: '<div>d</div>',
      codeWalkthrough: '<pre>c</pre>',
      quiz: []
    });

    fsWrite(mockPath, JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await expect(generateExplanation({
      diffFilePath: join(process.cwd(), 'sample.patch'),
      outputFilePath,
      languageInput: 'pt-BR',
      apiKey: 'test',
      mockResponsePath: mockPath
    })).resolves.toBeDefined();
  });
});

describe('output write errors', () => {
  test('writeFileSync failure throws an error with the output path in the message', async () => {
    const invalidPath = '/nonexistent-dir/deeply/nested/output.html';

    process.env.GITHUB_EVENT_PATH = join(process.cwd(), 'event.json');

    await expect(
      generateExplanation({
        diffFilePath: join(process.cwd(), 'sample.patch'),
        outputFilePath: invalidPath,
        languageInput: 'pt-BR',
        apiKey: 'test',
        mockResponsePath: join(process.cwd(), 'mock.json')
      })
    ).rejects.toThrow(invalidPath);
  });
});
