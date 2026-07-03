# PR Explainer AI

GitHub Action that generates an interactive HTML review from a Pull Request diff.

The final artifact includes:

- architectural background
- change intuition
- HTML diagrams
- code walkthrough
- interactive 5-question quiz

## Product Decision

This action is **OpenRouter-only** in v1.

Why:

- one API key covers many providers and models
- users can switch models without changing integrations
- the action surface stays small, clear, and maintainable
- you avoid vendor-specific branching inside the action

Users still remain free to choose any model through `openrouter_model`.

## Recommended Model Strategy

Recommended default:

- `deepseek/deepseek-v4-flash`

Example fixed models:

- `deepseek/deepseek-v4-flash`
- `anthropic/claude-sonnet-4.5`
- `openai/gpt-4.1`

This action uses a fixed default model to keep behavior predictable.
If users want a different model, they can override it with any model supported by OpenRouter.

## What the Action Does

1. Computes the diff between the current branch and the PR base branch.
2. Measures the total changed lines.
3. Skips generation when the diff exceeds the configured threshold.
4. Sends the diff to a model through OpenRouter.
5. Renders a standalone HTML file using the local template.
6. Uploads the HTML as a workflow artifact.
7. Optionally comments on the PR with the run link.

## Requirements

- The calling workflow should use `actions/checkout@v4` with `fetch-depth: 0`.
- The repository must define an `OPENROUTER_API_KEY` secret.
- If you want PR comments, grant `pull-requests: write`.
- The primary target is `pull_request` workflows.

## Basic Usage

```yaml
name: explain-pr

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  explain:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run PR Explainer
        uses: rafaeltorresng/pr-explainer-action@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          openrouter_model: deepseek/deepseek-v4-flash
          max_lines: '5000'
```

## Label-Gated Usage

```yaml
name: explain-pr

on:
  pull_request:
    types: [labeled]

jobs:
  explain:
    if: github.event.label.name == 'explain'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run PR Explainer
        uses: rafaeltorresng/pr-explainer-action@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          openrouter_model: deepseek/deepseek-v4-flash
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `openrouter_api_key` | yes | - | OpenRouter API key. |
| `max_lines` | no | `5000` | Maximum added + removed lines before skipping generation. |
| `openrouter_model` | no | `deepseek/deepseek-v4-flash` | Model sent to OpenRouter. Users can override it with any supported model. |
| `output_file` | no | `pr-explanation.html` | Output HTML filename. |
| `artifact_name` | no | `pr-explanation-html` | Uploaded artifact name. |
| `base_ref` | no | empty | Override for the base branch used in `git diff`. |
| `comment_on_pr` | no | `true` | Posts a PR comment with artifact instructions. |

## Outputs

| Output | Description |
| --- | --- |
| `should_run` | `true` when generation runs, `false` when skipped by size. |
| `lines_changed` | Total added + removed lines in the diff. |
| `artifact_name` | Uploaded artifact name. |

## Security and Limitations

- In workflows triggered from **forks**, GitHub does not pass repository secrets to the runner except for `GITHUB_TOKEN`.
- If `OPENROUTER_API_KEY` is missing, the action fails.
- This action is best suited for internal PRs and trusted workflow events.
- If you adopt `pull_request_target`, isolate checkout and execution carefully.

## What Is Still Needed Before Marketplace Release

Checklist:

- public repository
- a single `action.yml` at the repository root
- an available action name on GitHub Marketplace
- a clear README with usage and limits
- license file
- initial `v1.0.0` tag
- moving `v1` tag
- GitHub Marketplace terms accepted during publication

## Release Strategy

Recommended:

- immutable tags: `v1.0.0`, `v1.1.0`
- moving major tag: `v1`

## CI

The workflow in `.github/workflows/ci.yml` validates the basic action flow with a mocked OpenRouter response and confirms that the final HTML is rendered.

## Repository Files

- `action.yml`
- `README.md`
- `explain-pr.js`
- `template.html`
- `.github/workflows/ci.yml`
- `LICENSE`
