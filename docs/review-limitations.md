# Review Scope, Validation Boundaries, and Known Limitations

This document records what the current tests and validation runs actually prove, what they do not prove, and the risks that remain before this Action is used on real pull requests.

## What was validated

### Local tests

- **Compiler pipeline**: model JSON parsing, missing-root-brace repair, legacy plain-text normalization, quiz normalization, truncation rejection, Markdown generation, and full editorial HTML rendering.
- **Injection boundary**: hostile values in every rendered model field (summary, mechanism, evidence, visualizations, walkthrough, simulation, quiz, limitations) are escaped. Simulation scenario data embedded in `data-scenarios` is escaped before it reaches the attribute. A nonce-based CSP replaces external assets.
- **Context retrieval**: exact-commit reads via `git cat-file`, workspace fallback when no SHA exists, traversal/absolute-path rejection, symlink rejection, sensitive-path exclusion, binary detection, and byte-budget enforcement.
- **Markdown comment safety**: heading/list/quote prefixes, mentions, URLs, link syntax, and HTML from model text are neutralized. One owned comment is reused as the explanation, while skip/denied notices use a separate status slot so they never overwrite a valid explanation; superseded notices are deleted.
- **Comment ownership**: updates only target a comment authored by the authenticated token owner (`GET /user`), falling back to a bot-authored comment only when the identity cannot be resolved. A marker planted in a third-party comment cannot hijack the update path. Outdated comments remain discoverable even after the warning banner is prepended to the body.
- **Lifecycle resolution**: `pull_request_target` opened/reopened/ready-for-review generate; synchronize/edited mark outdated; unsupported events skip; `/explain` requires `write`, `maintain`, or `admin`; permission lookup failures fail closed; mode overrides cannot bypass `/explain` authorization.
- **Action commands over a mocked GitHub HTTP API**: `runAction` writes GitHub outputs and a context file, creates and idempotently updates comments, marks comments outdated, and posts skip/denied notices with the correct headers and markers.
- **Pages behavior**: no URL is emitted by default; `publish_pages` only prepares a local directory; a link is emitted only for an explicitly supplied `https://` deployment URL.
- **Provider configuration**: per-provider defaults and caps, `max_output_tokens`, one retry on truncated responses (including Anthropic `stop_reason: max_tokens` normalized to `length`), and provider-reported cost output.

At the time of this review the suite reports 114 passing tests and 0 failures across 7 files.

### Real provider calls

- Real calls were made to **Featherless** with **`deepseek-ai/DeepSeek-V4.1-Flash`**, now the default Featherless model. Calls used synthetic fixtures only, with explicit budget tracking.
- The default model path (no `AI_MODEL` override) was exercised end to end. On the misleading-description fixture, the report correctly contradicted the PR description and identified the actual `dryRun` behavior.
- Coverage spans all **10 English fixtures** and **5 Brazilian Portuguese fixtures**. The English 05, 08, and 10 reports and the Portuguese 09 report were regenerated with the current pipeline so their content reflects `PR_BODY` support rather than an older prompt.
- Across the tracked ledger, 25 runs were recorded (24 successful; the single failure is the intentional 256-token truncation probe) for **US$0.184665**. Observed spend is approximately **US$0.18**, well inside the US$5 ceiling.
- No API key material appeared in run logs, failure logs, generated artifacts, or diffs during these checks.
- OpenRouter was **not** called: no OpenRouter key was available. Its default remains `deepseek/deepseek-v4-flash`; the unverified `deepseek/deepseek-v4.1-flash` identifier is documented but not made the default.

### Real failure paths

- **Invalid API key**: provider returns 401, the process exits non-zero, no HTML report is written, and the key does not appear in logs.
- **Invalid model**: provider returns 404, the process exits non-zero with no report.
- **Malformed model content**: unparseable JSON fails the run instead of rendering a partial report.
- **Truncated output** (`max_output_tokens` set to 256): the request is retried once, then fails with an explicit truncation error and a non-zero exit instead of silently accepting incomplete content.

### Browser and visual validation

Generated reports were rendered in headless Chromium at desktop (1440px) and mobile (390px) widths, in both English and Brazilian Portuguese, and in light and dark themes. The sweep covered all 15 current reports.

- No horizontal overflow at either width, including walkthrough file headers, key lines, and diagrams.
- Text contrast passed WCAG AA (4.5:1) checks in both themes. This sweep found one dark-mode defect — the simulation outcome badge rendered white on light purple at 2.72:1 — which was fixed by using dark text on the accent background.
- Theme toggle switches and restores correctly.
- All simulation tabs select the expected scenario, action badge, status chip, and explanation.
- Quiz answers update the score, lock the question, show the verdict, reset correctly, and handle a wrong answer without awarding a point. Answered options no longer show the hover-only "Select" affordance.
- No external network requests, no page errors, and no console messages after the CSP adjustment.
- Basic structure checks passed: one `h1`, header/main/footer landmarks, no images without `alt`, no buttons without `type`, no empty links.

Visual validation reused reports generated by real provider output and re-rendered them with the current renderer CSS/CSP, so no additional paid calls were needed for styling changes. Browser automation used a locally cached Chromium build because the in-app browser was disconnected; this is a tooling detail, not a product dependency.

### Pages preparation proof of concept

- `preparePagesFile` produced a self-contained `pr-explains/pr-<number>/index.html`.
- Served locally over HTTP, the page returned `200`, made no external requests, logged no console messages, and rendered the report, simulation, and quiz correctly.
- With no supplied base URL, `getPagesUrl` returns `null`; with an explicit `https://` base URL it returns the expected path. The Action never infers that a deployment occurred.

## What was not validated

- **GitHub-hosted runner execution.** The composite Action is validated locally and its workflow shape is parsed, but the actual `action.yml` execution, checkout/fetch behavior, permission model, and comment API behavior on GitHub's runners can only be confirmed by a real workflow run after push.
- **A live Pages deployment.** The Action deliberately does not deploy. `pages_deployment_url` is a caller assertion; the Action cannot verify that the URL exists or serves the prepared report.
- **OpenRouter V4.1 Flash.** The identifier exists in the OpenRouter catalog, but no real call was made because no OpenRouter key was available. That is why it is not the OpenRouter default.
- **Other providers.** OpenAI, Anthropic, xAI, and Gemini were not called with real keys during this review; their defaults, caps, and payload shapes are covered by tests and mocks.
- **Real fork and permission scenarios.** Local tests model permission responses, but GitHub's actual token permissions for fork-originated events depend on repository settings and the caller's workflow.
- **Long-run cost behavior.** Cost was tracked per run, but no sustained or high-volume usage was simulated.

## Remaining risks

1. **Comment identity fallback (low).** When the authenticated login cannot be resolved, the Action falls back to a bot-authored comment. This preserves PAT/App compatibility but is weaker than the primary identity check. A failure of `GET /user` is the only path to the fallback.
2. **Consumer misuse of `pull_request_target`.** The Action is safe when the workflow checks out the trusted base branch and does not execute PR code. A consumer that checks out the PR head or runs PR scripts with secrets reintroduces the classic `pull_request_target` vulnerability. The README calls this out explicitly.
3. **Model content can still be wrong.** Rendering safety does not equal factual correctness. Evidence categories are prompt-driven, and a model can misclassify, omit, or overstate behavior. Treat the report as an aid, not as a replacement for review. The V4.1 Flash results were materially better in validation, not infallible. One English output conflated a Map key with its value in a quiz option: it said a key *whose value* is `undefined` skips eviction, when the actual edge case is a key *that is* `undefined`. A repeat run of the same fixture described the edge case correctly and added a separate, correct question about `undefined` values, so this is an intermittent generation error rather than a structural renderer bug.
4. **Context detection is intentionally narrow.** Only static script paths in added workflow `run:` steps are detected. Dynamic paths, globs, shell variables, and references outside workflow diffs are ignored. This is a privacy and cost trade-off, not a complete dependency analysis.
5. **Outdated marking is best-effort.** If comment listing fails or pagination exceeds the internal page cap, the Action may not find an existing comment. It will not re-run inference for outdated events.
6. **`edited` events mark the comment outdated.** A description-only edit does not re-run inference; the user must comment `/explain` to regenerate.
7. **Skip state does not delete old reports.** Exceeding `max_lines` preserves the last valid explanation and posts a skip notice. This is deliberate, but the old report may remain visible.
8. **Diff and context leave the runner.** The PR diff, title/body, and retrieved workflow-referenced scripts are sent to the configured AI provider. The Action excludes sensitive-looking context filenames, but the diff itself may contain committed secrets. Use it only where sending that data to the provider is acceptable.
9. **Provider JSON-mode compatibility varies.** OpenAI-compatible endpoints receive `response_format: { type: 'json_object' }`. Featherless with V4.1 Flash was validated, including a narrow missing-root-brace repair. Other providers were not smoke-tested against this field; a provider that rejects it returns a permanent 400.
10. **Cost reporting depends on the provider.** `cost_usd` and the rendered price are populated only when the provider reports a native cost. Otherwise the output shows `n/a`; the OpenRouter default path estimates from configured rates instead.
11. **Templates are unused.** `template.html` and `template.pt-BR.html` are no longer referenced by the renderer. They should be removed or moved after confirming that no external consumer depends on them.

## Required smoke tests before production rollout

1. Run the composite Action in a real GitHub workflow against a small, non-sensitive PR and confirm the workflow never checks out or executes PR head code.
2. Verify the Markdown comment renders correctly, updates idempotently on a second run, and is marked outdated after a new commit without re-inference.
3. Verify `/explain` authorization with a write user and an unauthorized user on GitHub, including fork-originated events.
4. If `publish_pages` is used, deploy the prepared directory separately and supply the confirmed URL via `pages_deployment_url`.
5. Before changing the OpenRouter default, run `deepseek/deepseek-v4.1-flash` with a real OpenRouter key and compare accuracy and cost against the current default.
6. If another provider becomes primary, smoke-test its JSON mode, output cap, and error behavior with a real key.

Until those steps are completed, treat the implementation as validated locally, against a real Featherless model, and in a browser, but not yet proven on GitHub-hosted infrastructure or a live Pages deployment.
