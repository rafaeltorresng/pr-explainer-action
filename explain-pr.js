const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const DEFAULT_MODEL_NAME = 'deepseek/deepseek-v4-flash';
const DEFAULT_OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_LANGUAGE = 'en';

const LANGUAGE_CONFIG = {
  en: {
    promptFile: 'prompt.en.txt',
    templateFile: 'template.html',
    dateLocale: 'en-US',
    quiz: {
      select: 'Select',
      correct: 'Correct',
      incorrect: 'Incorrect',
      questionLabel: 'Question',
      reset: 'Reset'
    }
  },
  'pt-BR': {
    promptFile: 'prompt.pt-BR.txt',
    templateFile: 'template.pt-BR.html',
    dateLocale: 'pt-BR',
    quiz: {
      select: 'Selecionar',
      correct: 'Correta',
      incorrect: 'Incorreta',
      questionLabel: 'Pergunta',
      reset: 'Reiniciar'
    }
  }
};

function normalizeLanguage(input) {
  if (!input) return DEFAULT_LANGUAGE;

  const normalized = String(input).trim().toLowerCase();
  if (normalized === 'en' || normalized === 'en-us') return 'en';
  if (normalized === 'pt' || normalized === 'pt-br' || normalized === 'pt_br') return 'pt-BR';

  const supported = Object.keys(LANGUAGE_CONFIG).join(', ');
  throw new Error(`Unsupported language "${input}". Supported values: ${supported}`);
}

function readEventContext() {
  let prTitle = process.env.PR_TITLE || 'Code Changes';
  let prNumber = process.env.PR_NUMBER || '0';

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const eventData = JSON.parse(readFileSync(eventPath, 'utf8'));
      if (eventData.pull_request) {
        prTitle = eventData.pull_request.title || prTitle;
        prNumber = String(eventData.pull_request.number || prNumber);
      }
    } catch (error) {
      console.error('Failed to read the GitHub event payload:', error);
    }
  }

  return { prTitle, prNumber };
}

function getDiffContent(diffFilePath) {
  if (diffFilePath && existsSync(diffFilePath)) {
    console.log(`Reading diff from file: ${diffFilePath}`);
    return readFileSync(diffFilePath, 'utf8');
  }

  console.log('No diff file provided. Falling back to local git diff...');
  try {
    const { stdout, success } = Bun.spawnSync(['git', 'diff', 'origin/main...HEAD']);
    if (success && stdout) {
      const diffText = new TextDecoder().decode(stdout).trim();
      if (diffText) return diffText;
    }
  } catch {
    console.error('Failed to run local git diff origin/main...HEAD.');
  }

  try {
    const { stdout, success } = Bun.spawnSync(['git', 'diff', 'HEAD~1']);
    if (success && stdout) {
      const diffText = new TextDecoder().decode(stdout).trim();
      if (diffText) return diffText;
    }
  } catch {
    console.error('Failed to run local git diff HEAD~1.');
  }

  throw new Error('Unable to obtain a code diff.');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function createSeedFromString(value) {
  let hash = 2166136261;

  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createSeededRng(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray(items, rng) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]];
  }

  return copy;
}

function buildTargetCorrectIndexes(questionCount, seedString) {
  const baseIndexes = [0, 1, 2, 3];
  const rng = createSeededRng(createSeedFromString(`${seedString}:targets`));
  const targets = [];

  while (targets.length < questionCount) {
    const nextBatch = shuffleArray(baseIndexes, rng);
    for (const index of nextBatch) {
      targets.push(index);
      if (targets.length === questionCount) break;
    }
  }

  return targets;
}

function normalizeQuizQuestion(rawQuestion, questionIndex, targetCorrectIndex, seedString) {
  if (
    !rawQuestion ||
    typeof rawQuestion.question !== 'string' ||
    !Array.isArray(rawQuestion.options) ||
    !Array.isArray(rawQuestion.explanations) ||
    rawQuestion.options.length !== 4 ||
    rawQuestion.explanations.length !== 4 ||
    !Number.isInteger(rawQuestion.correctOptionIndex) ||
    rawQuestion.correctOptionIndex < 0 ||
    rawQuestion.correctOptionIndex > 3
  ) {
    console.warn(`Invalid or malformed quiz question at index ${questionIndex}. Skipping.`);
    return null;
  }

  const options = rawQuestion.options.map((option, optionIndex) => ({
    option: String(option),
    explanation: String(rawQuestion.explanations[optionIndex] || ''),
    isCorrect: optionIndex === rawQuestion.correctOptionIndex
  }));

  const rng = createSeededRng(createSeedFromString(`${seedString}:question:${questionIndex}`));
  const shuffledOptions = shuffleArray(options, rng);
  const currentCorrectIndex = shuffledOptions.findIndex((entry) => entry.isCorrect);

  if (currentCorrectIndex === -1) {
    console.warn(`Question at index ${questionIndex} has no correct option after normalization. Skipping.`);
    return null;
  }

  if (currentCorrectIndex !== targetCorrectIndex) {
    [shuffledOptions[currentCorrectIndex], shuffledOptions[targetCorrectIndex]] = [
      shuffledOptions[targetCorrectIndex],
      shuffledOptions[currentCorrectIndex]
    ];
  }

  return {
    question: rawQuestion.question.trim(),
    options: shuffledOptions.map((entry) => entry.option),
    explanations: shuffledOptions.map((entry) => entry.explanation),
    correctOptionIndex: targetCorrectIndex
  };
}

function normalizeQuiz(quiz, seedString) {
  if (!Array.isArray(quiz)) return [];

  const targetIndexes = buildTargetCorrectIndexes(quiz.length, seedString);
  const normalizedQuiz = [];

  quiz.forEach((question, questionIndex) => {
    const normalizedQuestion = normalizeQuizQuestion(
      question,
      questionIndex,
      targetIndexes[questionIndex],
      seedString
    );

    if (normalizedQuestion) normalizedQuiz.push(normalizedQuestion);
  });

  return normalizedQuiz.slice(0, 5);
}

function getTemplatePath(language) {
  const templatePath = join(__dirname, LANGUAGE_CONFIG[language].templateFile);
  if (!existsSync(templatePath)) {
    throw new Error(`Template file not found at ${templatePath}`);
  }

  return templatePath;
}

function getPrompt(language) {
  const promptPath = join(__dirname, LANGUAGE_CONFIG[language].promptFile);
  if (!existsSync(promptPath)) {
    throw new Error(`Prompt file not found at ${promptPath}`);
  }

  return readFileSync(promptPath, 'utf8').trim();
}

function getGenerationDate(language) {
  return new Date().toLocaleDateString(LANGUAGE_CONFIG[language].dateLocale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildUserPrompt({ language, prTitle, prNumber, cappedDiff }) {
  if (language === 'pt-BR') {
    return `Este é o título do Pull Request: "${prTitle}"
Número do PR: ${prNumber}

Este é o git diff a ser analisado:
\`\`\`diff
${cappedDiff}
\`\`\``;
  }

  return `Here is the Pull Request title: "${prTitle}"
PR number: ${prNumber}

Here is the git diff to analyze:
\`\`\`diff
${cappedDiff}
\`\`\``;
}

function renderQuizHtml(quiz, language) {
  const labels = LANGUAGE_CONFIG[language].quiz;
  let quizHtml = '';

  quiz.forEach((question, questionIndex) => {
    let optionsHtml = '';

    question.options.forEach((option, optionIndex) => {
      const isCorrect = optionIndex === question.correctOptionIndex;
      const statusLabel = isCorrect ? labels.correct : labels.incorrect;

      optionsHtml += `
            <div class="space-y-2">
                <button id="btn-q${questionIndex}-o${optionIndex}"
                        data-correct="${isCorrect}"
                        onclick="selectOption(${questionIndex}, ${optionIndex}, ${isCorrect}, 'ex-q${questionIndex}-o${optionIndex}')"
                        class="option-btn text-left p-4 w-full rounded-lg border border-gray-800 bg-[#0f0f0f] hover:border-purple-500 text-sm font-sans flex items-center justify-between group">
                    <span>${escapeHtml(option)}</span>
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity text-purple-400 text-xs font-mono">${labels.select}</span>
                </button>
                <div id="ex-q${questionIndex}-o${optionIndex}" class="explanation-box p-4 rounded-lg bg-gray-900/40 border border-gray-800 text-xs text-gray-400 space-y-1">
                    <p class="font-bold ${isCorrect ? 'text-green-400' : 'text-red-400'}">
                        ${isCorrect ? '✓' : '✗'} ${statusLabel}
                    </p>
                    <p>${escapeHtml(question.explanations[optionIndex] || '')}</p>
                </div>
            </div>`;
    });

    quizHtml += `
        <div class="p-6 rounded-xl border border-gray-850 bg-[#0e0e0e]/20 space-y-4">
            <div class="flex items-start justify-between gap-4">
                <h3 class="font-serif text-lg font-bold text-white leading-snug">
                    <span class="font-mono text-purple-400 text-sm">${labels.questionLabel} ${questionIndex + 1}.</span> ${escapeHtml(question.question)}
                </h3>
                <button id="reset-q${questionIndex}" onclick="resetQuestion(${questionIndex})" class="text-xs text-gray-500 hover:text-purple-400 font-mono transition-colors hidden flex items-center gap-1 select-none pt-1">
                    <span>${labels.reset}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-2.5 h-2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
            </div>
            <div class="grid grid-cols-1 gap-4">
                ${optionsHtml}
            </div>
        </div>`;
  });

  return quizHtml;
}

function stripMarkdownFences(text) {
  let result = text;

  if (result.startsWith('```json')) {
    result = result.substring(7);
  } else if (result.startsWith('```')) {
    result = result.substring(3);
  }

  if (result.endsWith('```')) {
    result = result.substring(0, result.length - 3);
  }

  return result.trim();
}

/**
 * Tenta reparar um JSON truncado fechando chaves/colchetes/strings abertas.
 * Estratégia conservadora: se não encontrar um '{' inicial, retorna null.
 * Se o repair também falhar no parse, retorna null.
 */
function repairTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let json = text.substring(start);

  // Fechar string aberta se necessário (paridade de aspas na última linha)
  const lastNewline = json.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? json : json.substring(lastNewline);
  const quoteCount = (lastLine.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    json += '"';
  }

  // Contar chaves e colchetes abertos e fechá-los
  const stack = [];
  let inString = false;
  let escape = false;

  for (const char of json) {
    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') stack.pop();
  }

  // Fechar em ordem reversa
  while (stack.length > 0) {
    const open = stack.pop();
    json += open === '{' ? '}' : ']';
  }

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseModelContent(rawContent) {
  const contentText = stripMarkdownFences(String(rawContent || ''));

  // Tentativa 1: parse direto
  try {
    return JSON.parse(contentText);
  } catch (firstError) {
    console.warn(`JSON parse direto falhou: ${firstError.message}. Tentando repair...`);
    console.warn(`Raw response (primeiros 500 chars): ${contentText.substring(0, 500)}`);
  }

  // Tentativa 2: repair de truncamento
  const repaired = repairTruncatedJson(contentText);
  if (repaired !== null) {
    console.warn('JSON repair bem-sucedido, mas resposta estava truncada. Será tratado como falha para retry.');
    // Intencionalmente lançamos erro mesmo com repair: conteúdo parcial não é aceitável
    throw new Error('JSON estava truncado — repair possível mas conteúdo parcial rejeitado para garantir qualidade.');
  }

  throw new Error('Failed to parse JSON — resposta da LLM é inválida e não reparável.');
}

/**
 * Valida que os campos essenciais do explanation não estão todos vazios.
 * Campos vazios indicam que o modelo retornou JSON válido mas sem conteúdo útil.
 */
function validateExplanation(explanation) {
  const essentialFields = ['background', 'intuition', 'diagrams', 'codeWalkthrough'];
  const nonEmptyFields = essentialFields.filter(
    (field) => explanation[field] && String(explanation[field]).trim().length > 0
  );

  if (nonEmptyFields.length === 0) {
    throw new Error('Explanation retornada pela LLM tem todos os campos essenciais vazios.');
  }

  const emptyFields = essentialFields.filter((f) => !nonEmptyFields.includes(f));
  if (emptyFields.length > 0) {
    console.warn(`Campos vazios na explanation: ${emptyFields.join(', ')}. Continuando com conteúdo parcial.`);
  }
}

const MAX_RETRIES = 2; // Total de tentativas = 1 inicial + 2 retries
const RETRY_BASE_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos por tentativa

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenRouter({
  apiKey,
  apiBaseUrl,
  modelName,
  systemInstruction,
  userPrompt,
  mockResponsePath
}) {
  if (mockResponsePath) {
    const mockData = JSON.parse(readFileSync(mockResponsePath, 'utf8'));
    const explanation = parseModelContent(mockData.choices[0].message.content);
    validateExplanation(explanation);
    return {
      explanation,
      usage: mockData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2); // 2s, 4s
      console.warn(`Tentativa ${attempt}/${MAX_RETRIES + 1} após ${delayMs}ms...`);
      await sleep(delayMs);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(`${apiBaseUrl}/chat/completions`, {
          signal: controller.signal,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/rafaeltorresng/pr-explainer-action',
            'X-Title': 'PR Explainer AI'
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: systemInstruction },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
          })
        });
      } catch (fetchError) {
        if (fetchError.name === 'AbortError') {
          throw new Error(`OpenRouter request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
        }
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: status ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      if (!data || !data.choices || data.choices.length === 0 || !data.choices[0].message) {
        console.error('Invalid OpenRouter API response:', JSON.stringify(data));
        throw new Error('OpenRouter returned a malformed response or no choices.');
      }

      const explanation = parseModelContent(data.choices[0].message.content);
      validateExplanation(explanation);

      if (attempt > 1) {
        console.log(`Sucesso na tentativa ${attempt}.`);
      }

      return {
        explanation,
        usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    } catch (error) {
      lastError = error;
      console.warn(`Tentativa ${attempt} falhou: ${error.message}`);

      if (attempt === MAX_RETRIES + 1) {
        console.error(`Todas as ${MAX_RETRIES + 1} tentativas falharam.`);
      }
    }
  }

  throw lastError;
}

async function generateExplanation({
  diffFilePath,
  outputFilePath,
  languageInput,
  apiKey,
  modelName = DEFAULT_MODEL_NAME,
  apiBaseUrl = DEFAULT_OPENROUTER_API_BASE_URL,
  mockResponsePath
}) {
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const language = normalizeLanguage(languageInput);
  const { prTitle, prNumber } = readEventContext();
  const diffContent = getDiffContent(diffFilePath);

  if (diffContent.length === 0) {
    throw new Error('The code diff is empty.');
  }

  console.log(`Diff size to analyze: ${diffContent.length} bytes`);

  const templatePath = getTemplatePath(language);
  let htmlTemplate = readFileSync(templatePath, 'utf8');
  const systemInstruction = getPrompt(language);
  const cappedDiff = diffContent.substring(0, 40000);
  const userPrompt = buildUserPrompt({ language, prTitle, prNumber, cappedDiff });

  console.log(`Starting OpenRouter request (${modelName}) with language ${language}...`);

  const { explanation, usage } = await callOpenRouter({
    apiKey,
    apiBaseUrl,
    modelName,
    systemInstruction,
    userPrompt,
    mockResponsePath
  });

  console.log(
    `AI response received successfully. (Prompt tokens: ${usage.prompt_tokens} | Completion tokens: ${usage.completion_tokens} | Total: ${usage.total_tokens})`
  );
  console.log('Formatting quiz...');

  const normalizedQuiz = normalizeQuiz(explanation.quiz, `${prNumber}:${prTitle}:${language}`);

  if (normalizedQuiz.length === 0) {
    console.warn(
      'Quiz returned 0 valid questions after normalization. ' +
      `Raw quiz had ${Array.isArray(explanation.quiz) ? explanation.quiz.length : 'no'} entries. ` +
      'The quiz section will be empty in the output.'
    );
  }

  const quizHtml = renderQuizHtml(normalizedQuiz, language);
  const generationDate = getGenerationDate(language);

  console.log('Injecting content into the HTML template...');

  // OpenRouter list price for the default DeepSeek V4 Flash model.
  // When users override openrouter_model, do not invent a dollar estimate.
  const isDefaultModel = modelName === DEFAULT_MODEL_NAME;
  const inputRatePerMillion = 0.09;
  const outputRatePerMillion = 0.18;
  const formattedPrice = isDefaultModel
    ? `$${(
        (usage.prompt_tokens / 1000000) * inputRatePerMillion +
        (usage.completion_tokens / 1000000) * outputRatePerMillion
      ).toFixed(6)}`
    : 'n/a';
  const rateChip = isDefaultModel
    ? (language === 'pt-BR'
      ? `Entrada / saída: $${inputRatePerMillion} / $${outputRatePerMillion} por 1M`
      : `Input / Output: $${inputRatePerMillion} / $${outputRatePerMillion} per 1M`)
    : (language === 'pt-BR'
      ? 'Tarifa: conforme o modelo escolhido no OpenRouter'
      : 'Rate: per selected OpenRouter model');

  const background = explanation.background || '';
  const intuition = explanation.intuition || '';
  const diagrams = explanation.diagrams || '';
  const codeWalkthrough = explanation.codeWalkthrough || '';

  // Use replacer functions to prevent String.replace() from interpreting
  // special patterns like $&, $1, $$ in the replacement value.
  // prTitle is HTML-escaped to prevent layout breakage or XSS from titles
  // containing <, >, &, or quotes.
  htmlTemplate = htmlTemplate
    .replace(/{{PR_NUMBER}}/g, () => prNumber)
    .replace(/{{PR_TITLE}}/g, () => escapeHtml(prTitle))
    .replace(/{{GENERATION_DATE}}/g, () => generationDate)
    .replace(/{{TOTAL_PRICE}}/g, () => formattedPrice)
    .replace(/{{RATE_CHIP}}/g, () => rateChip)
    .replace(/{{BACKGROUND_CONTENT}}/g, () => background)
    .replace(/{{INTUITION_CONTENT}}/g, () => intuition)
    .replace(/{{DIAGRAMS_CONTENT}}/g, () => diagrams)
    .replace(/{{CODE_CONTENT}}/g, () => codeWalkthrough)
    .replace(/{{QUIZ_CONTENT}}/g, () => quizHtml);

  try {
    writeFileSync(outputFilePath, htmlTemplate, 'utf8');
  } catch (writeError) {
    throw new Error(
      `Failed to write output file at "${outputFilePath}" ` +
      `(content size: ${htmlTemplate.length} bytes): ${writeError.message}`
    );
  }

  console.log(`\nSuccess. PR explanation generated at: ${outputFilePath}`);

  return {
    language,
    prNumber,
    prTitle,
    outputFilePath,
    quiz: normalizedQuiz
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const diffFilePath = args[0];
    const { prNumber } = readEventContext();
    const outputFilePath = args[1] || join(process.cwd(), `pr-explanation-${prNumber}.html`);

    await generateExplanation({
      diffFilePath,
      outputFilePath,
      languageInput: process.env.EXPLAINER_LANGUAGE || process.env.INPUT_LANGUAGE || DEFAULT_LANGUAGE,
      apiKey: process.env.OPENROUTER_API_KEY,
      modelName: process.env.OPENROUTER_MODEL || DEFAULT_MODEL_NAME,
      apiBaseUrl: process.env.OPENROUTER_API_BASE_URL || DEFAULT_OPENROUTER_API_BASE_URL,
      mockResponsePath: process.env.OPENROUTER_MOCK_RESPONSE_PATH
    });
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL_NAME,
  FETCH_TIMEOUT_MS,
  LANGUAGE_CONFIG,
  buildTargetCorrectIndexes,
  generateExplanation,
  getPrompt,
  normalizeLanguage,
  normalizeQuiz,
  parseModelContent,
  renderQuizHtml,
  validateExplanation
};
