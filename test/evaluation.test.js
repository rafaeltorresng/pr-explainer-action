const { describe, expect, test } = require('bun:test');
const { readFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { generateExplanation } = require('../explain-pr');

const catalog = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/synthetic/catalog.json'), 'utf8'));

// These tests feed fixed, human-authored responses through the same compiler
// pipeline used for real provider output. They validate parsing, context
// wiring, and rendering of known-correct content. They do NOT measure whether
// a real model would discover that content on its own.
describe('mock-driven synthetic evaluation pipeline', () => {
  test('catalog contains all 10 representative PR categories', () => {
    expect(catalog).toHaveLength(10);
    const categories = catalog.map((c) => c.category);
    expect(categories).toContain('bugfix');
    expect(categories).toContain('feature');
    expect(categories).toContain('refactor');
    expect(categories).toContain('database');
    expect(categories).toContain('api');
    expect(categories).toContain('infra');
    expect(categories).toContain('frontend');
    expect(categories).toContain('large');
    expect(categories).toContain('misleading');
    expect(categories).toContain('ambiguous');
  });

  test('each fixture patch file exists and is valid git diff format', () => {
    catalog.forEach((item) => {
      const patchPath = join(process.cwd(), 'fixtures/synthetic', item.patchFile);
      const content = readFileSync(patchPath, 'utf8');
      expect(content).toContain('diff --git');
      expect(content.includes('--- a/') || content.includes('--- /dev/null')).toBe(true);
      expect(content).toContain('+++ b/');
    });
  });

  test('Fixture 06: selective context retrieval reads the referenced script and renders the supplied ground truth', async () => {
    const fixture06 = catalog.find((c) => c.id === '06-infra-workflow-script');
    const tempDir = mkdtempSync(join(tmpdir(), 'eval-06-'));
    const outputPath = join(tempDir, 'output.html');
    const mockPath = join(tempDir, 'mock.json');

    // Human-authored response that encodes the fixture ground truth: the script
    // PATCHes policy and does NOT deploy. This checks that the pipeline preserves
    // the supplied separation; it does not prove a model would infer it.
    const mockContent = JSON.stringify({
      summary: {
        problem: 'Workflow lacked deployment policy synchronization.',
        solution: 'Adds a workflow step executing ./scripts/deploy-policy.sh with POLICY_ENV=production.',
        invariants: ['Auto-rollback is configured with a 15-minute canary window.']
      },
      mechanism: {
        overview: 'Executes deploy-policy.sh, which dispatches a PATCH request to the policy API.',
        insights: ['Note: The script configures policy rules; it does NOT initiate container builds or redeployment.']
      },
      evidence: {
        verifiedCodeFacts: [
          'Adds step "Sync Policy Graph" running ./scripts/deploy-policy.sh',
          'deploy-policy.sh sends PATCH request to /api/v1/policy with autoRollback: true'
        ],
        authorIntent: [
          'Author PR description states: "Update deploy policy and trigger worker re-deployment in production."'
        ],
        unknownsOrRisks: [
          'PR description claims worker re-deployment, but the script only PATCHes configuration rules without triggering a deploy.'
        ]
      },
      visualizations: [],
      walkthrough: [
        {
          groupTitle: 'CI Workflow',
          description: 'Deploy workflow updated',
          files: [{ path: '.github/workflows/deploy.yml', role: 'Workflow', summary: 'Added sync policy step' }]
        }
      ],
      quiz: [
        {
          question: 'Does the deploy-policy.sh script trigger an immediate worker deployment?',
          options: [
            'No, it only sends a PATCH request to update policy rules',
            'Yes, it triggers a rolling worker redeploy',
            'Yes, it stops and restarts all containers',
            'It deploys to staging only'
          ],
          correctOptionIndex: 0,
          explanations: [
            'Correct: Script inspection shows it only executes curl -X PATCH to the policy API.',
            'Incorrect: Despite author description, the script does not call deploy.',
            'Incorrect: No container operations exist in the script.',
            'Incorrect: Environment is set to production.'
          ]
        }
      ],
      limitations: {
        omissions: [],
        unknowns: ['Server side reaction to PATCH /api/v1/policy'],
        unverifiedClaims: ['Immediate worker redeployment stated in PR description']
      }
    });

    writeFileSync(mockPath, JSON.stringify({
      choices: [{ message: { content: mockContent } }],
      usage: { prompt_tokens: 300, completion_tokens: 250, total_tokens: 550 }
    }), 'utf8');

    const result = await generateExplanation({
      diffFilePath: join(process.cwd(), 'fixtures/synthetic', fixture06.patchFile),
      outputFilePath: outputPath,
      languageInput: 'en',
      apiKey: 'test',
      repoRoot: join(process.cwd(), 'fixtures/synthetic'),
      commitSha: null,
      mockResponsePath: mockPath
    });

    // Check that selective context retrieval identified and read deploy-policy.sh
    // from the fixture workspace, because no commit SHA is supplied here.
    expect(result.contextMetadata.snapshot.mode).toBe('workspace');
    expect(result.contextMetadata.retrievedFiles).toHaveLength(1);
    expect(result.contextMetadata.retrievedFiles[0].path).toBe('scripts/deploy-policy.sh');

    const html = readFileSync(outputPath, 'utf8');
    expect(html).toContain('Sync Policy Graph');
    expect(html).toContain('deploy-policy.sh');
    expect(html).toContain('Does the deploy-policy.sh script trigger an immediate worker deployment?');
  });

  test('Fixture 09: supplied authorIntent and code facts remain separated in the Markdown comment', async () => {
    const fixture09 = catalog.find((c) => c.id === '09-misleading-description');
    const tempDir = mkdtempSync(join(tmpdir(), 'eval-09-'));
    const outputPath = join(tempDir, 'output.html');
    const mockPath = join(tempDir, 'mock.json');

    const mockContent = JSON.stringify({
      summary: {
        problem: 'CLI deploy command had dryRun hardcoded to true.',
        solution: 'Makes dryRun conditional on args.includes("--dry-run").'
      },
      mechanism: {
        overview: 'Checks command line arguments instead of hardcoding dryRun.',
        insights: ['The PR description claimed worker redeploy, but the diff only changes argument parsing.']
      },
      evidence: {
        verifiedCodeFacts: ['dryRun = args.includes("--dry-run")'],
        authorIntent: ['Claims full production worker redeployment and cache clearing'],
        unknownsOrRisks: ['No cache clearing or redeployment logic is present in the diff.']
      },
      quiz: []
    });

    writeFileSync(mockPath, JSON.stringify({
      choices: [{ message: { content: mockContent } }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    }), 'utf8');

    const result = await generateExplanation({
      diffFilePath: join(process.cwd(), 'fixtures/synthetic', fixture09.patchFile),
      outputFilePath: outputPath,
      languageInput: 'en',
      apiKey: 'test',
      commitSha: null,
      mockResponsePath: mockPath
    });

    const markdown = result.markdownComment;
    expect(markdown).toContain('Verified in Code:');
    expect(markdown).toContain('dryRun = args.includes("--dry-run")');
    expect(markdown).toContain('Author-Stated Intent:');
    expect(markdown).toContain('Claims full production worker redeployment');
    expect(markdown).toContain('No cache clearing or redeployment logic is present');
  });

  test('Fixture 10: supplied simulation scenarios render as an interactive section', async () => {
    const fixture10 = catalog.find((c) => c.id === '10-ambiguous-error-handler');
    const tempDir = mkdtempSync(join(tmpdir(), 'eval-10-'));
    const outputPath = join(tempDir, 'output.html');
    const mockPath = join(tempDir, 'mock.json');

    const mockContent = JSON.stringify({
      summary: {
        problem: '4xx errors were being retried.',
        solution: 'Guard against retrying 400-499 unless status is 429.'
      },
      mechanism: {
        overview: 'Classifies status codes into known_rejection, rate_limited, or unknown.'
      },
      simulation: {
        enabled: true,
        title: 'HTTP Status Error Classification',
        rule: '4xx = no retry, 429 = retry with delay, others = unknown retry',
        scenarios: [
          {
            id: '404',
            label: 'HTTP 404 Not Found',
            outcome: { action: 'No Retry', status: 'known_rejection' },
            explanation: 'Client rejections are not retried.'
          },
          {
            id: '429',
            label: 'HTTP 429 Rate Limit',
            outcome: { action: 'Retry with Delay', status: 'rate_limited' },
            explanation: 'Honors Retry-After header.'
          }
        ]
      },
      quiz: []
    });

    writeFileSync(mockPath, JSON.stringify({
      choices: [{ message: { content: mockContent } }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    }), 'utf8');

    const result = await generateExplanation({
      diffFilePath: join(process.cwd(), 'fixtures/synthetic', fixture10.patchFile),
      outputFilePath: outputPath,
      languageInput: 'en',
      apiKey: 'test',
      commitSha: null,
      mockResponsePath: mockPath
    });

    const html = readFileSync(outputPath, 'utf8');
    expect(html).toContain('HTTP Status Error Classification');
  });
});
