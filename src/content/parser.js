const HTML_ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

const HTML_TAG_PATTERN = /<\/?(?:p|div|span|script|style|img|a|pre|code|h[1-6]|ul|ol|li|br|strong|em|b|i|table|thead|tbody|tr|td|th|section|article|blockquote|figure|figcaption|hr)\b/i;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function decodeHtmlEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITY_MAP, normalized)
      ? HTML_ENTITY_MAP[normalized]
      : match;
  });
}

function looksLikeHtml(value) {
  return typeof value === 'string' && HTML_TAG_PATTERN.test(value);
}

/**
 * Converts legacy model HTML into plain text. This is intentionally conservative:
 * it never parses or executes HTML, it only removes tags and decodes textual entities.
 */
function htmlToPlainText(value) {
  let text = value === null || value === undefined ? '' : String(value);

  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*\/\s*(?:p|div|section|article|li|h[1-6]|tr|pre|blockquote|figure)\s*>/gi, '\n');
  text = text.replace(/<\s*li[^>]*>/gi, '• ');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function normalizeDisplayText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return (looksLikeHtml(text) ? htmlToPlainText(text) : text).trim();
}

function normalizeCodeText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return (looksLikeHtml(text) ? htmlToPlainText(text) : text).trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeDisplayText(entry))
    .filter((entry) => entry.length > 0);
}

function stripMarkdownFences(text) {
  let result = String(text || '').trim();
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

function repairTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let json = text.substring(start);
  const lastNewline = json.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? json : json.substring(lastNewline);
  const quoteCount = (lastLine.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    json += '"';
  }

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

/**
 * Some OpenAI-compatible endpoints drop only the opening root brace when JSON
 * mode is enabled (observed with DeepSeek V4-Flash on Featherless). This is a
 * narrow, unambiguous repair: the payload must start with a quoted key and end
 * with a closing object brace. Partial or truncated JSON is still rejected.
 */
function repairMissingRootBrace(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('}')) return null;

  try {
    return JSON.parse(`{${trimmed}`);
  } catch {
    return null;
  }
}

function parseModelContent(rawContent) {
  const contentText = stripMarkdownFences(rawContent);

  try {
    return JSON.parse(contentText);
  } catch (firstError) {
    console.warn(`JSON parse direto falhou: ${firstError.message}. Tentando repair...`);
    console.warn(`Raw response (primeiros 500 chars): ${contentText.substring(0, 500)}`);
  }

  const repairedRoot = repairMissingRootBrace(contentText);
  if (repairedRoot !== null) {
    console.warn('JSON repair: missing opening root brace restored.');
    return repairedRoot;
  }

  const repaired = repairTruncatedJson(contentText);
  if (repaired !== null) {
    console.warn('JSON repair bem-sucedido, mas resposta estava truncada. Será tratado como falha para retry.');
    throw new Error('JSON estava truncado — repair possível mas conteúdo parcial rejeitado para garantir qualidade.');
  }

  throw new Error('Failed to parse JSON — resposta da LLM é inválida e não reparável.');
}

function validateExplanation(explanation) {
  if (!explanation || typeof explanation !== 'object') {
    throw new Error('Explanation retornada pela LLM é inválida ou nula.');
  }

  const legacyFields = ['background', 'intuition', 'diagrams', 'codeWalkthrough'];
  const legacyNonEmpty = legacyFields.filter(
    (field) => explanation[field] && String(explanation[field]).trim().length > 0
  );

  const semanticFields = ['summary', 'mechanism', 'walkthrough'];
  const semanticNonEmpty = semanticFields.filter(
    (field) => explanation[field] && (typeof explanation[field] === 'object' || String(explanation[field]).trim().length > 0)
  );

  if (legacyNonEmpty.length === 0 && semanticNonEmpty.length === 0) {
    throw new Error('Explanation retornada pela LLM tem todos os campos essenciais vazios.');
  }

  const emptyFields = legacyFields.filter((f) => !legacyNonEmpty.includes(f));
  if (emptyFields.length > 0 && semanticNonEmpty.length === 0) {
    console.warn(`Campos vazios na explanation: ${emptyFields.join(', ')}. Continuando com conteúdo parcial.`);
  }
}

function normalizeVisualizations(value) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 6).map((diagram) => {
    const item = diagram && typeof diagram === 'object' ? diagram : {};
    const nodes = Array.isArray(item.nodes) ? item.nodes.slice(0, 12) : [];

    return {
      type: normalizeDisplayText(item.type),
      title: normalizeDisplayText(item.title),
      caption: normalizeDisplayText(item.caption),
      nodes: nodes.map((node) => {
        const entry = node && typeof node === 'object' ? node : {};
        return {
          id: normalizeDisplayText(entry.id),
          label: normalizeDisplayText(entry.label),
          description: normalizeDisplayText(entry.description)
        };
      })
    };
  });
}

function normalizeWalkthrough(value) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 12).map((group) => {
    const item = group && typeof group === 'object' ? group : {};
    const files = Array.isArray(item.files) ? item.files.slice(0, 20) : [];

    return {
      groupTitle: normalizeDisplayText(item.groupTitle),
      description: normalizeDisplayText(item.description),
      files: files.map((file) => {
        const entry = file && typeof file === 'object' ? file : {};
        return {
          path: normalizeDisplayText(entry.path),
          role: normalizeDisplayText(entry.role),
          summary: normalizeDisplayText(entry.summary),
          keyLines: normalizeDisplayText(entry.keyLines),
          // Code snippets are data. Renderers escape them; never tag-strip them here.
          diffSnippet: entry.diffSnippet === null || entry.diffSnippet === undefined
            ? ''
            : String(entry.diffSnippet).trim()
        };
      }),
      rawCodeWalkthrough: normalizeCodeText(item.rawCodeWalkthrough)
    };
  });
}

function normalizeSimulation(value) {
  if (!value || typeof value !== 'object') return { enabled: false };

  const scenarios = Array.isArray(value.scenarios) ? value.scenarios.slice(0, 8) : [];

  return {
    enabled: Boolean(value.enabled) && scenarios.length > 0,
    title: normalizeDisplayText(value.title),
    description: normalizeDisplayText(value.description),
    rule: normalizeDisplayText(value.rule),
    scenarios: scenarios.map((scenario) => {
      const item = scenario && typeof scenario === 'object' ? scenario : {};
      const outcome = item.outcome && typeof item.outcome === 'object' ? item.outcome : {};
      return {
        id: normalizeDisplayText(item.id),
        label: normalizeDisplayText(item.label),
        outcome: {
          action: normalizeDisplayText(outcome.action),
          status: normalizeDisplayText(outcome.status)
        },
        explanation: normalizeDisplayText(item.explanation)
      };
    })
  };
}

function normalizeLimitations(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    omissions: normalizeStringArray(item.omissions),
    unknowns: normalizeStringArray(item.unknowns),
    unverifiedClaims: normalizeStringArray(item.unverifiedClaims)
  };
}

function normalizeSemanticContent(rawExplanation, prContext = {}) {
  if (!rawExplanation || typeof rawExplanation !== 'object') {
    throw new Error('Conteúdo da explicação ausente ou inválido.');
  }

  const prBody = prContext.prBody ? normalizeDisplayText(String(prContext.prBody).slice(0, 300)) : '';

  if (rawExplanation.summary && typeof rawExplanation.summary === 'object') {
    const summary = rawExplanation.summary;
    const mechanism = rawExplanation.mechanism && typeof rawExplanation.mechanism === 'object'
      ? rawExplanation.mechanism
      : {};
    const evidence = rawExplanation.evidence && typeof rawExplanation.evidence === 'object'
      ? rawExplanation.evidence
      : {};
    const limitations = normalizeLimitations(rawExplanation.limitations);

    return {
      summary: {
        problem: normalizeDisplayText(summary.problem),
        solution: normalizeDisplayText(summary.solution),
        invariants: normalizeStringArray(summary.invariants)
      },
      mechanism: {
        overview: normalizeDisplayText(mechanism.overview || rawExplanation.mechanism),
        insights: normalizeStringArray(mechanism.insights)
      },
      evidence: {
        verifiedCodeFacts: normalizeStringArray(evidence.verifiedCodeFacts),
        authorIntent: normalizeStringArray(evidence.authorIntent).length > 0
          ? normalizeStringArray(evidence.authorIntent)
          : (prBody ? [prBody] : []),
        unknownsOrRisks: normalizeStringArray(evidence.unknownsOrRisks)
      },
      visualizations: normalizeVisualizations(rawExplanation.visualizations),
      walkthrough: normalizeWalkthrough(rawExplanation.walkthrough),
      simulation: normalizeSimulation(rawExplanation.simulation),
      quiz: Array.isArray(rawExplanation.quiz) ? rawExplanation.quiz : [],
      limitations,
      // Legacy keys are normalized too. No model-provided HTML survives this boundary.
      background: normalizeDisplayText(rawExplanation.background || summary.problem),
      intuition: normalizeDisplayText(rawExplanation.intuition || mechanism.overview),
      diagrams: normalizeDisplayText(rawExplanation.diagrams),
      codeWalkthrough: normalizeCodeText(rawExplanation.codeWalkthrough)
    };
  }

  const background = normalizeDisplayText(rawExplanation.background);
  const intuition = normalizeDisplayText(rawExplanation.intuition);
  const codeWalkthrough = normalizeCodeText(rawExplanation.codeWalkthrough);
  const diagrams = normalizeDisplayText(rawExplanation.diagrams);
  const rawQuiz = Array.isArray(rawExplanation.quiz) ? rawExplanation.quiz : [];

  return {
    summary: {
      problem: background,
      solution: intuition.slice(0, 300),
      invariants: []
    },
    mechanism: {
      overview: intuition,
      insights: []
    },
    evidence: {
      verifiedCodeFacts: [],
      authorIntent: prBody ? [prBody] : [],
      unknownsOrRisks: []
    },
    visualizations: [],
    walkthrough: [
      {
        groupTitle: 'Changed Files',
        description: 'Code modifications identified in the diff',
        files: [],
        rawCodeWalkthrough: codeWalkthrough
      }
    ],
    simulation: { enabled: false },
    quiz: rawQuiz,
    limitations: {
      omissions: [],
      unknowns: [],
      unverifiedClaims: []
    },
    background,
    intuition,
    diagrams,
    codeWalkthrough
  };
}

module.exports = {
  escapeHtml,
  decodeHtmlEntities,
  htmlToPlainText,
  looksLikeHtml,
  normalizeDisplayText,
  normalizeCodeText,
  stripMarkdownFences,
  repairMissingRootBrace,
  repairTruncatedJson,
  parseModelContent,
  validateExplanation,
  normalizeSemanticContent
};
