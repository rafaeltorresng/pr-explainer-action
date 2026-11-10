const { htmlToPlainText, looksLikeHtml } = require('../content/parser');

const COMMENT_MARKER = '<!-- pr-explainer-comment -->';

function sanitizeInlineText(value, maxLength = 700) {
  let text = value === null || value === undefined ? '' : String(value);
  if (looksLikeHtml(text)) {
    text = htmlToPlainText(text);
  }

  text = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
  }

  return text
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/([`*_[\]<>|~])/g, '\\$1')
    // Prevent model text from starting a Markdown heading, quote, list, or rule.
    .replace(/^(\s*)([#>\-+=])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2')
    .replace(/@/g, '&#64;')
    .replace(/https?:\/\//gi, (match) => match.replace(':', '&#58;'))
    .replace(/www\./gi, 'www&#46;');
}

function safeCodeSpan(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n`]/g, ' ')
    .slice(0, 200);
}

function safeHttpsUrl(value) {
  if (!value) return null;
  const text = String(value).trim();
  return /^https:\/\/[^\s<>"']+$/i.test(text) ? text : null;
}

function generateMarkdownComment({
  prNumber,
  commitSha,
  provider,
  model,
  language = 'en',
  content,
  runUrl,
  artifactName,
  pagesUrl,
  pagesPrepared = false,
  contextMetadata
}) {
  const isPt = language === 'pt-BR';
  const lines = [COMMENT_MARKER, '### PR Explainer AI'];
  const safeContent = content && typeof content === 'object' ? content : {};

  const shortSha = sanitizeInlineText(commitSha ? String(commitSha).slice(0, 7) : 'HEAD', 20);
  lines.push(`> **Commit:** \`${shortSha}\` | **${isPt ? 'Modelo' : 'Model'}:** \`${safeCodeSpan(model)}\``);
  lines.push('');

  const problem = safeContent.summary && safeContent.summary.problem
    ? safeContent.summary.problem
    : (safeContent.background || '');
  if (problem) {
    lines.push(`#### ${isPt ? 'Contexto e Problema' : 'Context & Problem'}`);
    lines.push(sanitizeInlineText(problem, 900));
    lines.push('');
  }

  const mechanism = safeContent.mechanism && safeContent.mechanism.overview
    ? safeContent.mechanism.overview
    : (safeContent.intuition || '');
  if (mechanism) {
    lines.push(`#### ${isPt ? 'Mecanismo Central' : 'Core Mechanism'}`);
    lines.push(sanitizeInlineText(mechanism, 900));
    lines.push('');
  }

  const verified = (safeContent.evidence && safeContent.evidence.verifiedCodeFacts) || [];
  const intent = (safeContent.evidence && safeContent.evidence.authorIntent) || [];
  const unknowns = (safeContent.evidence && safeContent.evidence.unknownsOrRisks) || [];

  if (verified.length > 0 || intent.length > 0 || unknowns.length > 0) {
    lines.push(`#### ${isPt ? 'Separação de Evidências' : 'Evidence Breakdown'}`);
    if (verified.length > 0) {
      lines.push(`**${isPt ? 'Verificado no Código:' : 'Verified in Code:'}**`);
      verified.slice(0, 4).forEach((entry) => lines.push(`- ✅ ${sanitizeInlineText(entry, 500)}`));
    }
    if (intent.length > 0) {
      lines.push(`**${isPt ? 'Intenção Declarada pelo Autor:' : 'Author-Stated Intent:'}**`);
      intent.slice(0, 3).forEach((entry) => lines.push(`- 📝 ${sanitizeInlineText(entry, 500)}`));
    }
    if (unknowns.length > 0) {
      lines.push(`**${isPt ? 'Incertezas / Premissas:' : 'Uncertainties & Assumptions:'}**`);
      unknowns.slice(0, 3).forEach((entry) => lines.push(`- ⚠️ ${sanitizeInlineText(entry, 500)}`));
    }
    lines.push('');
  }

  if (contextMetadata && contextMetadata.retrievedFiles && contextMetadata.retrievedFiles.length > 0) {
    const filesList = contextMetadata.retrievedFiles
      .map((file) => `\`${safeCodeSpan(file.path)}\``)
      .join(', ');
    const snapshot = contextMetadata.snapshot && contextMetadata.snapshot.mode === 'git'
      ? ` (${isPt ? 'commit analisado' : 'analyzed commit'}: \`${safeCodeSpan(String(contextMetadata.snapshot.commitSha).slice(0, 7))}\`)`
      : '';
    lines.push(`> 🔍 *${isPt ? 'Contexto adicional consultado' : 'Additional context inspected'}:* ${filesList}${snapshot}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`#### ${isPt ? 'Exploração Interativa' : 'Interactive Deliverables'}`);

  const safePagesUrl = safeHttpsUrl(pagesUrl);
  if (safePagesUrl) {
    lines.push(`- 🌐 [${isPt ? 'Abrir Página Interativa (GitHub Pages)' : 'Open Interactive Page (GitHub Pages)'}](${safePagesUrl})`);
  } else if (pagesPrepared) {
    lines.push(`- 📁 *${isPt ? 'Saída para Pages preparada localmente; nenhuma publicação ou URL foi confirmada por esta Action.' : 'Pages output prepared locally; no publication or URL was confirmed by this Action.'}*`);
  }

  const safeRunUrl = safeHttpsUrl(runUrl);
  if (safeRunUrl) {
    lines.push(`- 📦 [${isPt ? 'Baixar Relatório HTML (Artifact)' : 'Download Interactive HTML (Artifact)'}](${safeRunUrl}) \`(${safeCodeSpan(artifactName || 'pr-explanation-html')})\``);
  }
  lines.push(`- 💡 *${isPt ? 'Para atualizar esta explicação, comente' : 'To re-analyze, comment'} \`/explain\`*`);

  return lines.join('\n');
}

function generateOutdatedComment(previousBody, newHeadSha, language = 'en') {
  const isPt = language === 'pt-BR';
  const cleanBody = String(previousBody || '').replace(/^> \[!WARNING\][\s\S]*?\n\n/m, '');
  const shortNewSha = sanitizeInlineText(newHeadSha ? String(newHeadSha).slice(0, 7) : 'HEAD', 20);

  const warning = isPt
    ? `> [!WARNING]\n> **Esta explicação está desatualizada.** Novos commits foram enviados (HEAD atual: \`${shortNewSha}\`). Comente \`/explain\` para reavaliar.`
    : `> [!WARNING]\n> **This explanation is outdated.** New commits were pushed (current HEAD: \`${shortNewSha}\`). Comment \`/explain\` to re-analyze.`;

  return `${warning}\n\n${cleanBody}`;
}

module.exports = {
  COMMENT_MARKER,
  sanitizeInlineText,
  safeCodeSpan,
  safeHttpsUrl,
  generateMarkdownComment,
  generateOutdatedComment
};
