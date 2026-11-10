const { describe, expect, test } = require('bun:test');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  isSensitivePath,
  isBinaryBuffer,
  extractScriptReferencesFromDiff,
  inspectDiff,
  retrieveSelectiveContext
} = require('../src/context/retrieve-context');

describe('context security: path & sensitivity checks', () => {
  test('flags sensitive files (.env, secrets, credentials, keys, .git)', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('config/secrets.json')).toBe(true);
    expect(isSensitivePath('deploy/credentials.yml')).toBe(true);
    expect(isSensitivePath('certs/server.key')).toBe(true);
    expect(isSensitivePath('certs/cert.pem')).toBe(true);
    expect(isSensitivePath('.git/config')).toBe(true);

    expect(isSensitivePath('scripts/deploy.sh')).toBe(false);
    expect(isSensitivePath('src/utils/math.ts')).toBe(false);
  });

  test('detects binary buffers containing null bytes', () => {
    const textBuf = Buffer.from('console.log("hello world");');
    const binaryBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);

    expect(isBinaryBuffer(textBuf)).toBe(false);
    expect(isBinaryBuffer(binaryBuf)).toBe(true);
  });
});

describe('workflow script reference extraction', () => {
  test('extracts script references added in workflow files', () => {
    const sampleWorkflowDiff = `
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 123..456 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,2 +10,4 @@ jobs:
     steps:
+      - name: Run deploy policy
+        run: ./scripts/deploy-policy.sh
+      - name: Check health
+        run: node scripts/health-check.js --strict
`;
    const scripts = extractScriptReferencesFromDiff(sampleWorkflowDiff);
    expect(scripts).toContain('scripts/deploy-policy.sh');
    expect(scripts).toContain('scripts/health-check.js');
  });

  test('ignores script references in non-workflow files or deleted lines', () => {
    const nonWorkflowDiff = `
diff --git a/README.md b/README.md
index 123..456 100644
--- a/README.md
+++ b/README.md
@@ -5,1 +5,1 @@
- run ./scripts/old.sh
+ run ./scripts/new.sh
`;
    const scripts = extractScriptReferencesFromDiff(nonWorkflowDiff);
    expect(scripts).toHaveLength(0);
  });
});

describe('selective context retrieval end-to-end', () => {
  const fixture06Path = join(process.cwd(), 'fixtures/synthetic/06-infra-workflow-script.patch');
  const fixture06Diff = readFileSync(fixture06Path, 'utf8');
  const syntheticRepoRoot = join(process.cwd(), 'fixtures/synthetic');

  test('retrieves referenced script safely from fixture directory', () => {
    const result = retrieveSelectiveContext({
      diffText: fixture06Diff,
      repoRoot: syntheticRepoRoot,
      enableContext: true,
      maxContextFiles: 2,
      maxContextBytes: 8192
    });

    expect(result.enabled).toBe(true);
    expect(result.retrievedFiles).toHaveLength(1);
    const retrieved = result.retrievedFiles[0];
    expect(retrieved.path).toBe('scripts/deploy-policy.sh');
    expect(retrieved.content).toContain('curl -sSf -X PATCH');
    expect(retrieved.content).toContain('autoRollback');
    // Crucial ground truth: script only PATCHes policy, no redeploy!
    expect(retrieved.content).not.toContain('redeploy');
  });

  test('respects opt-out via enableContext: false', () => {
    const result = retrieveSelectiveContext({
      diffText: fixture06Diff,
      repoRoot: syntheticRepoRoot,
      enableContext: false
    });

    expect(result.enabled).toBe(false);
    expect(result.retrievedFiles).toHaveLength(0);
  });

  test('rejects path traversal attempting to read outside repository root', () => {
    const traversalDiff = `
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
index 111..222 100644
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -10,1 +10,2 @@
+      run: bash ../../../etc/passwd.sh
`;
    const result = retrieveSelectiveContext({
      diffText: traversalDiff,
      repoRoot: syntheticRepoRoot,
      enableContext: true
    });

    expect(result.retrievedFiles).toHaveLength(0);
    expect(result.skippedFiles.some((s) => s.reason.includes('traversal'))).toBe(true);
  });

  test('respects maxContextFiles limit', () => {
    const multiDiff = `
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
index 111..222 100644
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -10,1 +10,4 @@
+      run: ./scripts/deploy-policy.sh
+      run: ./scripts/second.sh
+      run: ./scripts/third.sh
`;
    const result = retrieveSelectiveContext({
      diffText: multiDiff,
      repoRoot: syntheticRepoRoot,
      enableContext: true,
      maxContextFiles: 1
    });

    expect(result.retrievedFiles.length).toBeLessThanOrEqual(1);
  });
});

describe('exact commit retrieval and symlink defenses', () => {
  const workflowDiff = `
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
index 111..222 100644
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -10,1 +10,2 @@
+      run: ./scripts/deploy-policy.sh
`;

  function git(repo, args) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  function createRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'context-git-'));
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    return repo;
  }

  test('reads referenced files from the analyzed commit, not the modified workspace', () => {
    const repo = createRepo();
    try {
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      const scriptPath = join(repo, 'scripts/deploy-policy.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho committed-version\n', 'utf8');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'add policy script']);
      const commitSha = git(repo, ['rev-parse', 'HEAD']);

      // Simulate an uncommitted workspace modification after the analyzed commit.
      writeFileSync(scriptPath, '#!/bin/sh\necho workspace-version\n', 'utf8');

      const committed = retrieveSelectiveContext({
        diffText: workflowDiff,
        repoRoot: repo,
        commitSha,
        enableContext: true
      });
      expect(committed.snapshot.mode).toBe('git');
      expect(committed.retrievedFiles).toHaveLength(1);
      expect(committed.retrievedFiles[0].content).toContain('committed-version');
      expect(committed.retrievedFiles[0].content).not.toContain('workspace-version');

      const workspace = retrieveSelectiveContext({
        diffText: workflowDiff,
        repoRoot: repo,
        commitSha: null,
        enableContext: true
      });
      expect(workspace.snapshot.mode).toBe('workspace');
      expect(workspace.retrievedFiles[0].content).toContain('workspace-version');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects symlinks both in the workspace and in the analyzed commit', () => {
    const repo = createRepo();
    try {
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      symlinkSync('/etc/passwd', join(repo, 'scripts/deploy-policy.sh'));

      const workspace = retrieveSelectiveContext({
        diffText: workflowDiff,
        repoRoot: repo,
        commitSha: null,
        enableContext: true
      });
      expect(workspace.retrievedFiles).toHaveLength(0);
      expect(workspace.skippedFiles[0].reason).toContain('Symbolic links');

      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'add symlink']);
      const commitSha = git(repo, ['rev-parse', 'HEAD']);

      const committed = retrieveSelectiveContext({
        diffText: workflowDiff,
        repoRoot: repo,
        commitSha,
        enableContext: true
      });
      expect(committed.snapshot.mode).toBe('git');
      expect(committed.retrievedFiles).toHaveLength(0);
      expect(committed.skippedFiles[0].reason).toContain('Symbolic links');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('fails closed when the analyzed commit is not present locally', () => {
    const result = retrieveSelectiveContext({
      diffText: workflowDiff,
      repoRoot: process.cwd(),
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      enableContext: true
    });

    expect(result.snapshot.mode).toBe('unavailable');
    expect(result.retrievedFiles).toHaveLength(0);
    expect(result.skippedFiles[0].reason).toContain('not available');
  });
});

describe('diff inspection & truncation', () => {
  test('inspectDiff records changed files and marks truncation cleanly', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`diff --git a/file_${i}.ts b/file_${i}.ts\nindex 1..2\n--- a/file_${i}.ts\n+++ b/file_${i}.ts\n@@ -1,1 +1,2 @@\n+line ${i}\n`);
    }
    const hugeDiff = lines.join('\n');

    const meta = inspectDiff(hugeDiff, 2000);
    expect(meta.isTruncated).toBe(true);
    expect(meta.totalChars).toBeGreaterThan(2000);
    expect(meta.cappedChars).toBeLessThanOrEqual(2000);
    expect(meta.omittedFiles.length).toBeGreaterThan(0);
  });
});
