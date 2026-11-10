const { describe, expect, test } = require('bun:test');
const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { runAction, buildSkipBody, SKIP_MARKER, DENIED_MARKER } = require('../src/github/action');
const { COMMENT_MARKER } = require('../src/render/markdown-comment');
const { createGitHubClient } = require('../src/github/client');

function startMockGitHub(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', async () => {
      let parsedBody = null;
      if (rawBody) {
        try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
      }
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody
      };
      requests.push(record);

      let result;
      try {
        result = await handler(record);
      } catch (error) {
        result = { status: 500, body: { message: error.message } };
      }
      const status = (result && result.status) || 200;
      const body = (result && Object.prototype.hasOwnProperty.call(result, 'body')) ? result.body : {};
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({
        server,
        requests,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function eventFile(event) {
  const dir = mkdtempSync(join(tmpdir(), 'action-e2e-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(event), 'utf8');
  return { dir, path };
}

function parseOutputs(path) {
  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function pullRequestEvent(action, overrides = {}) {
  return {
    action,
    repository: { owner: { login: 'acme' }, name: 'project' },
    pull_request: {
      number: 17,
      title: 'Fix retry handling',
      body: 'Author body',
      head: { sha: 'abcdef1234567890' },
      base: { ref: 'main', sha: '1234567890abcdef' },
      ...overrides
    }
  };
}

function issueCommentEvent({ login = 'maintainer', body = '/explain' } = {}) {
  return {
    action: 'created',
    repository: { owner: { login: 'acme' }, name: 'project' },
    issue: { number: 17, title: 'Fix retry handling', pull_request: {} },
    comment: { body, user: { login, type: 'User' } }
  };
}

describe('runAction end-to-end with a mocked GitHub API', () => {
  test('resolve writes generate outputs and a context file for pull_request_target.opened', async () => {
    const { dir, path } = eventFile(pullRequestEvent('opened'));
    const outputPath = join(dir, 'outputs.txt');
    const contextPath = join(dir, 'context.json');

    const result = await runAction('resolve', {
      output: outputPath,
      'context-file': contextPath
    }, {
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_EVENT_PATH: path,
      INPUT_MODE: 'auto'
    });

    expect(result.mode).toBe('generate');
    const outputs = parseOutputs(outputPath);
    expect(outputs.mode).toBe('generate');
    expect(outputs.should_generate).toBe('true');
    expect(outputs.should_mark_outdated).toBe('false');
    expect(outputs.permission_denied).toBe('false');
    expect(outputs.pr_number).toBe('17');
    expect(outputs.head_sha).toBe('abcdef1234567890');
    expect(outputs.context_file).toBe(contextPath);

    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    expect(context).toMatchObject({
      mode: 'generate',
      prNumber: '17',
      prTitle: 'Fix retry handling',
      commitSha: 'abcdef1234567890',
      repoOwner: 'acme',
      repoName: 'project'
    });
  });

  test('synchronize resolves to outdated and PATCHes the existing comment over HTTP', async () => {
    const { dir, path } = eventFile(pullRequestEvent('synchronize'));
    const contextPath = join(dir, 'context.json');
    const outputPath = join(dir, 'outputs.txt');

    const mock = await startMockGitHub((request) => {
      if (request.method === 'GET' && request.url.startsWith('/repos/acme/project/issues/17/comments')) {
        return { body: [{ id: 303, body: `${COMMENT_MARKER}\n### PR Explainer AI\nPrevious analysis` }] };
      }
      if (request.method === 'PATCH' && request.url === '/repos/acme/project/issues/comments/303') {
        return { body: { id: 303 } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    try {
      const env = {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: path,
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: mock.baseUrl,
        INPUT_MODE: 'auto'
      };

      const resolved = await runAction('resolve', {
        output: outputPath,
        'context-file': contextPath
      }, env);
      expect(resolved.mode).toBe('outdated');
      expect(parseOutputs(outputPath).should_mark_outdated).toBe('true');

      const result = await runAction('outdated', { 'context-file': contextPath }, env);
      expect(result.marked).toBe(true);

      const patch = mock.requests.find((request) => request.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(patch.headers.authorization).toBe('Bearer test-token');
      expect(patch.headers['x-github-api-version']).toBe('2022-11-28');
      expect(patch.body.body).toContain('[!WARNING]');
      expect(patch.body.body).toContain('abcdef1');
      expect(patch.body.body).toContain('Previous analysis');
    } finally {
      await mock.close();
    }
  });

  test('denied /explain resolves to denied and posts a denial notice', async () => {
    const { dir, path } = eventFile(issueCommentEvent({ login: 'outsider' }));
    const contextPath = join(dir, 'context.json');
    const outputPath = join(dir, 'outputs.txt');

    const mock = await startMockGitHub((request) => {
      if (request.method === 'GET' && request.url === '/repos/acme/project/collaborators/outsider/permission') {
        return { body: { permission: 'read' } };
      }
      if (request.method === 'GET' && request.url.startsWith('/repos/acme/project/issues/17/comments')) {
        return { body: [] };
      }
      if (request.method === 'POST' && request.url === '/repos/acme/project/issues/17/comments') {
        return { status: 201, body: { id: 500 } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    try {
      const env = {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: path,
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: mock.baseUrl
      };

      const resolved = await runAction('resolve', {
        output: outputPath,
        'context-file': contextPath
      }, env);
      expect(resolved.mode).toBe('denied');
      expect(parseOutputs(outputPath).permission_denied).toBe('true');

      const result = await runAction('denied', { 'context-file': contextPath }, env);
      expect(result.action).toBe('created');
      expect(result.commentId).toBe(500);

      const created = mock.requests.find((request) => request.method === 'POST');
      expect(created.body.body).toContain(DENIED_MARKER);
      expect(created.body.body).toContain('Only users with write, maintain, or admin permission');
    } finally {
      await mock.close();
    }
  });

  test('authorized /explain loads the PR and resolves to generate', async () => {
    const { dir, path } = eventFile(issueCommentEvent({ login: 'maintainer' }));
    const contextPath = join(dir, 'context.json');
    const outputPath = join(dir, 'outputs.txt');

    const mock = await startMockGitHub((request) => {
      if (request.method === 'GET' && request.url === '/repos/acme/project/collaborators/maintainer/permission') {
        return { body: { permission: 'write' } };
      }
      if (request.method === 'GET' && request.url === '/repos/acme/project/pulls/17') {
        return {
          body: {
            state: 'open',
            number: 17,
            title: 'Fix retry handling',
            body: 'Author body',
            head: { sha: 'fedcba0987654321' },
            base: { ref: 'main', sha: '1234567890abcdef' }
          }
        };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    try {
      const result = await runAction('resolve', {
        output: outputPath,
        'context-file': contextPath
      }, {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: path,
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: mock.baseUrl
      });

      expect(result.mode).toBe('generate');
      expect(result.requestedBy).toBe('maintainer');
      expect(result.headSha).toBe('fedcba0987654321');
      expect(parseOutputs(outputPath).should_generate).toBe('true');
      expect(mock.requests.map((request) => request.url)).toEqual([
        '/repos/acme/project/collaborators/maintainer/permission',
        '/repos/acme/project/pulls/17'
      ]);
    } finally {
      await mock.close();
    }
  });

  test('comment command creates once and updates the same comment on the next run', async () => {
    const { dir } = eventFile({});
    const contextPath = join(dir, 'context.json');
    writeFileSync(contextPath, JSON.stringify({
      mode: 'generate',
      prNumber: '17',
      repoOwner: 'acme',
      repoName: 'project'
    }), 'utf8');
    const bodyPath = join(dir, 'comment.md');
    writeFileSync(bodyPath, `${COMMENT_MARKER}\n### PR Explainer AI\nNew analysis`, 'utf8');

    let storedComment = null;
    const mock = await startMockGitHub((request) => {
      if (request.method === 'GET' && request.url.startsWith('/repos/acme/project/issues/17/comments')) {
        return { body: storedComment ? [storedComment] : [] };
      }
      if (request.method === 'POST' && request.url === '/repos/acme/project/issues/17/comments') {
        storedComment = { id: 900, body: request.body.body };
        return { status: 201, body: storedComment };
      }
      if (request.method === 'PATCH' && request.url === '/repos/acme/project/issues/comments/900') {
        storedComment = { id: 900, body: request.body.body };
        return { body: storedComment };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    try {
      const env = {
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: mock.baseUrl
      };

      const first = await runAction('comment', {
        'context-file': contextPath,
        'body-file': bodyPath
      }, env);
      expect(first).toEqual({ action: 'created', commentId: 900 });

      const second = await runAction('comment', {
        'context-file': contextPath,
        'body-file': bodyPath
      }, env);
      expect(second).toEqual({ action: 'updated', commentId: 900 });

      expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      expect(mock.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  test('skip notice distinguishes an empty diff from an oversized diff', () => {
    const emptyEn = buildSkipBody({ language: 'en', diffEmpty: true });
    expect(emptyEn).toContain(SKIP_MARKER);
    expect(emptyEn).toContain('no code changes to analyze');
    expect(emptyEn).not.toContain('exceeds the limit');

    const emptyPt = buildSkipBody({ language: 'pt-BR', diffEmpty: true });
    expect(emptyPt).toContain('não contém alterações de código');
    expect(emptyPt).not.toContain('excedem o limite');
  });

  test('skip command posts a skip notice with its own marker', async () => {
    const { dir } = eventFile({});
    const contextPath = join(dir, 'context.json');
    writeFileSync(contextPath, JSON.stringify({
      mode: 'generate',
      prNumber: '17',
      repoOwner: 'acme',
      repoName: 'project'
    }), 'utf8');

    const mock = await startMockGitHub((request) => {
      if (request.method === 'GET' && request.url.startsWith('/repos/acme/project/issues/17/comments')) {
        return { body: [] };
      }
      if (request.method === 'POST' && request.url === '/repos/acme/project/issues/17/comments') {
        return { status: 201, body: { id: 700 } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    try {
      const result = await runAction('skip', { 'context-file': contextPath }, {
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: mock.baseUrl,
        LINES_CHANGED: '20000',
        MAX_LINES: '15000'
      });
      expect(result).toEqual({ action: 'created', commentId: 700 });

      const created = mock.requests.find((request) => request.method === 'POST');
      expect(created.body.body).toContain(SKIP_MARKER);
      expect(created.body.body).toContain('20000 changed lines exceeds the limit of 15000');
    } finally {
      await mock.close();
    }
  });

  test('GitHub client requires a token and surfaces API failures', async () => {
    expect(() => createGitHubClient({ token: '' })).toThrow(/token is required/);

    const mock = await startMockGitHub(() => ({
      status: 403,
      body: { message: 'Resource not accessible by integration' }
    }));
    try {
      const client = createGitHubClient({ token: 'test-token', apiUrl: mock.baseUrl });
      await expect(client.rest.issues.listComments({
        owner: 'acme',
        repo: 'project',
        issue_number: 17
      })).rejects.toThrow(/status 403: Resource not accessible by integration/);
    } finally {
      await mock.close();
    }
  });
});
