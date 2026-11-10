const { COMMENT_MARKER, generateOutdatedComment } = require('../render/markdown-comment');

function permissionAllowsExplain(permission) {
  return permission === 'admin' || permission === 'write' || permission === 'maintain';
}

async function findExistingExplainerComment(octokit, owner, repo, issueNumber, marker = COMMENT_MARKER) {
  try {
    for (let page = 1; page <= 10; page += 1) {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page
      });

      const match = (comments || []).find((comment) => comment.body && comment.body.includes(marker));
      if (match) {
        return { id: match.id, body: match.body };
      }
      if (!Array.isArray(comments) || comments.length < 100) break;
    }
  } catch (error) {
    console.warn(`Could not list issue comments: ${error.message}`);
  }
  return null;
}

async function postOrUpdateComment(octokit, { owner, repo, issueNumber, body, marker = COMMENT_MARKER }) {
  const existing = await findExistingExplainerComment(octokit, owner, repo, issueNumber, marker);

  if (existing) {
    console.log(`Updating existing PR Explainer comment (id: ${existing.id})...`);
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body
    });
    return { action: 'updated', commentId: existing.id };
  }

  console.log('Creating new PR Explainer comment...');
  const { data: created } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
  return { action: 'created', commentId: created.id };
}

async function markCommentOutdated(octokit, { owner, repo, issueNumber, newHeadSha, language = 'en' }) {
  const existing = await findExistingExplainerComment(octokit, owner, repo, issueNumber);
  if (!existing) {
    console.log('No existing PR Explainer comment found to mark outdated.');
    return false;
  }

  const updatedBody = generateOutdatedComment(existing.body, newHeadSha, language);
  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: existing.id,
    body: updatedBody
  });
  console.log(`Marked PR Explainer comment ${existing.id} as outdated for HEAD ${newHeadSha}.`);
  return true;
}

async function verifyExplainPermission(octokit, { owner, repo, username }) {
  if (!username) return false;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username
    });

    const permission = data.permission;
    const allowed = permissionAllowsExplain(permission);
    if (!allowed) {
      console.warn(`User ${username} permission "${permission}" is insufficient to trigger /explain.`);
    }
    return allowed;
  } catch (error) {
    // Fail closed.
    console.warn(`Failed to verify permission level for ${username}: ${error.message}`);
    return false;
  }
}

function parseExplainCommand(commentBody) {
  if (!commentBody) return false;
  const trimmed = String(commentBody).trim();
  return /^\/explain(?:\s|$)/i.test(trimmed);
}

function getRepoFromEvent(event, env = process.env) {
  if (event && event.repository && event.repository.owner) {
    const owner = event.repository.owner.login || event.repository.owner.name || '';
    const name = event.repository.name || '';
    if (owner && name) return { owner, repo: name };
  }

  const repository = env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  return { owner: owner || '', repo: repo || '' };
}

function baseContextFromPullRequest(pullRequest, repo) {
  return {
    prNumber: String(pullRequest.number || ''),
    prTitle: String(pullRequest.title || ''),
    prBody: String(pullRequest.body || '').slice(0, 8000),
    headSha: pullRequest.head && pullRequest.head.sha ? String(pullRequest.head.sha) : '',
    baseRef: pullRequest.base && pullRequest.base.ref ? String(pullRequest.base.ref) : '',
    baseSha: pullRequest.base && pullRequest.base.sha ? String(pullRequest.base.sha) : '',
    repoOwner: repo.owner,
    repoName: repo.repo
  };
}

/**
 * Resolves the event into one of four modes:
 * - generate: run inference for this PR.
 * - outdated: only mark the previous comment as outdated.
 * - denied: an unauthorized /explain request (no inference).
 * - skip: event is irrelevant.
 */
const LIFECYCLE_MODES = ['auto', 'generate', 'outdated', 'skip'];

async function resolveLifecycleContext({ eventName, event, client, env = process.env, modeOverride = 'auto' }) {
  const repo = getRepoFromEvent(event, env);
  const requestedMode = String(modeOverride || 'auto').trim().toLowerCase();

  if (!LIFECYCLE_MODES.includes(requestedMode)) {
    throw new Error(
      `Unsupported lifecycle mode "${modeOverride}". Supported values: ${LIFECYCLE_MODES.join(', ')}.`
    );
  }

  // A mode override is intended for CI/dry runs. It must never bypass the
  // authorization and /explain checks for comment-triggered inference.
  if (requestedMode !== 'auto' && eventName !== 'issue_comment') {
    const pullRequest = event && event.pull_request;
    const context = pullRequest
      ? baseContextFromPullRequest(pullRequest, repo)
      : {
        prNumber: String(env.PR_NUMBER || '0'),
        prTitle: String(env.PR_TITLE || 'Code Changes'),
        prBody: String(env.PR_BODY || '').slice(0, 8000),
        headSha: String(env.PR_HEAD_SHA || env.GITHUB_SHA || ''),
        baseRef: String(env.INPUT_BASE_REF || env.GITHUB_BASE_REF || 'main'),
        baseSha: '',
        repoOwner: repo.owner,
        repoName: repo.repo
      };
    return {
      ...context,
      mode: requestedMode,
      reason: 'Explicit lifecycle mode override'
    };
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pullRequest = event && event.pull_request;
    if (!pullRequest) {
      return { mode: 'skip', reason: 'Missing pull_request payload', ...repo };
    }

    const context = baseContextFromPullRequest(pullRequest, repo);
    const action = event.action;

    if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
      return { ...context, mode: 'generate', reason: `pull_request.${action}` };
    }
    if (action === 'synchronize' || action === 'edited') {
      return { ...context, mode: 'outdated', reason: `pull_request.${action}` };
    }

    return { ...context, mode: 'skip', reason: `Unsupported pull_request action: ${action}` };
  }

  if (eventName === 'issue_comment') {
    if (!event || event.action !== 'created') {
      return { mode: 'skip', reason: `Unsupported issue_comment action: ${event && event.action}` };
    }

    const issue = event.issue;
    const comment = event.comment;
    if (!issue || !issue.pull_request) {
      return { mode: 'skip', reason: 'Comment is not on a pull request' };
    }
    if (!comment || !comment.user || comment.user.type === 'Bot') {
      return { mode: 'skip', reason: 'Comment is from a bot or has no author' };
    }
    if (!parseExplainCommand(comment.body)) {
      return { mode: 'skip', reason: 'Comment is not an /explain command' };
    }
    if (!client) {
      return { mode: 'skip', reason: 'GitHub client is required to resolve /explain' };
    }

    const issueNumber = Number(issue.number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { mode: 'skip', reason: 'Invalid pull request number' };
    }

    const allowed = await verifyExplainPermission(client, {
      owner: repo.owner,
      repo: repo.repo,
      username: comment.user.login
    });

    if (!allowed) {
      return {
        mode: 'denied',
        reason: `User ${comment.user.login} does not have write access`,
        prNumber: String(issueNumber),
        prTitle: String(issue.title || ''),
        repoOwner: repo.owner,
        repoName: repo.repo
      };
    }

    try {
      const { data: pullRequest } = await client.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: issueNumber
      });

      if (!pullRequest || pullRequest.state !== 'open') {
        return { mode: 'skip', reason: 'Pull request is not open', ...repo };
      }

      return {
        ...baseContextFromPullRequest(pullRequest, repo),
        mode: 'generate',
        reason: `Authorized /explain by ${comment.user.login}`,
        requestedBy: comment.user.login
      };
    } catch (error) {
      return {
        mode: 'skip',
        reason: `Could not load pull request: ${error.message}`,
        ...repo
      };
    }
  }

  return { mode: 'skip', reason: `Unsupported event: ${eventName}`, ...repo };
}

module.exports = {
  COMMENT_MARKER,
  LIFECYCLE_MODES,
  permissionAllowsExplain,
  findExistingExplainerComment,
  postOrUpdateComment,
  markCommentOutdated,
  verifyExplainPermission,
  parseExplainCommand,
  getRepoFromEvent,
  resolveLifecycleContext
};
