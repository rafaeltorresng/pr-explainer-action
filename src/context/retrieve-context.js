const { readFileSync, lstatSync, statSync, realpathSync } = require('node:fs');
const { resolve, relative, isAbsolute } = require('node:path');
const { spawnSync } = require('node:child_process');

const SENSITIVE_PATTERNS = [
  /^\.env/i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /secret/i,
  /credential/i,
  /token/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.pypirc$/i,
  /(?:^|\/)\.htpasswd$/i,
  /(?:^|\/)\.aws\/credentials$/i,
  /(?:^|\/)kubeconfig$/i,
  /service[-_]?account/i,
  /(?:^|\/)\.git\//i
];

const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

function isSensitivePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isBinaryBuffer(buffer) {
  const slice = buffer.slice(0, 512);
  for (let i = 0; i < slice.length; i += 1) {
    if (slice[i] === 0) return true;
  }
  return false;
}

function normalizeRepoPath(candidatePath) {
  if (typeof candidatePath !== 'string') return null;

  const value = candidatePath.trim();
  if (!value || /[\0\r\n]/.test(value)) return null;

  const unixPath = value.replace(/\\/g, '/');
  if (unixPath.startsWith('/') || /^[A-Za-z]:/.test(unixPath) || unixPath.startsWith('~')) {
    return null;
  }

  const segments = unixPath.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;

  return segments.join('/');
}

function extractScriptReferencesFromDiff(diffText) {
  const scriptPaths = new Set();
  const lines = String(diffText || '').split(/\r?\n/);

  const WORKFLOW_REGEX = /^\+\+\+ b\/(\.github\/workflows\/[^\s]+)/;
  const RUN_SCRIPT_REGEX = /^\+\s*(?:run:\s*)?(?:\.\/|bash\s+|sh\s+|node\s+|python3?\s+)([A-Za-z0-9_\-./]+\.(?:sh|bash|js|ts|py|rb))/;
  const DIRECT_EXEC_REGEX = /^\+\s*(\.\/[A-Za-z0-9_\-./]+)/;

  let isInWorkflow = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      isInWorkflow = false;
    }

    const workflowMatch = line.match(WORKFLOW_REGEX);
    if (workflowMatch) {
      isInWorkflow = true;
      continue;
    }

    if (isInWorkflow && line.startsWith('+') && !line.startsWith('+++')) {
      const match = line.match(RUN_SCRIPT_REGEX) || line.match(DIRECT_EXEC_REGEX);
      if (match) {
        let scriptPath = match[1].trim();
        if (scriptPath.startsWith('./')) {
          scriptPath = scriptPath.slice(2);
        }
        scriptPath = scriptPath.split(/\s+/)[0];
        if (scriptPath && !scriptPath.includes('*') && !scriptPath.includes('$')) {
          scriptPaths.add(scriptPath);
        }
      }
    }
  }

  return Array.from(scriptPaths);
}

function inspectDiff(diffText, maxDiffChars = 40000) {
  const filesChanged = [];
  const text = String(diffText || '');
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (match) {
        filesChanged.push(match[2]);
      }
    }
  }

  const totalChars = text.length;
  let isTruncated = false;
  let cappedDiff = text;
  let omittedFiles = [];

  if (totalChars > maxDiffChars) {
    isTruncated = true;
    const cutCandidate = text.lastIndexOf('\ndiff --git ', maxDiffChars);
    if (cutCandidate > maxDiffChars / 2) {
      cappedDiff = text.substring(0, cutCandidate);
    } else {
      const hunkCandidate = text.lastIndexOf('\n@@ ', maxDiffChars);
      if (hunkCandidate > maxDiffChars / 2) {
        cappedDiff = text.substring(0, hunkCandidate);
      } else {
        cappedDiff = text.substring(0, maxDiffChars);
      }
    }

    const analyzedFiles = [];
    for (const line of cappedDiff.split(/\r?\n/)) {
      if (line.startsWith('diff --git a/')) {
        const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
        if (match) analyzedFiles.push(match[2]);
      }
    }
    omittedFiles = filesChanged.filter((file) => !analyzedFiles.includes(file));
  }

  return {
    totalChars,
    cappedChars: cappedDiff.length,
    isTruncated,
    cappedDiff,
    filesChanged,
    omittedFiles
  };
}

function runGit(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function resolveGitCommit(repoRoot, commitSha) {
  if (!GIT_COMMIT_PATTERN.test(String(commitSha || ''))) {
    return null;
  }
  const result = runGit(repoRoot, ['rev-parse', '--verify', `${commitSha}^{commit}`]);
  if (result.status !== 0) return null;
  return String(result.stdout.toString('utf8')).trim();
}

function readFromGitSnapshot({ repoRoot, commitSha, candidatePath, maxBytes }) {
  const normalizedPath = normalizeRepoPath(candidatePath);
  if (!normalizedPath) {
    return { ok: false, reason: 'Path contains traversal or an absolute path' };
  }

  const objectSpec = `${commitSha}:${normalizedPath}`;
  const treeResult = runGit(repoRoot, ['ls-tree', '-z', commitSha, '--', normalizedPath]);
  if (treeResult.status !== 0) {
    return { ok: false, reason: `Git could not inspect the commit snapshot: ${treeResult.stderr.toString('utf8').trim()}` };
  }

  const treeOutput = treeResult.stdout.toString('utf8');
  const entry = treeOutput.split('\0').find((line) => line.length > 0);
  if (!entry) {
    return { ok: false, reason: 'File does not exist in the analyzed commit' };
  }

  const [metadata, ...pathParts] = entry.split('\t');
  const [mode, type] = metadata.trim().split(/\s+/);
  const treePath = pathParts.join('\t');

  if (treePath !== normalizedPath) {
    return { ok: false, reason: 'Git resolved a different path than requested' };
  }
  if (mode === '120000') {
    return { ok: false, reason: 'Symbolic links are not read as context' };
  }
  if (mode === '160000' || type !== 'blob') {
    return { ok: false, reason: 'Path is not a regular file blob' };
  }

  const sizeResult = runGit(repoRoot, ['cat-file', '-s', objectSpec]);
  if (sizeResult.status !== 0) {
    return { ok: false, reason: 'Could not determine blob size in the analyzed commit' };
  }
  const size = Number(sizeResult.stdout.toString('utf8').trim());
  if (!Number.isFinite(size) || size < 0) {
    return { ok: false, reason: 'Invalid blob size in the analyzed commit' };
  }
  if (size > maxBytes) {
    return { ok: false, reason: `File size (${size}B) exceeds max context budget (${maxBytes}B)` };
  }

  const blobResult = runGit(repoRoot, ['cat-file', 'blob', objectSpec]);
  if (blobResult.status !== 0) {
    return { ok: false, reason: 'Could not read blob from the analyzed commit' };
  }

  return { ok: true, buffer: blobResult.stdout, sizeBytes: size };
}

function readFromWorkspace({ repoRoot, candidatePath, maxBytes }) {
  const normalizedPath = normalizeRepoPath(candidatePath);
  if (!normalizedPath) {
    return { ok: false, reason: 'Path contains traversal or an absolute path' };
  }

  let rootReal;
  try {
    rootReal = realpathSync(repoRoot);
  } catch {
    return { ok: false, reason: 'Repository root does not exist' };
  }

  const candidate = resolve(rootReal, normalizedPath);
  const relativeCandidate = relative(rootReal, candidate);
  if (
    relativeCandidate === '' ||
    relativeCandidate.startsWith('..') ||
    isAbsolute(relativeCandidate)
  ) {
    return { ok: false, reason: 'Path traverses outside repository root' };
  }

  let linkStat;
  try {
    linkStat = lstatSync(candidate);
  } catch {
    return { ok: false, reason: 'File does not exist in local snapshot' };
  }
  if (linkStat.isSymbolicLink()) {
    return { ok: false, reason: 'Symbolic links are not read as context' };
  }
  if (!linkStat.isFile()) {
    return { ok: false, reason: 'Target is not a regular file' };
  }

  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'Could not resolve the real file path' };
  }
  const realRelative = relative(rootReal, realCandidate);
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
    return { ok: false, reason: 'Resolved path escapes repository root' };
  }

  let finalStat;
  try {
    finalStat = statSync(realCandidate);
  } catch {
    return { ok: false, reason: 'Could not stat the resolved file' };
  }
  if (!finalStat.isFile()) {
    return { ok: false, reason: 'Target is not a regular file' };
  }
  if (finalStat.size > maxBytes) {
    return { ok: false, reason: `File size (${finalStat.size}B) exceeds max context budget (${maxBytes}B)` };
  }

  try {
    return { ok: true, buffer: readFileSync(realCandidate), sizeBytes: finalStat.size };
  } catch (error) {
    return { ok: false, reason: `Read error: ${error.message}` };
  }
}

function retrieveSelectiveContext({
  diffText,
  repoRoot = process.cwd(),
  commitSha = null,
  enableContext = true,
  maxContextFiles = 2,
  maxContextBytes = 8192
}) {
  const diffMeta = inspectDiff(diffText);

  if (!enableContext) {
    return {
      enabled: false,
      snapshot: { mode: 'disabled', commitSha: null },
      retrievedFiles: [],
      skippedFiles: [],
      diffMeta
    };
  }

  let snapshotMode = 'workspace';
  let resolvedCommit = null;
  let snapshotUnavailableReason = null;

  if (commitSha) {
    resolvedCommit = resolveGitCommit(repoRoot, commitSha);
    if (resolvedCommit) {
      snapshotMode = 'git';
    } else {
      snapshotUnavailableReason = `Commit ${String(commitSha).slice(0, 12)} is not available in the local Git object database`;
    }
  }

  if (snapshotUnavailableReason) {
    return {
      enabled: true,
      snapshot: { mode: 'unavailable', commitSha: String(commitSha) },
      retrievedFiles: [],
      skippedFiles: [{ path: '(all)', reason: snapshotUnavailableReason }],
      diffMeta
    };
  }

  const scriptCandidates = extractScriptReferencesFromDiff(diffText);
  const retrievedFiles = [];
  const skippedFiles = [];
  let totalBytesRead = 0;

  for (const candidatePath of scriptCandidates) {
    if (retrievedFiles.length >= maxContextFiles) {
      skippedFiles.push({ path: candidatePath, reason: 'Exceeded max_context_files limit' });
      continue;
    }

    if (isSensitivePath(candidatePath)) {
      skippedFiles.push({ path: candidatePath, reason: 'Matched sensitive file pattern (excluded for privacy)' });
      continue;
    }

    const remainingBudget = maxContextBytes - totalBytesRead;
    const readResult = snapshotMode === 'git'
      ? readFromGitSnapshot({
        repoRoot,
        commitSha: resolvedCommit,
        candidatePath,
        maxBytes: remainingBudget
      })
      : readFromWorkspace({
        repoRoot,
        candidatePath,
        maxBytes: remainingBudget
      });

    if (!readResult.ok) {
      skippedFiles.push({ path: candidatePath, reason: readResult.reason });
      continue;
    }

    if (isBinaryBuffer(readResult.buffer)) {
      skippedFiles.push({ path: candidatePath, reason: 'File appears to be binary' });
      continue;
    }

    const content = readResult.buffer.toString('utf8');
    const lineCount = content.split(/\r?\n/).length;

    retrievedFiles.push({
      path: candidatePath,
      sizeBytes: readResult.sizeBytes,
      lineCount,
      content,
      reason: snapshotMode === 'git'
        ? 'Referenced by added workflow step; read from the analyzed commit'
        : 'Referenced by added workflow step; read from the local workspace'
    });

    totalBytesRead += readResult.sizeBytes;
  }

  return {
    enabled: true,
    snapshot: {
      mode: snapshotMode,
      commitSha: resolvedCommit
    },
    retrievedFiles,
    skippedFiles,
    diffMeta
  };
}

module.exports = {
  isSensitivePath,
  isBinaryBuffer,
  normalizeRepoPath,
  extractScriptReferencesFromDiff,
  inspectDiff,
  retrieveSelectiveContext
};
