const { randomBytes } = require('node:crypto');
const { escapeHtml } = require('../content/parser');

const I18N = {
  en: {
    pageTitle: 'PR Explanation',
    automatedReview: 'Automated Technical Review',
    overviewHeading: 'Overview & Context',
    overviewSubtitle: 'What this change is reacting to.',
    mechanismHeading: 'Core Mechanism',
    mechanismSubtitle: 'How data and control move through the change.',
    evidenceHeading: 'Evidence & Verified Facts',
    verifiedCode: 'Verified in Code / Tests',
    authorIntent: 'Author Stated Intent',
    unverifiedUnknowns: 'Uncertainties & External Assumptions',
    walkthroughHeading: 'Behavioral Walkthrough',
    simulationHeading: 'Interactive Scenario Explorer',
    simulationSubtitle: 'Test how inputs are classified and what actions the code triggers.',
    simulationRuleLabel: 'Governing Rule',
    simulationResultLabel: 'Evaluated Outcome',
    diagramsHeading: 'Data Flow & State Transitions',
    limitationsHeading: 'Limitations & Unknowns',
    quizHeading: 'Test Your Understanding',
    quizQuestionLabel: 'Question',
    quizScoreLabel: 'Score',
    quizReset: 'Reset',
    quizSelect: 'Select',
    quizCorrect: 'Correct',
    quizIncorrect: 'Incorrect',
    quizNoQuestions: 'No quiz is required for this concise change.',
    contextRetrievedBadge: 'Context Enriched',
    diffTruncatedBadge: 'Diff Truncated',
    costLabel: 'Cost',
    tokensLabel: 'Tokens',
    modelLabel: 'Model',
    commitLabel: 'Commit',
    themeToggle: 'Toggle Theme',
    generationLabel: 'Generated',
    limitationsEmpty: 'No additional limitations were reported.',
    legacyDiagramNote: 'Legacy diagram text (escaped)',
    legacyCodeNote: 'Legacy walkthrough text (escaped)',
    scenarios: 'scenarios'
  },
  'pt-BR': {
    pageTitle: 'Explicação do PR',
    automatedReview: 'Revisão Técnica Automatizada',
    overviewHeading: 'Visão Geral & Contexto',
    overviewSubtitle: 'A que esta mudança reage.',
    mechanismHeading: 'Mecanismo Central',
    mechanismSubtitle: 'Como dados e controle percorrem a mudança.',
    evidenceHeading: 'Evidências & Fatos Verificados',
    verifiedCode: 'Verificado em Código / Testes',
    authorIntent: 'Intenção Declarada pelo Autor',
    unverifiedUnknowns: 'Incertezas & Premissas Externas',
    walkthroughHeading: 'Walkthrough de Comportamento',
    simulationHeading: 'Explorador Interativo de Cenários',
    simulationSubtitle: 'Teste como as entradas são classificadas e quais ações o código executa.',
    simulationRuleLabel: 'Regra Aplicada',
    simulationResultLabel: 'Resultado Avaliado',
    diagramsHeading: 'Fluxo de Dados & Estados',
    limitationsHeading: 'Limitações & Omissões',
    quizHeading: 'Teste seu Entendimento',
    quizQuestionLabel: 'Pergunta',
    quizScoreLabel: 'Pontuação',
    quizReset: 'Reiniciar',
    quizSelect: 'Selecionar',
    quizCorrect: 'Correta',
    quizIncorrect: 'Incorreta',
    quizNoQuestions: 'Nenhum quiz é necessário para esta alteração concisa.',
    contextRetrievedBadge: 'Contexto Enriquecido',
    diffTruncatedBadge: 'Diff Truncado',
    costLabel: 'Custo',
    tokensLabel: 'Tokens',
    modelLabel: 'Modelo',
    commitLabel: 'Commit',
    themeToggle: 'Alternar Tema',
    generationLabel: 'Gerado em',
    limitationsEmpty: 'Nenhuma limitação adicional foi reportada.',
    legacyDiagramNote: 'Texto de diagrama legado (escapado)',
    legacyCodeNote: 'Texto de walkthrough legado (escapado)',
    scenarios: 'cenários'
  }
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function renderNarrative(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '';

  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function renderList(items) {
  return asArray(items)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('\n');
}

function renderSectionHeading(title, className = '') {
  return `<h2 class="section-title ${className}"><span class="section-dot" aria-hidden="true"></span>${escapeHtml(title)}</h2>`;
}

function renderEvidenceSection(evidence, language) {
  const i18n = I18N[language] || I18N.en;
  const value = evidence && typeof evidence === 'object' ? evidence : {};
  const verified = asArray(value.verifiedCodeFacts);
  const intent = asArray(value.authorIntent);
  const unknowns = asArray(value.unknownsOrRisks);

  if (verified.length === 0 && intent.length === 0 && unknowns.length === 0) {
    return '';
  }

  return `
    <section class="card">
      ${renderSectionHeading(i18n.evidenceHeading)}
      <div class="evidence-grid">
        ${verified.length > 0 ? `
          <div class="evidence-card verified">
            <h3 class="evidence-title">${escapeHtml(i18n.verifiedCode)}</h3>
            <ul class="evidence-list">${renderList(verified)}</ul>
          </div>` : ''}
        ${intent.length > 0 ? `
          <div class="evidence-card intent">
            <h3 class="evidence-title">${escapeHtml(i18n.authorIntent)}</h3>
            <ul class="evidence-list">${renderList(intent)}</ul>
          </div>` : ''}
        ${unknowns.length > 0 ? `
          <div class="evidence-card unknown">
            <h3 class="evidence-title">${escapeHtml(i18n.unverifiedUnknowns)}</h3>
            <ul class="evidence-list">${renderList(unknowns)}</ul>
          </div>` : ''}
      </div>
    </section>`;
}

function renderSimulationSection(simulation, language) {
  const i18n = I18N[language] || I18N.en;
  const value = simulation && typeof simulation === 'object' ? simulation : {};
  const scenarios = asArray(value.scenarios);

  if (!value.enabled || scenarios.length === 0) {
    return '';
  }

  const safeScenarios = scenarios.map((scenario) => {
    const item = scenario && typeof scenario === 'object' ? scenario : {};
    const outcome = item.outcome && typeof item.outcome === 'object' ? item.outcome : {};
    return {
      label: String(item.label || ''),
      explanation: String(item.explanation || ''),
      outcome: {
        action: String(outcome.action || ''),
        status: String(outcome.status || '')
      }
    };
  });

  const scenariosJson = escapeHtml(JSON.stringify(safeScenarios));
  const first = safeScenarios[0];

  return `
    <section class="card" id="simulation-section" data-scenarios="${scenariosJson}">
      <div class="section-heading-group">
        <span class="kicker">Interactive Simulation</span>
        ${renderSectionHeading(value.title || i18n.simulationHeading)}
        <p class="section-subtitle">${escapeHtml(value.description || i18n.simulationSubtitle)}</p>
      </div>
      ${value.rule ? `
        <div class="rule-box"><strong>${escapeHtml(i18n.simulationRuleLabel)}:</strong> ${escapeHtml(value.rule)}</div>` : ''}
      <div class="sim-tabs" role="tablist">
        ${safeScenarios.map((scenario, index) => `
          <button type="button" class="sim-tab${index === 0 ? ' active' : ''}" data-sim-index="${index}" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}">
            ${escapeHtml(scenario.label || `Scenario ${index + 1}`)}
          </button>`).join('')}
      </div>
      <div class="sim-result">
        <div class="sim-result-top">
          <span class="sim-result-label">${escapeHtml(i18n.simulationResultLabel)}</span>
          <span class="sim-badge" id="sim-outcome-badge">${escapeHtml(first.outcome.action || 'Evaluated')}</span>
        </div>
        <p id="sim-explanation">${escapeHtml(first.explanation)}</p>
      </div>
    </section>`;
}

function renderVisualizations(visualizations, legacyDiagrams, language) {
  const i18n = I18N[language] || I18N.en;
  const diagrams = asArray(visualizations);

  if (diagrams.length > 0) {
    return `
      <section class="card">
        ${renderSectionHeading(i18n.diagramsHeading)}
        <div class="diagram-list">
          ${diagrams.map((diagram) => {
            const item = diagram && typeof diagram === 'object' ? diagram : {};
            const nodes = asArray(item.nodes);
            return `
              <div class="diagram">
                <h3 class="diagram-title">${escapeHtml(item.title || '')}</h3>
                ${item.caption ? `<p class="diagram-caption">${escapeHtml(item.caption)}</p>` : ''}
                <div class="diagram-flow">
                  ${nodes.map((node, index) => {
                    const entry = node && typeof node === 'object' ? node : {};
                    return `
                      <div class="diagram-node">
                        <div class="diagram-node-label">${escapeHtml(entry.label || entry.id || `Node ${index + 1}`)}</div>
                        <div class="diagram-node-desc">${escapeHtml(entry.description || '')}</div>
                      </div>
                      ${index < nodes.length - 1 ? '<div class="diagram-arrow" aria-hidden="true">→</div>' : ''}`;
                  }).join('')}
                </div>
              </div>`;
          }).join('')}
        </div>
      </section>`;
  }

  if (legacyDiagrams && String(legacyDiagrams).trim().length > 0) {
    return `
      <section class="card">
        ${renderSectionHeading(i18n.diagramsHeading)}
        <p class="legacy-note">${escapeHtml(i18n.legacyDiagramNote)}</p>
        <pre class="legacy-text">${escapeHtml(legacyDiagrams)}</pre>
      </section>`;
  }

  return '';
}

function renderWalkthroughSection(walkthrough, legacyCodeWalkthrough, language) {
  const i18n = I18N[language] || I18N.en;
  const groups = asArray(walkthrough);
  const structured = groups.length > 0 && !groups[0].rawCodeWalkthrough;

  if (structured) {
    return `
      <section class="card">
        ${renderSectionHeading(i18n.walkthroughHeading)}
        <div class="walkthrough-list">
          ${groups.map((group) => {
            const item = group && typeof group === 'object' ? group : {};
            const files = asArray(item.files);
            return `
              <div class="walkthrough-group">
                <h3 class="walkthrough-title">${escapeHtml(item.groupTitle || '')}</h3>
                ${item.description ? `<p class="walkthrough-description">${escapeHtml(item.description)}</p>` : ''}
                ${files.map((file) => {
                  const entry = file && typeof file === 'object' ? file : {};
                  return `
                    <div class="walkthrough-file">
                      <div class="file-header">
                        <span class="file-path">${escapeHtml(entry.path || '')}</span>
                        ${entry.keyLines ? `<span class="key-lines">L${escapeHtml(entry.keyLines)}</span>` : ''}
                      </div>
                      ${entry.role ? `<div class="file-role">${escapeHtml(entry.role)}</div>` : ''}
                      ${entry.summary ? `<p class="file-summary">${escapeHtml(entry.summary)}</p>` : ''}
                      ${entry.diffSnippet ? `<pre class="code-block">${escapeHtml(entry.diffSnippet)}</pre>` : ''}
                    </div>`;
                }).join('')}
              </div>`;
          }).join('')}
        </div>
      </section>`;
  }

  if (legacyCodeWalkthrough && String(legacyCodeWalkthrough).trim().length > 0) {
    return `
      <section class="card">
        ${renderSectionHeading(i18n.walkthroughHeading)}
        <p class="legacy-note">${escapeHtml(i18n.legacyCodeNote)}</p>
        <pre class="legacy-text">${escapeHtml(legacyCodeWalkthrough)}</pre>
      </section>`;
  }

  return '';
}

function renderQuizHtml(quiz, language) {
  const i18n = I18N[language] || I18N.en;
  const questions = asArray(quiz);

  if (questions.length === 0) {
    return `<div class="empty-state">${escapeHtml(i18n.quizNoQuestions)}</div>`;
  }

  const questionTotal = questions.length;
  let quizHtml = `
    <div class="quiz-meta">
      <span>${escapeHtml(i18n.quizScoreLabel)}: <strong id="quiz-score-badge">0</strong> / ${questionTotal}</span>
      <span>${questionTotal} ${questionTotal === 1 ? 'question' : 'questions'}</span>
    </div>`;

  questions.forEach((question, questionIndex) => {
    const item = question && typeof question === 'object' ? question : {};
    const options = asArray(item.options);
    const explanations = asArray(item.explanations);
    const correctIndex = Number.isInteger(item.correctOptionIndex) ? item.correctOptionIndex : -1;
    let optionsHtml = '';

    options.forEach((option, optionIndex) => {
      const isCorrect = optionIndex === correctIndex;
      const explanationId = `ex-q${questionIndex}-o${optionIndex}`;
      optionsHtml += `
        <div class="option-wrap">
          <button type="button"
                  id="btn-q${questionIndex}-o${optionIndex}"
                  class="option"
                  data-quiz-option
                  data-question-index="${questionIndex}"
                  data-option-index="${optionIndex}"
                  data-correct="${isCorrect ? 'true' : 'false'}"
                  data-explanation-id="${explanationId}"
                  aria-pressed="false">
            <span>${escapeHtml(option)}</span>
            <span class="option-hint">${escapeHtml(i18n.quizSelect)}</span>
          </button>
          <div id="${explanationId}" class="explanation" hidden>
            <p class="verdict ${isCorrect ? 'correct' : 'incorrect'}">${isCorrect ? '✓' : '✗'} ${escapeHtml(isCorrect ? i18n.quizCorrect : i18n.quizIncorrect)}</p>
            <p>${escapeHtml(explanations[optionIndex] || '')}</p>
          </div>
        </div>`;
    });

    quizHtml += `
      <div class="quiz-question">
        <div class="question-header">
          <h3 class="question-title">
            <span class="question-number">${escapeHtml(i18n.quizQuestionLabel)} ${questionIndex + 1}.</span>
            ${escapeHtml(item.question || '')}
          </h3>
          <button type="button" class="reset" id="reset-q${questionIndex}" data-reset-question="${questionIndex}" hidden>
            ${escapeHtml(i18n.quizReset)}
          </button>
        </div>
        <div class="quiz-options">${optionsHtml}</div>
      </div>`;
  });

  return quizHtml;
}

function renderLimitationsSection(limitations, language) {
  const i18n = I18N[language] || I18N.en;
  const value = limitations && typeof limitations === 'object' ? limitations : {};
  const groups = [
    ['omissions', value.omissions],
    ['unknowns', value.unknowns],
    ['unverifiedClaims', value.unverifiedClaims]
  ].filter(([, items]) => asArray(items).length > 0);

  if (groups.length === 0) {
    return '';
  }

  return `
    <section class="card">
      ${renderSectionHeading(i18n.limitationsHeading)}
      <div class="limitations-list">
        ${groups.map(([, items]) => `<ul class="evidence-list">${renderList(items)}</ul>`).join('')}
      </div>
    </section>`;
}

function renderEditorialDocument({
  prNumber,
  prTitle,
  generationDate,
  language = 'en',
  provider,
  model,
  commitSha = 'HEAD',
  usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  formattedPrice = 'n/a',
  rateChip = '',
  content,
  contextMetadata = null
}) {
  const i18n = I18N[language] || I18N.en;
  const safeContent = content && typeof content === 'object' ? content : {};
  const quizHtml = renderQuizHtml(safeContent.quiz, language);
  const evidenceHtml = renderEvidenceSection(safeContent.evidence, language);
  const simulationHtml = renderSimulationSection(safeContent.simulation, language);
  const visualizationsHtml = renderVisualizations(safeContent.visualizations, safeContent.diagrams, language);
  const walkthroughHtml = renderWalkthroughSection(safeContent.walkthrough, safeContent.codeWalkthrough, language);
  const limitationsHtml = renderLimitationsSection(safeContent.limitations, language);

  const contextBadge = (contextMetadata && asArray(contextMetadata.retrievedFiles).length > 0)
    ? `<span class="badge badge-accent">${escapeHtml(i18n.contextRetrievedBadge)} (${asArray(contextMetadata.retrievedFiles).length})</span>`
    : '';

  const truncationBadge = (contextMetadata && contextMetadata.diffMeta && contextMetadata.diffMeta.isTruncated)
    ? `<span class="badge badge-warn">${escapeHtml(i18n.diffTruncatedBadge)}</span>`
    : '';

  const problemText = safeContent.summary && safeContent.summary.problem
    ? safeContent.summary.problem
    : (safeContent.background || '');
  const solutionText = safeContent.summary && safeContent.summary.solution
    ? safeContent.summary.solution
    : '';
  const mechanismText = safeContent.mechanism && safeContent.mechanism.overview
    ? safeContent.mechanism.overview
    : (safeContent.intuition || '');
  const totalTokens = Number.isFinite(Number(usage && usage.total_tokens))
    ? Number(usage.total_tokens)
    : 0;
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <title>${escapeHtml(i18n.pageTitle)} #${escapeHtml(prNumber)} — ${escapeHtml(prTitle)}</title>
  <style nonce="${nonce}">
    :root {
      --bg: #fcfbf9;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #667085;
      --border: #e5e7eb;
      --accent: #7c3aed;
      --accent-soft: #f3e8ff;
      --accent-strong: #5b21b6;
      --green: #047857;
      --green-soft: #ecfdf5;
      --red: #b91c1c;
      --red-soft: #fef2f2;
      --amber: #b45309;
      --amber-soft: #fffbeb;
      --blue: #1d4ed8;
      --blue-soft: #eff6ff;
      --code-bg: #101014;
      --code-text: #e9d5ff;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px rgba(16, 24, 40, 0.04);
      --radius: 18px;
    }
    html[data-theme="dark"] {
      --bg: #0f0f11;
      --card: #18181b;
      --text: #f3f4f6;
      --muted: #a1a1aa;
      --border: #2d2d33;
      --accent: #a78bfa;
      --accent-soft: #2e1065;
      --accent-strong: #ddd6fe;
      --green: #34d399;
      --green-soft: #052e26;
      --red: #f87171;
      --red-soft: #3f1212;
      --amber: #fbbf24;
      --amber-soft: #3b2a06;
      --blue: #93c5fd;
      --blue-soft: #10233f;
      --code-bg: #0a0a0c;
      --code-text: #e9d5ff;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.25), 0 12px 32px rgba(0, 0, 0, 0.18);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; }
    .container { max-width: 1040px; margin: 0 auto; padding: 40px 20px 56px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 28px;
      margin-bottom: 24px;
    }
    .hero { padding: 32px; }
    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .kicker {
      display: inline-block;
      color: var(--accent-strong);
      background: var(--accent-soft);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-radius: 999px;
      padding: 3px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--muted);
    }
    .badge-accent { color: var(--accent-strong); background: var(--accent-soft); border-color: transparent; }
    .badge-warn { color: var(--amber); background: var(--amber-soft); border-color: transparent; }
    .title {
      margin: 8px 0 0;
      font-family: Georgia, Cambria, "Times New Roman", Times, serif;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      line-height: 1.15;
      letter-spacing: -0.02em;
    }
    .theme-toggle {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .theme-toggle:hover { border-color: var(--accent); color: var(--accent-strong); }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .meta-label { display: block; color: var(--muted); margin-bottom: 2px; }
    .meta-value { font-weight: 700; overflow-wrap: anywhere; }
    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 16px;
      font-family: Georgia, Cambria, "Times New Roman", Times, serif;
      font-size: 1.35rem;
      line-height: 1.25;
    }
    .section-dot {
      width: 10px;
      height: 10px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
    }
    .section-heading-group .section-title { margin-bottom: 6px; }
    .section-subtitle { margin: 0 0 16px; color: var(--muted); font-size: 0.95rem; }
    .narrative p { margin: 0 0 0.85rem; }
    .narrative p:last-child { margin-bottom: 0; }
    .narrative .solution {
      margin-top: 1rem;
      padding: 16px;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      background: var(--accent-soft);
      border-radius: 12px;
      font-weight: 600;
      color: var(--text);
    }
    .evidence-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .evidence-card { border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
    .evidence-card.verified { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 25%, transparent); }
    .evidence-card.intent { background: var(--blue-soft); border-color: color-mix(in srgb, var(--blue) 25%, transparent); }
    .evidence-card.unknown { background: var(--amber-soft); border-color: color-mix(in srgb, var(--amber) 25%, transparent); }
    .evidence-title {
      margin: 0 0 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .evidence-card.verified .evidence-title { color: var(--green); }
    .evidence-card.intent .evidence-title { color: var(--blue); }
    .evidence-card.unknown .evidence-title { color: var(--amber); }
    .evidence-list { margin: 0; padding-left: 18px; }
    .evidence-list li { margin-bottom: 7px; overflow-wrap: anywhere; }
    .evidence-list li:last-child { margin-bottom: 0; }
    .rule-box {
      border: 1px solid var(--border);
      background: var(--bg);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .rule-box strong { color: var(--accent-strong); }
    .sim-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .sim-tab {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      border-radius: 10px;
      padding: 7px 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      cursor: pointer;
    }
    .sim-tab.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); }
    .sim-result {
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      background: color-mix(in srgb, var(--accent-soft) 55%, var(--card));
      border-radius: 14px;
      padding: 16px;
    }
    .sim-result-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .sim-result-label {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--accent-strong);
    }
    .sim-badge {
      border-radius: 7px;
      padding: 2px 8px;
      background: var(--accent);
      color: #fff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      font-weight: 700;
    }
    .sim-result p { margin: 0; }
    .diagram-list { display: grid; gap: 18px; }
    .diagram { border: 1px solid var(--border); border-radius: 14px; padding: 16px; background: color-mix(in srgb, var(--bg) 55%, var(--card)); }
    .diagram-title { margin: 0 0 4px; font-size: 1rem; }
    .diagram-caption { margin: 0 0 14px; color: var(--muted); font-size: 0.85rem; }
    .diagram-flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 10px; overflow-x: auto; padding: 4px 0; }
    .diagram-node {
      min-width: 9rem;
      max-width: 15rem;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .diagram-node-label { color: var(--accent-strong); font-weight: 800; margin-bottom: 4px; overflow-wrap: anywhere; }
    .diagram-node-desc { color: var(--muted); overflow-wrap: anywhere; }
    .diagram-arrow { align-self: center; color: var(--accent); font-weight: 800; }
    .walkthrough-list { display: grid; gap: 18px; }
    .walkthrough-title { margin: 0 0 4px; font-size: 1.05rem; }
    .walkthrough-description { margin: 0 0 12px; color: var(--muted); font-size: 0.9rem; }
    .walkthrough-file { border: 1px solid var(--border); border-radius: 14px; padding: 16px; background: color-mix(in srgb, var(--bg) 55%, var(--card)); margin-bottom: 12px; }
    .walkthrough-file:last-child { margin-bottom: 0; }
    .file-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .file-path { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; font-weight: 800; color: var(--accent-strong); overflow-wrap: anywhere; }
    .key-lines { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .file-role { margin-top: 4px; color: var(--muted); font-size: 0.82rem; font-style: italic; }
    .file-summary { margin: 8px 0; font-size: 0.9rem; }
    .code-block, .legacy-text {
      margin: 10px 0 0;
      padding: 14px;
      border-radius: 12px;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid #27272a;
      overflow-x: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
    }
    .legacy-note { margin: 0 0 8px; color: var(--muted); font-size: 0.8rem; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .quiz-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .quiz-meta strong { color: var(--accent-strong); font-size: 1.1rem; }
    .quiz-question { border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin-bottom: 14px; background: color-mix(in srgb, var(--bg) 45%, var(--card)); }
    .quiz-question:last-child { margin-bottom: 0; }
    .question-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .question-title { margin: 0; font-size: 1rem; line-height: 1.4; }
    .question-number { color: var(--accent-strong); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .reset {
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      white-space: nowrap;
    }
    .reset:hover { color: var(--accent-strong); }
    .quiz-options { display: grid; gap: 10px; }
    .option-wrap { display: grid; gap: 6px; }
    .option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
      color: var(--text);
      padding: 13px 14px;
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .option:hover { border-color: var(--accent); }
    .option:disabled { cursor: default; opacity: 0.75; }
    .option.correct { border-color: var(--green); background: var(--green-soft); opacity: 1; }
    .option.incorrect { border-color: var(--red); background: var(--red-soft); opacity: 1; }
    .option-hint { color: var(--accent-strong); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; opacity: 0; }
    .option:hover .option-hint { opacity: 1; }
    .explanation { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--bg); font-size: 0.9rem; }
    .explanation p { margin: 0; }
    .verdict { margin-bottom: 5px !important; font-weight: 800; }
    .verdict.correct { color: var(--green); }
    .verdict.incorrect { color: var(--red); }
    .empty-state { border: 1px dashed var(--border); border-radius: 12px; padding: 22px; text-align: center; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .limitations-list { display: grid; gap: 12px; }
    .footer { text-align: center; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; padding: 12px 0 0; }
    .footer p { margin: 3px 0; }
    [hidden] { display: none !important; }
    @media (max-width: 760px) {
      .container { padding: 20px 12px 40px; }
      .card, .hero { padding: 20px; }
      .hero-top { flex-direction: column; }
      .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .evidence-grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="card hero">
      <div class="hero-top">
        <div>
          <span class="kicker">${escapeHtml(i18n.automatedReview)}</span>
          <div class="badges">
            <span class="badge">PR #${escapeHtml(prNumber)}</span>
            ${contextBadge}
            ${truncationBadge}
          </div>
          <h1 class="title">${escapeHtml(prTitle)}</h1>
        </div>
        <button type="button" class="theme-toggle" id="theme-toggle">${escapeHtml(i18n.themeToggle)}</button>
      </div>
      <div class="meta-grid">
        <div>
          <span class="meta-label">${escapeHtml(i18n.commitLabel)}</span>
          <span class="meta-value">${escapeHtml(String(commitSha || 'HEAD').slice(0, 7))}</span>
        </div>
        <div>
          <span class="meta-label">${escapeHtml(i18n.modelLabel)}</span>
          <span class="meta-value">${escapeHtml(model || '')}</span>
        </div>
        <div>
          <span class="meta-label">${escapeHtml(i18n.tokensLabel)}</span>
          <span class="meta-value">${totalTokens}</span>
        </div>
      </div>
    </header>

    <main>
      <section class="card">
        ${renderSectionHeading(i18n.overviewHeading)}
        <p class="section-subtitle">${escapeHtml(i18n.overviewSubtitle)}</p>
        <div class="narrative">
          ${renderNarrative(problemText)}
          ${solutionText && solutionText !== problemText ? `<div class="solution">${renderNarrative(solutionText)}</div>` : ''}
        </div>
      </section>

      <section class="card">
        ${renderSectionHeading(i18n.mechanismHeading)}
        <p class="section-subtitle">${escapeHtml(i18n.mechanismSubtitle)}</p>
        <div class="narrative">${renderNarrative(mechanismText)}</div>
      </section>

      ${evidenceHtml}
      ${simulationHtml}
      ${visualizationsHtml}
      ${walkthroughHtml}
      ${limitationsHtml}

      <section class="card">
        ${renderSectionHeading(i18n.quizHeading)}
        <div id="quiz-container">${quizHtml}</div>
      </section>
    </main>

    <footer class="footer">
      <p>PR Explainer AI • ${escapeHtml(i18n.generationLabel)} ${escapeHtml(generationDate)}</p>
      <p>${escapeHtml(i18n.costLabel)}: ${escapeHtml(formattedPrice)} • ${escapeHtml(rateChip || '')}</p>
      <p>Understanding is the new bottleneck.</p>
    </footer>
  </div>

  <script nonce="${nonce}">
    (function () {
      var themeToggle = document.getElementById('theme-toggle');
      var root = document.documentElement;
      if (themeToggle) {
        themeToggle.addEventListener('click', function () {
          root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        });
      }

      var quizState = {};
      var scoreBadge = document.getElementById('quiz-score-badge');

      function updateScore() {
        if (!scoreBadge) return;
        var score = 0;
        Object.keys(quizState).forEach(function (key) {
          if (quizState[key]) score += 1;
        });
        scoreBadge.textContent = String(score);
      }

      function optionButtons(questionIndex) {
        return document.querySelectorAll('[data-quiz-option][data-question-index="' + questionIndex + '"]');
      }

      document.querySelectorAll('[data-quiz-option]').forEach(function (button) {
        button.addEventListener('click', function () {
          var questionIndex = button.getAttribute('data-question-index');
          var explanationId = button.getAttribute('data-explanation-id');
          var isCorrect = button.getAttribute('data-correct') === 'true';
          var explanation = explanationId ? document.getElementById(explanationId) : null;

          optionButtons(questionIndex).forEach(function (candidate) {
            candidate.disabled = true;
            candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false');
          });

          button.classList.add(isCorrect ? 'correct' : 'incorrect');
          if (explanation) explanation.hidden = false;

          var resetButton = document.getElementById('reset-q' + questionIndex);
          if (resetButton) resetButton.hidden = false;

          quizState[questionIndex] = isCorrect;
          updateScore();
        });
      });

      document.querySelectorAll('[data-reset-question]').forEach(function (button) {
        button.addEventListener('click', function () {
          var questionIndex = button.getAttribute('data-reset-question');
          optionButtons(questionIndex).forEach(function (candidate) {
            candidate.disabled = false;
            candidate.classList.remove('correct', 'incorrect');
            candidate.setAttribute('aria-pressed', 'false');
            var explanationId = candidate.getAttribute('data-explanation-id');
            var explanation = explanationId ? document.getElementById(explanationId) : null;
            if (explanation) explanation.hidden = true;
          });
          delete quizState[questionIndex];
          button.hidden = true;
          updateScore();
        });
      });

      var simulationSection = document.getElementById('simulation-section');
      if (simulationSection) {
        var scenarios = [];
        try {
          scenarios = JSON.parse(simulationSection.getAttribute('data-scenarios') || '[]');
        } catch (error) {
          scenarios = [];
        }

        var tabs = simulationSection.querySelectorAll('[data-sim-index]');
        var badge = document.getElementById('sim-outcome-badge');
        var explanation = document.getElementById('sim-explanation');

        tabs.forEach(function (tab) {
          tab.addEventListener('click', function () {
            var index = Number(tab.getAttribute('data-sim-index'));
            var scenario = scenarios[index];
            if (!scenario) return;

            tabs.forEach(function (candidate) {
              var active = candidate === tab;
              candidate.classList.toggle('active', active);
              candidate.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            if (badge) badge.textContent = (scenario.outcome && scenario.outcome.action) || 'Evaluated';
            if (explanation) explanation.textContent = scenario.explanation || '';
          });
        });
      }
    }());
  </script>
</body>
</html>`;
}

module.exports = {
  I18N,
  renderEvidenceSection,
  renderSimulationSection,
  renderVisualizations,
  renderWalkthroughSection,
  renderQuizHtml,
  renderEditorialDocument
};
