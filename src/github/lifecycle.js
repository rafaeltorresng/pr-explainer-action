const {
  COMMENT_MARKER,
  SKIP_COMMENT_MARKER,
  DENIED_COMMENT_MARKER,
  EXPLAINER_COMMENT_MARKERS,
  generateOutdatedComment
} = require('../render/markdown-comment');

function permissionAllowsExplain(permission) {
  return permission === 'admin' || permission === 'write' || permission === 'maintain';
}

/**
 * Resolves the login that owns comments created by this Action. With the
 * default GITHUB_TOKEN this is the GitHub Actions bot; with a PAT it is the
 * token owner. Returning null makes callers fall back to bot-authored comments
 * only, which fails closed for spoofed user comments.
 */
async function resolveAuthenticatedLogin(octokit) {
  if (
    !octokit ||
    !octokit.rest ||
    !octokit.rest.users ||
    typeof octokit.rest.users.getAuthenticated !== 'function'
  ) {
    return null;
  }

  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return data && data.login ? String(data.login) : null;
  } catch (error) {
    console.warn(`Could not resolve authenticated GitHub login: ${error.message}`);
    return null;
  }
}

function containsExplainerMarker(body, markers) {
  if (!body) return false;
  const text = String(body);
  return markers.some((marker) => text.includes(marker));
}

function isOwnComment(comment, authorLogin) {
  const user = comment && comment.user;
  if (!user) return false;
  if (authorLogin) {
    return String(user.login || '') === authorLogin;
  }
  // Without a resolvable identity, only accept bot comments. This prevents a
  // third-party comment containing the marker from hijacking the update path.
  return user.type === 'Bot';
}

async function listOwnExplainerComments(
  octokit,
  owner,
  repo,
  issueNumber,
  { authorLogin = null } = {}
) {
  const matches = [];

  try {
    for (let page = 1; page <= 10; page += 1) {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page
      });

      for (const comment of comments || []) {
        if (!isOwnComment(comment, authorLogin)) continue;
        if (containsExplainerMarker(comment.body, EXPLAINER_COMMENT_MARKERS)) {
          matches.push({ id: comment.id, body: comment.body });
        }
      }
      if (!Array.isArray(comments) || comments.length < 100) break;
    }
  } catch (error) {
    console.warn(`Could not list issue comments: ${error.message}`);
  }

  return matches;
}

async function findExistingExplainerComment(
  octokit,
  owner,
  repo,
  issueNumber,
  marker = COMMENT_MARKER,
  { authorLogin = null } = {}
) {
  const markers = Array.isArray(marker) ? marker : [marker];
  const comments = await listOwnExplainerComments(
    octokit,
    owner,
    repo,
    issueNumber,
    { authorLogin }
  );
  return comments.find((comment) => containsExplainerMarker(comment.body, markers)) || null;
}

async function deleteExplainerComment(octokit, owner, repo, commentId) {
  if (
    !octokit ||
    !octokit.rest ||
    !octokit.rest.issues ||
    typeof octokit.rest.issues.deleteComment !== 'function'
  ) {
    return false;
  }

  try {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId
    });
    console.log(`Removed superseded PR Explainer comment (id: ${commentId}).`);
    return true;
  } catch (error) {
    console.warn(`Could not remove superseded comment ${commentId}: ${error.message}`);
    return false;
  }
}

async function postOrUpdateComment(
  octokit,
  { owner, repo, issueNumber, body, marker = COMMENT_MARKER, authorLogin = null }
) {
  const ownerLogin = authorLogin || await resolveAuthenticatedLogin(octokit);
  const comments = await listOwnExplainerComments(
    octokit,
    owner,
    repo,
    issueNumber,
    { authorLogin: ownerLogin }
  );

  const explanations = comments.filter((comment) =>
    containsExplainerMarker(comment.body, [COMMENT_MARKER])
  );
  const statusNotices = comments.filter((comment) =>
    containsExplainerMarker(comment.body, [SKIP_COMMENT_MARKER, DENIED_COMMENT_MARKER])
  );
  const isStatusNotice = marker === SKIP_COMMENT_MARKER || marker === DENIED_COMMENT_MARKER;

  let existing = null;
  let superseded = [];

  if (isStatusNotice) {
    // A skip/denied notice must never replace a valid explanation. Only another
    // status notice is safe to update in place.
    existing = statusNotices[0] || null;
    superseded = statusNotices.slice(1);
  } else if (explanations.length > 0) {
    existing = explanations[0];
    superseded = [...explanations.slice(1), ...statusNotices];
  } else {
    // No explanation exists yet: reuse the status comment so a later successful
    // run does not leave a stale skip/denied notice behind.
    existing = statusNotices[0] || null;
    superseded = statusNotices.slice(1);
  }

  if (existing) {
    console.log(`Updating existing PR Explainer comment (id: ${existing.id})...`);
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body
    });
    for (const comment of superseded) {
      await deleteExplainerComment(octokit, owner, repo, comment.id);
    }
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

async function markCommentOutdated(
  octokit,
  { owner, repo, issueNumber, newHeadSha, language = 'en', authorLogin = null }
) {
  const ownerLogin = authorLogin || await resolveAuthenticatedLogin(octokit);
  const existing = await findExistingExplainerComment(
    octokit,
    owner,
    repo,
    issueNumber,
    COMMENT_MARKER,
    { authorLogin: ownerLogin }
  );
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
  EXPLAINER_COMMENT_MARKERS,
  LIFECYCLE_MODES,
  permissionAllowsExplain,
  resolveAuthenticatedLogin,
  findExistingExplainerComment,
  postOrUpdateComment,
  markCommentOutdated,
  verifyExplainPermission,
  parseExplainCommand,
  getRepoFromEvent,
  resolveLifecycleContext
};
