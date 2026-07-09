const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_MODEL_NAME,
  generateExplanation,
  getPrompt,
  normalizeLanguage,
  normalizeQuiz
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
