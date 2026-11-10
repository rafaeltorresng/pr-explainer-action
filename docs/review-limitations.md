# Review Scope, Validation Boundaries, and Known Limitations

This document records what the current test suite and local review actually prove, what they do not prove, and the risks that remain before this Action is used on real pull requests.

## What was validated locally

- **Compiler pipeline**: model JSON parsing, legacy plain-text normalization, quiz normalization, Markdown generation, and full editorial HTML rendering.
- **Injection boundary**: hostile values in every rendered model field (summary, mechanism, evidence, visualizations, walkthrough, simulation, quiz, limitations) are escaped. Simulation scenario data embedded in `data-scenarios` is escaped before it reaches the attribute. A nonce-based CSP replaces external assets.
- **Context retrieval**: exact-commit reads via `git cat-file`, workspace fallback when no SHA exists, traversal/absolute-path rejection, symlink rejection, sensitive-path exclusion, binary detection, and byte-budget enforcement.
- **Markdown comment safety**: heading/list/quote prefixes, mentions, URLs, link syntax, and HTML from model text are neutralized.
- **Lifecycle resolution**: `pull_request_target` opened/reopened/ready-for-review generate; synchronize/edited mark outdated; unsupported events skip; `/explain` requires `write`, `maintain`, or `admin`; permission lookup failures fail closed; mode overrides cannot bypass `/explain` authorization.
- **Action commands over a mocked GitHub HTTP API**: `runAction` writes GitHub outputs and a context file, creates and idempotently updates comments, marks comments outdated, and posts skip/denied notices with the correct headers and markers.
- **Pages behavior**: no URL is emitted by default; `publish_pages` only prepares a local directory; a link is emitted only for an explicitly supplied `https://` deployment URL.

## What was not validated

- **Real-model correctness or usefulness.** `test/evaluation.test.js` feeds fixed, human-authored responses through the same pipeline used for provider output. Those tests prove that known-correct content survives parsing, context wiring, and rendering; they do **not** measure whether a real model would discover that content, avoid hallucination, or produce good evidence separation on an unseen PR.
- **A real provider call.** No paid or authorized provider smoke test was run. Transport retries, timeout handling, and provider-specific payload shapes are covered by mocks only.
- **GitHub-hosted runner behavior.** The composite Action is validated locally and in the `validate-action` workflow shape, but the actual `action.yml` execution, checkout/fetch behavior, permission model, and comment API behavior on GitHub's runners can only be confirmed by a real workflow run after push.
- **A live Pages deployment.** The Action does not deploy. `pages_deployment_url` is a caller assertion; the Action cannot verify that the URL exists or serves the prepared report.
- **Real fork and permission scenarios.** The local tests model permission responses, but GitHub's actual token permissions for fork-originated events depend on repository settings and the caller's workflow.

## Remaining risks

1. **Comment marker spoofing (low).** `findExistingExplainerComment` finds the first comment containing the explainer marker, without verifying the author. A user who can comment could post the marker first and cause the Action to update that comment instead of creating its own. This was left unchanged to preserve PAT compatibility (the acting user is not always `github-actions[bot]`). Mitigation options: verify `comment.user.login === GITHUB_ACTOR` or fetch the authenticated user, at the cost of PAT/App identity edge cases.
2. **Consumer misuse of `pull_request_target`.** The Action is safe when the workflow checks out the trusted base branch and does not execute PR code. A consumer that checks out the PR head or runs PR scripts with secrets reintroduces the classic `pull_request_target` vulnerability. The README calls this out explicitly.
3. **Model content can still be wrong.** Rendering safety does not equal factual correctness. Evidence categories are prompt-driven, and a model can misclassify, omit, or overstate behavior. Treat the report as an aid, not as a replacement for review.
4. **Context detection is intentionally narrow.** Only static script paths in added workflow `run:` steps are detected. Dynamic paths, globs, shell variables, and references outside workflow diffs are ignored. This is a privacy and cost trade-off, not a complete dependency analysis.
5. **Outdated marking is best-effort.** If comment listing fails or pagination exceeds the internal page cap, the Action may not find an existing comment. It will not re-run inference for outdated events.
6. **`edited` events mark the comment outdated.** A description-only edit does not re-run inference; the user must comment `/explain` to regenerate.
7. **Skip state does not delete old reports.** Exceeding `max_lines` preserves the last valid explanation and posts a skip notice. This is deliberate, but the old report may remain visible.
8. **Diff and context leave the runner.** The PR diff, title/body, and retrieved workflow-referenced scripts are sent to the configured AI provider. The Action excludes sensitive-looking context filenames, but the diff itself may contain committed secrets. Use it only where sending that data to the provider is acceptable.
9. **Provider JSON-mode compatibility is not proven.** OpenAI-compatible endpoints receive `response_format: { type: 'json_object' }`. Most support it, but this was not smoke-tested against every provider; a provider that rejects the field would return a permanent 400.
10. **Legacy templates are unused.** `template.html` and `template.pt-BR.html` are no longer referenced by the renderer. They should be removed or moved after confirming that no external consumer depends on them.

## Required smoke test before real use

Run this only after explicit authorization and with an approved budget:

1. Configure a real provider key and a small, non-sensitive test PR (or `sample.patch`).
2. Generate the report and inspect it for factual accuracy, evidence separation, and hallucinated claims.
3. Verify the Markdown comment renders correctly and updates idempotently on a second run.
4. Verify `/explain` authorization with a write user and an unauthorized user.
5. Push a new commit and confirm the existing comment is marked outdated without re-inference.
6. Exercise a real `pull_request_target` run and confirm the workflow never checks out or executes PR head code.
7. If `publish_pages` is used, deploy the prepared directory separately and supply the confirmed URL via `pages_deployment_url`.

Until those steps are completed, treat the implementation as locally validated and ready for a controlled CI smoke test, not as proven against real model output.
