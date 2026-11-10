const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { createGitHubClient } = require('./client');
const {
  resolveLifecycleContext,
  postOrUpdateComment,
  markCommentOutdated
} = require('./lifecycle');

const {
  SKIP_COMMENT_MARKER: SKIP_MARKER,
  DENIED_COMMENT_MARKER: DENIED_MARKER
} = require('../render/markdown-comment');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(value);
    }
  }
  return args;
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`Could not parse JSON file ${path}: ${error.message}`);
    return {};
  }
}

function writeJsonFile(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeGithubOutputs(path, values) {
  if (!path) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const safe = value === null || value === undefined ? '' : String(value);
    return `${key}=${safe.replace(/\r?\n/g, ' ')}`;
  });
  appendFileSync(path, `${lines.join('\n')}\n`);
}

function buildContextFile(result, env = process.env) {
  const headSha = result.headSha || env.PR_HEAD_SHA || (result.mode === 'generate' ? env.GITHUB_SHA : '') || '';
  return {
    mode: result.mode,
    reason: result.reason || '',
    prNumber: String(result.prNumber || env.PR_NUMBER || '0'),
    prTitle: String(result.prTitle || env.PR_TITLE || 'Code Changes'),
    prBody: String(result.prBody || env.PR_BODY || '').slice(0, 8000),
    commitSha: headSha,
    headSha,
    baseRef: String(result.baseRef || env.INPUT_BASE_REF || env.GITHUB_BASE_REF || 'main'),
    baseSha: String(result.baseSha || ''),
    repoOwner: String(result.repoOwner || ''),
    repoName: String(result.repoName || ''),
    requestedBy: String(result.requestedBy || '')
  };
}

function buildSkipBody({ language = 'en', linesChanged = '0', maxLines = '15000', diffEmpty = false }) {
  if (language === 'pt-BR') {
    if (diffEmpty) {
      return [
        SKIP_MARKER,
        '### PR Explainer AI',
        'Ignorado: o pull request não contém alterações de código para analisar.',
        '',
        'O último comentário válido não foi substituído.'
      ].join('\n');
    }
    return [
      SKIP_MARKER,
      '### PR Explainer AI',
      `Ignorado: ${linesChanged} linhas alteradas excedem o limite de ${maxLines}.`,
      '',
      'O último comentário válido não foi substituído.'
    ].join('\n');
  }
  if (diffEmpty) {
    return [
      SKIP_MARKER,
      '### PR Explainer AI',
      'Skipped: the pull request has no code changes to analyze.',
      '',
      'The last valid explanation was not overwritten.'
    ].join('\n');
  }
  return [
    SKIP_MARKER,
    '### PR Explainer AI',
    `Skipped: ${linesChanged} changed lines exceeds the limit of ${maxLines}.`,
    '',
    'The last valid explanation was not overwritten.'
  ].join('\n');
}

function buildDeniedBody({ language = 'en' }) {
  if (language === 'pt-BR') {
    return [
      DENIED_MARKER,
      '### PR Explainer AI',
      'Somente usuários com permissão de escrita, manutenção ou administração podem solicitar `/explain`.'
    ].join('\n');
  }
  return [
    DENIED_MARKER,
    '### PR Explainer AI',
    'Only users with write, maintain, or admin permission can request `/explain`.'
  ].join('\n');
}

async function runAction(command, args, env = process.env) {
  const event = readJsonFile(env.GITHUB_EVENT_PATH);
  const language = env.INPUT_LANGUAGE || env.EXPLAINER_LANGUAGE || 'en';
  const token = env.GITHUB_TOKEN || env.INPUT_GITHUB_TOKEN || '';

  if (command === 'resolve') {
    const modeOverride = env.INPUT_MODE || 'auto';
    let client = null;
    if (token) {
      client = createGitHubClient({ token, apiUrl: env.GITHUB_API_URL });
    }

    const result = await resolveLifecycleContext({
      eventName: env.GITHUB_EVENT_NAME,
      event,
      client,
      env,
      modeOverride
    });

    const context = buildContextFile(result, env);
    const contextFile = args['context-file'] || env.PR_CONTEXT_FILE || '';
    writeJsonFile(contextFile, context);

    writeGithubOutputs(args.output || env.GITHUB_OUTPUT, {
      mode: result.mode,
      reason: result.reason || '',
      pr_number: context.prNumber,
      pr_title: context.prTitle,
      head_sha: context.headSha,
      base_ref: context.baseRef,
      base_sha: context.baseSha,
      commit_sha: context.commitSha,
      context_file: contextFile,
      should_generate: result.mode === 'generate' ? 'true' : 'false',
      should_mark_outdated: result.mode === 'outdated' ? 'true' : 'false',
      permission_denied: result.mode === 'denied' ? 'true' : 'false'
    });

    console.log(`Lifecycle mode: ${result.mode}${result.reason ? ` (${result.reason})` : ''}`);
    return result;
  }

  const context = readJsonFile(args['context-file'] || env.PR_CONTEXT_FILE);
  const owner = context.repoOwner || String(env.GITHUB_REPOSITORY || '').split('/')[0];
  const repo = context.repoName || String(env.GITHUB_REPOSITORY || '').split('/')[1];
  const issueNumber = Number(context.prNumber || env.PR_NUMBER || 0);

  if (!token) {
    throw new Error('GITHUB_TOKEN is required for lifecycle comment operations.');
  }
  if (!owner || !repo || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('A valid PR context is required for lifecycle comment operations.');
  }

  const client = createGitHubClient({ token, apiUrl: env.GITHUB_API_URL });

  if (command === 'comment') {
    const bodyPath = args['body-file'] || env.MARKDOWN_OUTPUT_FILE;
    if (!bodyPath || !existsSync(bodyPath)) {
      throw new Error(`Markdown comment file not found: ${bodyPath}`);
    }
    const body = readFileSync(bodyPath, 'utf8').trim();
    if (!body) throw new Error('Markdown comment file is empty.');
    const result = await postOrUpdateComment(client, {
      owner,
      repo,
      issueNumber,
      body,
      marker: args.marker || undefined
    });
    console.log(`PR comment ${result.action}: ${result.commentId}`);
    return result;
  }

  if (command === 'outdated') {
    const marked = await markCommentOutdated(client, {
      owner,
      repo,
      issueNumber,
      newHeadSha: context.headSha || env.GITHUB_SHA || '',
      language
    });
    return { marked };
  }

  if (command === 'skip') {
    const body = buildSkipBody({
      language,
      linesChanged: env.LINES_CHANGED || '0',
      maxLines: env.MAX_LINES || '15000',
      diffEmpty: env.DIFF_EMPTY === 'true'
    });
    return postOrUpdateComment(client, {
      owner,
      repo,
      issueNumber,
      body,
      marker: SKIP_MARKER
    });
  }

  if (command === 'denied') {
    return postOrUpdateComment(client, {
      owner,
      repo,
      issueNumber,
      body: buildDeniedBody({ language }),
      marker: DENIED_MARKER
    });
  }

  throw new Error(`Unknown action command: ${command}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  try {
    if (!command) {
      throw new Error('Usage: action.js <resolve|comment|outdated|skip|denied> [options]');
    }
    await runAction(command, args, process.env);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SKIP_MARKER,
  DENIED_MARKER,
  parseArgs,
  readJsonFile,
  writeJsonFile,
  writeGithubOutputs,
  buildContextFile,
  buildSkipBody,
  buildDeniedBody,
  runAction
};
