const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY is not configured.');
  process.exit(1);
}

const MODEL_NAME = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
const OPENROUTER_API_BASE_URL =
  process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1';

const args = process.argv.slice(2);
const diffFilePath = args[0];

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

const outputFilePath =
  args[1] || join(process.cwd(), `pr-explanation-${prNumber}.html`);

function getDiffContent() {
  if (diffFilePath && existsSync(diffFilePath)) {
    console.log(`Reading diff from file: ${diffFilePath}`);
    return readFileSync(diffFilePath, 'utf8');
  }

  console.log('No diff file provided. Falling back to local git diff...');
  try {
    const { stdout, success } = Bun.spawnSync(['git', 'diff', 'origin/main...HEAD']);
    if (success && stdout) {
      const diffText = new TextDecoder().decode(stdout).trim();
      if (diffText) {
        return diffText;
      }
    }
  } catch {
    console.error('Failed to run local git diff origin/main...HEAD.');
  }

  try {
    const { stdout, success } = Bun.spawnSync(['git', 'diff', 'HEAD~1']);
    if (success && stdout) {
      const diffText = new TextDecoder().decode(stdout).trim();
      if (diffText) {
        return diffText;
      }
    }
  } catch {
    console.error('Failed to run local git diff HEAD~1.');
  }

  console.error('Error: Unable to obtain a code diff.');
  process.exit(1);
}

const diffContent = getDiffContent();
if (diffContent.length === 0) {
  console.error('Error: The code diff is empty.');
  process.exit(1);
}

console.log(`Diff size to analyze: ${diffContent.length} bytes`);

const templatePath = join(__dirname, 'template.html');
if (!existsSync(templatePath)) {
  console.error(`Error: Template file not found at ${templatePath}`);
  process.exit(1);
}
let htmlTemplate = readFileSync(templatePath, 'utf8');

const systemInstruction = `You are a senior Staff Software Engineer. Your writing style is clear, fluid, and pragmatic, inspired by Martin Kleppmann.

Your task is to analyze a Pull Request git diff and generate a high-quality interactive review document. You must return ONLY a structured JSON object with these properties:

1. "background": HTML string with a rich explanation of the existing system context relevant to the change. Explain how the affected functionality worked previously and the architectural motivations behind the change.
2. "intuition": HTML string explaining the essence of the code change in an intuitive way, using simple analogies and small fictional examples.
3. "diagrams": HTML string containing styled HTML/CSS diagrams using boxes, arrows, flex, and grid layouts to show the changed data flow or state transition. Do not use ASCII diagrams.
4. "codeWalkthrough": HTML string with a high-level walkthrough of the modified files, grouped by importance and explained in a way that is easy to follow. For code snippets, use <pre class="font-mono bg-[#0c0c0c] border border-gray-800 p-4 rounded text-xs overflow-x-auto text-purple-300 my-2"> and ensure white-space: pre-wrap applies.
5. "quiz": an array of exactly 5 objects. Each quiz object must follow this structure:
   {
     "question": "A medium-to-hard question that tests whether the reader understood the essence of the PR",
     "options": ["Option 0", "Option 1", "Option 2", "Option 3"],
     "correctOptionIndex": 2,
     "explanations": [
       "Detailed explanation of why Option 0 is correct or incorrect",
       "Detailed explanation of why Option 1 is correct or incorrect",
       "Detailed explanation of why Option 2 is correct or incorrect",
       "Detailed explanation of why Option 3 is correct or incorrect"
     ]
   }

Critical rules:
- REQUIRED LANGUAGE: All generated content must be written strictly in English.
- The response MUST be valid JSON. Do not wrap it in Markdown code fences.
- Do not use emojis anywhere.
- Avoid shallow explanations. Go deep on transactions, concurrency, database states, error handling, or UI behavior when relevant to the diff.
- QUIZ ANSWER DISTRIBUTION: Vary the correctOptionIndex across the 5 questions. Do not place the correct answer in the same position every time.
- DIAGRAM COLORS AND ACCESSIBILITY: Diagrams must use a consistent dark theme. Prefer Tailwind-compatible colors such as purple for primary flow, blue for processing or workers, green for success, and red or orange for failure or discard paths. Use dark backgrounds (#0f0f0f or #0e0e0e) with light text throughout.`;

const cappedDiff = diffContent.substring(0, 40000);

const userPrompt = `Here is the Pull Request title: "${prTitle}"
PR number: ${prNumber}

Here is the git diff to analyze:
\`\`\`diff
${cappedDiff}
\`\`\``;

console.log(`Starting OpenRouter request (${MODEL_NAME})...`);

async function callOpenRouter() {
  const mockResponsePath = process.env.OPENROUTER_MOCK_RESPONSE_PATH;
  if (mockResponsePath) {
    const mockData = JSON.parse(readFileSync(mockResponsePath, 'utf8'));
    return {
      explanation: JSON.parse(mockData.choices[0].message.content),
      usage: mockData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  try {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/SantanaInteligencia/app',
        'X-Title': 'SIP PR Explainer'
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: status ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (!data || !data.choices || data.choices.length === 0 || !data.choices[0].message) {
      console.error('Invalid OpenRouter API response:', JSON.stringify(data));
      throw new Error('OpenRouter returned a malformed response or no choices.');
    }

    let contentText = data.choices[0].message.content.trim();
    if (contentText.startsWith('```json')) {
      contentText = contentText.substring(7);
    } else if (contentText.startsWith('```')) {
      contentText = contentText.substring(3);
    }
    if (contentText.endsWith('```')) {
      contentText = contentText.substring(0, contentText.length - 3);
    }
    contentText = contentText.trim();

    let explanation;
    try {
      explanation = JSON.parse(contentText);
    } catch (parseError) {
      console.error('Failed to parse JSON returned by OpenRouter. Raw content:');
      console.error(contentText);
      throw parseError;
    }

    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return { explanation, usage };
  } catch (error) {
    console.error('Failed to obtain a structured response from OpenRouter:', error);
    process.exit(1);
  }
}

const { explanation, usage } = await callOpenRouter();

console.log(
  `AI response received successfully. (Prompt tokens: ${usage.prompt_tokens} | Completion tokens: ${usage.completion_tokens} | Total: ${usage.total_tokens})`
);
console.log('Formatting quiz...');

let quizHtml = '';
if (explanation.quiz && Array.isArray(explanation.quiz)) {
  explanation.quiz.forEach((question, questionIndex) => {
    if (
      !question.question ||
      !Array.isArray(question.options) ||
      typeof question.correctOptionIndex !== 'number' ||
      !Array.isArray(question.explanations)
    ) {
      console.warn(`Invalid or malformed quiz question at index ${questionIndex}. Skipping.`);
      return;
    }

    let optionsHtml = '';
    question.options.forEach((option, optionIndex) => {
      const isCorrect = optionIndex === question.correctOptionIndex;
      optionsHtml += `
            <div class="space-y-2">
                <button id="btn-q${questionIndex}-o${optionIndex}" 
                        data-correct="${isCorrect}"
                        onclick="selectOption(${questionIndex}, ${optionIndex}, ${isCorrect}, 'ex-q${questionIndex}-o${optionIndex}')"
                        class="option-btn text-left p-4 w-full rounded-lg border border-gray-800 bg-[#0f0f0f] hover:border-purple-500 text-sm font-sans flex items-center justify-between group">
                    <span>${option}</span>
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity text-purple-400 text-xs font-mono">Select</span>
                </button>
                <div id="ex-q${questionIndex}-o${optionIndex}" class="explanation-box p-4 rounded-lg bg-gray-900/40 border border-gray-800 text-xs text-gray-400 space-y-1">
                    <p class="font-bold ${isCorrect ? 'text-green-400' : 'text-red-400'}">
                        ${isCorrect ? '✓ Correct' : '✗ Incorrect'}
                    </p>
                    <p>${question.explanations[optionIndex] || ''}</p>
                </div>
            </div>`;
    });

    quizHtml += `
        <div class="p-6 rounded-xl border border-gray-850 bg-[#0e0e0e]/20 space-y-4">
            <div class="flex items-start justify-between gap-4">
                <h3 class="font-serif text-lg font-bold text-white leading-snug">
                    <span class="font-mono text-purple-400 text-sm">Question ${questionIndex + 1}.</span> ${question.question}
                </h3>
                <button id="reset-q${questionIndex}" onclick="resetQuestion(${questionIndex})" class="text-xs text-gray-500 hover:text-purple-400 font-mono transition-colors hidden flex items-center gap-1 select-none pt-1">
                    <span>Reset</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-2.5 h-2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
            </div>
            <div class="grid grid-cols-1 gap-4">
                ${optionsHtml}
            </div>
        </div>`;
  });
}

const generationDate = new Date().toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

console.log('Injecting content into the HTML template...');

const inputCost = (usage.prompt_tokens / 1000000) * 0.089;
const outputCost = (usage.completion_tokens / 1000000) * 0.18;
const totalCost = inputCost + outputCost;
const formattedPrice = totalCost.toFixed(6);

htmlTemplate = htmlTemplate
  .replace(/{{PR_NUMBER}}/g, prNumber)
  .replace(/{{PR_TITLE}}/g, prTitle)
  .replace(/{{GENERATION_DATE}}/g, generationDate)
  .replace(/{{TOTAL_PRICE}}/g, formattedPrice)
  .replace(/{{BACKGROUND_CONTENT}}/g, explanation.background || '')
  .replace(/{{INTUITION_CONTENT}}/g, explanation.intuition || '')
  .replace(/{{DIAGRAMS_CONTENT}}/g, explanation.diagrams || '')
  .replace(/{{CODE_CONTENT}}/g, explanation.codeWalkthrough || '')
  .replace(/{{QUIZ_CONTENT}}/g, quizHtml);

try {
  writeFileSync(outputFilePath, htmlTemplate, 'utf8');
  console.log(`\nSuccess. PR explanation generated at: ${outputFilePath}`);
} catch (error) {
  console.error('Failed to write output HTML file:', error);
  process.exit(1);
}
