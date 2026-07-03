const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error('Erro: A variável de ambiente OPENROUTER_API_KEY não está configurada.');
  process.exit(1);
}

const MODEL_NAME = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';
const OPENROUTER_API_BASE_URL =
  process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1';

const args = process.argv.slice(2);
const diffFilePath = args[0];

let prTitle = process.env.PR_TITLE || 'Mudanças no Código';
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
    console.error('Falha ao ler o payload do evento do GitHub:', error);
  }
}

const outputFilePath =
  args[1] || join(process.cwd(), `pr-explanation-${prNumber}.html`);

function getDiffContent() {
  if (diffFilePath && existsSync(diffFilePath)) {
    console.log(`Lendo diff a partir do arquivo: ${diffFilePath}`);
    return readFileSync(diffFilePath, 'utf8');
  }

  console.log('Nenhum arquivo de diff especificado. Buscando diff do git local...');
  try {
    const { stdout, success } = Bun.spawnSync(['git', 'diff', 'origin/main...HEAD']);
    if (success && stdout) {
      const diffText = new TextDecoder().decode(stdout).trim();
      if (diffText) {
        return diffText;
      }
    }
  } catch {
    console.error('Falha ao rodar git diff origin/main...HEAD localmente.');
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
    console.error('Falha ao rodar git diff HEAD~1 localmente.');
  }

  console.error('Erro: Não foi possível obter o diff do código.');
  process.exit(1);
}

const diffContent = getDiffContent();
if (diffContent.length === 0) {
  console.error('Erro: O diff do código está vazio.');
  process.exit(1);
}

console.log(`Tamanho do diff a ser analisado: ${diffContent.length} bytes`);

const templatePath = join(__dirname, 'template.html');
if (!existsSync(templatePath)) {
  console.error(`Erro: Arquivo de template não encontrado em ${templatePath}`);
  process.exit(1);
}
let htmlTemplate = readFileSync(templatePath, 'utf8');

const systemInstruction = `Você é um Staff Software Engineer sênior no projeto SIP. Seu estilo de escrita é extremamente claro, fluído e pragmático, inspirado em Martin Kleppmann (autor de "Designing Data-Intensive Applications").

Sua tarefa é analisar o git diff de um Pull Request e gerar uma documentação de review interativa e de altíssima qualidade técnica. Você deve retornar EXCLUSIVAMENTE um objeto JSON estruturado contendo as seguintes propriedades:

1. "background": String HTML contendo uma explicação rica e detalhada sobre o contexto do sistema que está sendo modificado. Explique como a funcionalidade afetada operava anteriormente e as motivações arquiteturais por trás da mudança.
2. "intuition": String HTML detalhando o conceito e a essência da mudança de código de forma intuitiva, usando analogias simples e dados de exemplo fictícios para ilustrar a lógica.
3. "diagrams": String HTML contendo diagramas visuais estilizados usando elementos HTML/CSS (caixas com bordas, setas, flex/grid com Tailwind) para mostrar o fluxo de dados modificado ou a transição de estados. Não use diagramas ASCII, apenas blocos HTML limpos e coloridos.
4. "codeWalkthrough": String HTML com um passo a passo de alto nível sobre os arquivos modificados, agrupando-os por importância e explicando os principais blocos alterados de forma compreensível. Para trechos de código, use as tags <pre class="font-mono bg-[#0c0c0c] border border-gray-800 p-4 rounded text-xs overflow-x-auto text-purple-300 my-2"> e certifique-se de que contenham white-space: pre-wrap em seu estilo.
5. "quiz": Um array de exatamente 5 objetos. Cada objeto representa uma pergunta do quiz e deve ter o seguinte formato:
   {
     "question": "Texto da pergunta de nível médio-difícil que testa se o leitor compreendeu a essência do PR",
     "options": ["Opção 0", "Opção 1", "Opção 2", "Opção 3"],
     "correctOptionIndex": 2,
     "explanations": [
       "Explicação detalhada sobre por que a Opção 0 está correta/incorreta",
       "Explicação detalhada sobre por que a Opção 1 está correta/incorreta",
       "Explicação detalhada sobre por que a Opção 2 está correta/incorreta",
       "Explicação detalhada sobre por que a Opção 3 está correta/incorreta"
     ]
   }

Regras Cruciais:
- IDIOMA OBRIGATÓRIO: Toda a documentação gerada (background, intuition, diagrams, codeWalkthrough, perguntas, alternativas e explicações do quiz) DEVE ser escrita estritamente em português (pt-BR). Não misture termos em inglês, exceto nomes de funções, classes, arquivos ou palavras-chave de sintaxe de código que apareçam no diff.
- O retorno DEVE ser um JSON válido. Não inclua Markdown de bloco de código (\`\`\`json) na sua resposta final, apenas o JSON bruto.
- Não use emojis em lugar nenhum. A comunicação deve ser puramente profissional, séria e focada em engenharia.
- Evite explicações superficiais. Aprofunde-se em transações, concorrência, estados de banco de dados, tratamentos de erros ou layouts de interface onde aplicável no diff.
- DISTRIBUIÇÃO DAS RESPOSTAS DO QUIZ: Você DEVE variar o índice da resposta correta ("correctOptionIndex") de forma aleatória em cada uma das 5 questões (por exemplo, questão 1 com índice 2, questão 2 com índice 0, questão 3 com índice 3, etc.). NUNCA coloque a resposta correta sempre na primeira posição (índice 0) ou em uma mesma posição previsível em todas as questões.
- CORES E ACESSIBILIDADE DOS DIAGRAMAS: Os diagramas em HTML que você gerar devem utilizar o tema de modo escuro consistente. Utilize as seguintes cores do Tailwind para fundos e textos contrastantes: roxo (purple-500) para destaques de fluxo principal, azul (blue-400) para processamento/workers, verde (green-500) para fluxos corretos ou sucesso, e vermelho/laranja para descartes ou falhas. Use fundos escuros (#0f0f0f ou #0e0e0e) e texto claro em todas as caixas. NUNCA utilize texto escuro em fundo escuro, ou cores berrantes que prejudiquem a harmonia com o fundo preto (#0a0a0a) do site.`;

const cappedDiff = diffContent.substring(0, 40000);

const userPrompt = `Aqui está o título do Pull Request: "${prTitle}"
Número do PR: ${prNumber}

Aqui está o git diff do PR a ser analisado:
\`\`\`diff
${cappedDiff}
\`\`\``;

console.log(`Iniciando requisição para o OpenRouter (${MODEL_NAME})...`);

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
      throw new Error(`Erro na API do OpenRouter: Status ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (!data || !data.choices || data.choices.length === 0 || !data.choices[0].message) {
      console.error('Resposta inválida da API do OpenRouter:', JSON.stringify(data));
      throw new Error('A API do OpenRouter retornou uma resposta sem choices ou malformada.');
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
      console.error('Erro ao analisar JSON retornado pelo OpenRouter. Conteúdo bruto:');
      console.error(contentText);
      throw parseError;
    }

    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return { explanation, usage };
  } catch (error) {
    console.error('Falha ao obter resposta estruturada do OpenRouter:', error);
    process.exit(1);
  }
}

const { explanation, usage } = await callOpenRouter();

console.log(
  `Resposta da IA obtida com sucesso. (Prompt tokens: ${usage.prompt_tokens} | Completion tokens: ${usage.completion_tokens} | Total: ${usage.total_tokens})`
);
console.log('Formatando Quiz...');

let quizHtml = '';
if (explanation.quiz && Array.isArray(explanation.quiz)) {
  explanation.quiz.forEach((question, questionIndex) => {
    if (
      !question.question ||
      !Array.isArray(question.options) ||
      typeof question.correctOptionIndex !== 'number' ||
      !Array.isArray(question.explanations)
    ) {
      console.warn(`Questão do quiz inválida ou malformada no índice ${questionIndex}. Pulando.`);
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
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity text-purple-400 text-xs font-mono">Selecionar</span>
                </button>
                <div id="ex-q${questionIndex}-o${optionIndex}" class="explanation-box p-4 rounded-lg bg-gray-900/40 border border-gray-800 text-xs text-gray-400 space-y-1">
                    <p class="font-bold ${isCorrect ? 'text-green-400' : 'text-red-400'}">
                        ${isCorrect ? '✓ Correto' : '✗ Incorreto'}
                    </p>
                    <p>${question.explanations[optionIndex] || ''}</p>
                </div>
            </div>`;
    });

    quizHtml += `
        <div class="p-6 rounded-xl border border-gray-850 bg-[#0e0e0e]/20 space-y-4">
            <div class="flex items-start justify-between gap-4">
                <h3 class="font-serif text-lg font-bold text-white leading-snug">
                    <span class="font-mono text-purple-400 text-sm">Questão ${questionIndex + 1}.</span> ${question.question}
                </h3>
                <button id="reset-q${questionIndex}" onclick="resetQuestion(${questionIndex})" class="text-xs text-gray-500 hover:text-purple-400 font-mono transition-colors hidden flex items-center gap-1 select-none pt-1">
                    <span>Refazer</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-2.5 h-2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
            </div>
            <div class="grid grid-cols-1 gap-4">
                ${optionsHtml}
            </div>
        </div>`;
  });
}

const generationDate = new Date().toLocaleDateString('pt-BR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

console.log('Injetando conteúdo no HTML do template...');

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
  console.log(`\n✓ Sucesso! Explicação do PR gerada em: ${outputFilePath}`);
} catch (error) {
  console.error('Falha ao gravar arquivo HTML de saída:', error);
  process.exit(1);
}
