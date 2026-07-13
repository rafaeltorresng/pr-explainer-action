const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_MODEL_NAME,
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
    expect(englishPrompt).not.toBe(portuguesePrompt);
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
    // O título LITERAL deve estar no HTML — não o placeholder {{PR_TITLE}} expandido erroneamente
    // Se o fix não existisse, $& viraria o match (e.g. "{{PR_TITLE}}") e $$ viraria "$"
    expect(html).toContain('fix: handle $& edge case with $$discount');
    expect(html).not.toContain('{{PR_TITLE}}');

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
