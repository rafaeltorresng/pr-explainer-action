function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createGitHubClient({
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch
}) {
  if (!token) {
    throw new Error('A GitHub token is required for lifecycle operations.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available for GitHub API calls.');
  }

  const baseUrl = String(apiUrl).replace(/\/+$/, '');

  async function request(method, path, body) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'pr-explainer-action',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    const data = parseResponseBody(text);

    if (!response.ok) {
      const detail = typeof data === 'string'
        ? data.slice(0, 300)
        : String((data && (data.message || data.documentation_url)) || '').slice(0, 300);
      const error = new Error(`GitHub API ${method} ${path} failed with status ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }

    return { data, headers: response.headers };
  }

  return {
    request,
    rest: {
      issues: {
        listComments: ({ owner, repo, issue_number, per_page = 100, page = 1 }) => request(
          'GET',
          `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${encodeSegment(issue_number)}/comments?per_page=${encodeSegment(per_page)}&page=${encodeSegment(page)}`
        ),
        createComment: ({ owner, repo, issue_number, body }) => request(
          'POST',
          `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${encodeSegment(issue_number)}/comments`,
          { body }
        ),
        updateComment: ({ owner, repo, comment_id, body }) => request(
          'PATCH',
          `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/comments/${encodeSegment(comment_id)}`,
          { body }
        )
      },
      repos: {
        getCollaboratorPermissionLevel: ({ owner, repo, username }) => request(
          'GET',
          `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/collaborators/${encodeSegment(username)}/permission`
        )
      },
      pulls: {
        get: ({ owner, repo, pull_number }) => request(
          'GET',
          `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls/${encodeSegment(pull_number)}`
        )
      }
    }
  };
}

module.exports = {
  createGitHubClient
};
