const { describe, expect, test } = require('bun:test');
const { mkdtempSync, existsSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const {
  findExistingExplainerComment,
  postOrUpdateComment,
  markCommentOutdated,
  verifyExplainPermission,
  parseExplainCommand,
  resolveLifecycleContext,
  permissionAllowsExplain
} = require('../src/github/lifecycle');

const {
  getPagesUrl,
  preparePagesFile
} = require('../src/github/pages');

describe('parseExplainCommand', () => {
  test('recognizes /explain command variants', () => {
    expect(parseExplainCommand('/explain')).toBe(true);
    expect(parseExplainCommand('/explain please')).toBe(true);
    expect(parseExplainCommand('   /explain\n')).toBe(true);
    expect(parseExplainCommand('/EXPLAIN')).toBe(true);
  });

  test('ignores comments that do not start with /explain', () => {
    expect(parseExplainCommand('can you /explain this?')).toBe(false);
    expect(parseExplainCommand('looks good to me')).toBe(false);
    expect(parseExplainCommand('')).toBe(false);
    expect(parseExplainCommand(null)).toBe(false);
  });
});

describe('verifyExplainPermission', () => {
  test('grants access to collaborators with admin or write permissions', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async ({ username }) => {
            if (username === 'maintainer') return { data: { permission: 'write' } };
            if (username === 'admin_user') return { data: { permission: 'admin' } };
            return { data: { permission: 'read' } };
          }
        }
      }
    };

    expect(await verifyExplainPermission(mockOctokit, { owner: 'o', repo: 'r', username: 'maintainer' })).toBe(true);
    expect(await verifyExplainPermission(mockOctokit, { owner: 'o', repo: 'r', username: 'admin_user' })).toBe(true);
    expect(await verifyExplainPermission(mockOctokit, { owner: 'o', repo: 'r', username: 'outsider' })).toBe(false);
  });

  test('fails closed when API call errors', async () => {
    const errorOctokit = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            throw new Error('GitHub API rate limit exceeded');
          }
        }
      }
    };

    const allowed = await verifyExplainPermission(errorOctokit, { owner: 'o', repo: 'r', username: 'anyone' });
    expect(allowed).toBe(false);
  });
});

describe('idempotent comment management', () => {
  test('creates new comment when no previous explainer comment exists', async () => {
    let createdComment = null;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [{ id: 101, body: 'regular user comment' }] }),
          createComment: async ({ body }) => {
            createdComment = body;
            return { data: { id: 202 } };
          }
        }
      }
    };

    const res = await postOrUpdateComment(mockOctokit, {
      owner: 'o',
      repo: 'r',
      issueNumber: 42,
      body: '<!-- pr-explainer-comment -->\n### PR Explainer AI\nNew content'
    });

    expect(res.action).toBe('created');
    expect(res.commentId).toBe(202);
    expect(createdComment).toContain('New content');
  });

  test('updates existing comment when marker is found without creating duplicate', async () => {
    let updatedId = null;
    let updatedBody = null;
    let createCalled = false;

    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 101, body: 'regular user comment' },
              { id: 303, body: '<!-- pr-explainer-comment -->\n### PR Explainer AI\nOld content' }
            ]
          }),
          updateComment: async ({ comment_id, body }) => {
            updatedId = comment_id;
            updatedBody = body;
            return { data: { id: comment_id } };
          },
          createComment: async () => {
            createCalled = true;
          }
        }
      }
    };

    const res = await postOrUpdateComment(mockOctokit, {
      owner: 'o',
      repo: 'r',
      issueNumber: 42,
      body: '<!-- pr-explainer-comment -->\n### PR Explainer AI\nUpdated content'
    });

    expect(res.action).toBe('updated');
    expect(res.commentId).toBe(303);
    expect(updatedId).toBe(303);
    expect(updatedBody).toContain('Updated content');
    expect(createCalled).toBe(false);
  });

  test('markCommentOutdated prefixes warning without re-running inference', async () => {
    let updatedBody = null;

    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 404, body: '<!-- pr-explainer-comment -->\n### PR Explainer AI\nValid analysis' }
            ]
          }),
          updateComment: async ({ body }) => {
            updatedBody = body;
            return { data: { id: 404 } };
          }
        }
      }
    };

    const marked = await markCommentOutdated(mockOctokit, {
      owner: 'o',
      repo: 'r',
      issueNumber: 42,
      newHeadSha: 'abcdef1234567890',
      language: 'en'
    });

    expect(marked).toBe(true);
    expect(updatedBody).toContain('[!WARNING]');
    expect(updatedBody).toContain('abcdef1');
    expect(updatedBody).toContain('Valid analysis');
  });
});

describe('pages publishing helper', () => {
  test('never infers a Pages URL from owner, repo, or PR number alone', () => {
    const url = getPagesUrl({ repoOwner: 'acme-corp', repoName: 'awesome-lib', prNumber: 42 });
    expect(url).toBeNull();
  });

  test('builds a stable Pages URL only from an explicit https base URL', () => {
    const url = getPagesUrl({ baseUrl: 'https://acme-corp.github.io/awesome-lib', prNumber: 42 });
    expect(url).toBe('https://acme-corp.github.io/awesome-lib/pr-explains/pr-42/');
  });

  test('rejects non-https base URLs and invalid PR numbers', () => {
    expect(getPagesUrl({ baseUrl: 'http://acme-corp.github.io/awesome-lib', prNumber: 42 })).toBeNull();
    expect(() => getPagesUrl({ baseUrl: 'https://acme-corp.github.io/awesome-lib', prNumber: '../42' })).toThrow(
      /Invalid PR number/
    );
  });

  test('preparePagesFile places HTML into dedicated PR subfolder', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pages-test-'));
    const sourceHtml = join(tempDir, 'source.html');
    writeFileSync(sourceHtml, '<html><body>PR Explanation</body></html>', 'utf8');

    const distDir = join(tempDir, 'gh-pages-dist');
    const targetFile = preparePagesFile({
      generatedHtmlPath: sourceHtml,
      pagesDistDir: distDir,
      prNumber: 42
    });

    expect(existsSync(targetFile)).toBe(true);
    expect(targetFile).toContain('pr-explains/pr-42/index.html');
    expect(readFileSync(targetFile, 'utf8')).toContain('PR Explanation');
  });
});

describe('event lifecycle resolution', () => {
  const repo = { owner: 'acme', name: 'project' };
  const baseEvent = {
    repository: { owner: { login: 'acme' }, name: 'project' },
    pull_request: {
      number: 17,
      title: 'Fix retry handling',
      body: 'Author body',
      head: { sha: 'abcdef1234567890' },
      base: { ref: 'main', sha: '1234567890abcdef' }
    }
  };

  test('generates on opened and marks synchronize/edited as outdated', async () => {
    const opened = await resolveLifecycleContext({
      eventName: 'pull_request_target',
      event: { ...baseEvent, action: 'opened' },
      env: {}
    });
    expect(opened.mode).toBe('generate');
    expect(opened.prNumber).toBe('17');
    expect(opened.headSha).toBe('abcdef1234567890');
    expect(opened.baseRef).toBe('main');
    expect(opened.repoOwner).toBe('acme');

    for (const action of ['synchronize', 'edited']) {
      const result = await resolveLifecycleContext({
        eventName: 'pull_request_target',
        event: { ...baseEvent, action },
        env: {}
      });
      expect(result.mode).toBe('outdated');
    }
  });

  test('skips unsupported pull_request actions and non-PR comments', async () => {
    const closed = await resolveLifecycleContext({
      eventName: 'pull_request_target',
      event: { ...baseEvent, action: 'closed' },
      env: {}
    });
    expect(closed.mode).toBe('skip');

    const issue = await resolveLifecycleContext({
      eventName: 'issue_comment',
      event: {
        action: 'created',
        repository: baseEvent.repository,
        issue: { number: 17, title: 'Issue' },
        comment: { body: '/explain', user: { login: 'alice', type: 'User' } }
      },
      client: {},
      env: {}
    });
    expect(issue.mode).toBe('skip');
    expect(issue.reason).toContain('not on a pull request');
  });

  test('denies /explain from users without write permission and generates for maintainers', async () => {
    const issueEvent = {
      action: 'created',
      repository: baseEvent.repository,
      issue: { number: 17, title: 'Fix retry handling', pull_request: {} },
      comment: { body: '/explain', user: { login: 'outsider', type: 'User' } }
    };
    const denied = await resolveLifecycleContext({
      eventName: 'issue_comment',
      event: issueEvent,
      client: {
        rest: {
          repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) }
        }
      },
      env: {}
    });
    expect(denied.mode).toBe('denied');
    expect(denied.prNumber).toBe('17');

    const authorized = await resolveLifecycleContext({
      eventName: 'issue_comment',
      event: {
        ...issueEvent,
        comment: { body: '  /explain', user: { login: 'maintainer', type: 'User' } }
      },
      client: {
        rest: {
          repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'maintain' } }) },
          pulls: {
            get: async () => ({
              data: {
                state: 'open',
                number: 17,
                title: 'Fix retry handling',
                body: 'Author body',
                head: { sha: 'fedcba0987654321' },
                base: { ref: 'main', sha: '1234567890abcdef' }
              }
            })
          }
        }
      },
      env: {}
    });
    expect(authorized.mode).toBe('generate');
    expect(authorized.requestedBy).toBe('maintainer');
    expect(authorized.headSha).toBe('fedcba0987654321');
  });

  test('mode override cannot bypass /explain authorization on issue_comment', async () => {
    const denied = await resolveLifecycleContext({
      eventName: 'issue_comment',
      event: {
        action: 'created',
        repository: baseEvent.repository,
        issue: { number: 17, title: 'Fix', pull_request: {} },
        comment: { body: '/explain', user: { login: 'outsider', type: 'User' } }
      },
      client: {
        rest: {
          repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) }
        }
      },
      env: {},
      modeOverride: 'generate'
    });
    expect(denied.mode).toBe('denied');
  });

  test('explicit generate mode works for CI events and rejects unknown modes', async () => {
    const result = await resolveLifecycleContext({
      eventName: 'push',
      event: { repository: baseEvent.repository },
      env: {
        GITHUB_SHA: '1111111111111111',
        INPUT_BASE_REF: 'main',
        PR_NUMBER: '0'
      },
      modeOverride: 'generate'
    });
    expect(result.mode).toBe('generate');
    expect(result.headSha).toBe('1111111111111111');
    expect(result.baseRef).toBe('main');

    await expect(resolveLifecycleContext({
      eventName: 'push',
      event: {},
      env: {},
      modeOverride: 'explode'
    })).rejects.toThrow(/Unsupported lifecycle mode/);
  });

  test('permission helpers accept write, maintain, and admin only', () => {
    expect(permissionAllowsExplain('admin')).toBe(true);
    expect(permissionAllowsExplain('maintain')).toBe(true);
    expect(permissionAllowsExplain('write')).toBe(true);
    expect(permissionAllowsExplain('triage')).toBe(false);
    expect(permissionAllowsExplain('read')).toBe(false);
  });
});
