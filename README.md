# PR Explainer AI

GitHub Action para gerar uma revisão interativa em HTML a partir do diff de um Pull Request.

O artefato final inclui:

- contexto arquitetural
- intuição da mudança
- diagramas em HTML
- walkthrough de código
- quiz interativo com 5 perguntas

## Decisão de Produto

Esta action é **OpenRouter-only** no v1.

Motivos:

- uma única API key cobre muitos providers e modelos
- o usuário pode trocar de modelo sem trocar de integração
- a superfície da action fica pequena, clara e fácil de manter
- você evita ramificações de código por vendor

O usuário continua livre para escolher o modelo via `openrouter_model`.

## Estratégia Recomendada de Modelo

Default recomendado:

- `openrouter/auto`

Exemplos de modelos fixos:

- `deepseek/deepseek-chat`
- `anthropic/claude-sonnet-4.5`
- `openai/gpt-4.1`

Se você quer menor atrito de adoção, use `openrouter/auto`.
Se você quer previsibilidade máxima de custo e comportamento, fixe um modelo específico.

## O Que a Action Faz

1. Faz checkout do diff entre a branch atual e a branch base do PR.
2. Mede o total de linhas alteradas.
3. Pula a geração quando o diff ultrapassa o limite configurado.
4. Envia o diff para um modelo via OpenRouter.
5. Renderiza um HTML standalone com o template local.
6. Faz upload do HTML como artifact.
7. Opcionalmente comenta no PR com o link da execução.

## Requisitos

- O workflow chamador deve usar `actions/checkout@v4` com `fetch-depth: 0`.
- O repositório deve ter um secret `OPENROUTER_API_KEY`.
- Se você quer comentários no PR, conceda `pull-requests: write`.
- O uso principal é em eventos `pull_request`.

## Uso Básico

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
        uses: rafaeltorres/pr-explainer-action@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          openrouter_model: openrouter/auto
          max_lines: '5000'
```

## Uso Com Gatilho por Label

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
        uses: rafaeltorres/pr-explainer-action@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          openrouter_model: openrouter/auto
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `openrouter_api_key` | yes | - | Chave da OpenRouter. |
| `max_lines` | no | `5000` | Máximo de linhas adicionadas + removidas antes de pular. |
| `openrouter_model` | no | `openrouter/auto` | Modelo enviado para a OpenRouter. |
| `output_file` | no | `pr-explanation.html` | Nome do HTML gerado. |
| `artifact_name` | no | `pr-explanation-html` | Nome do artifact enviado. |
| `base_ref` | no | vazio | Override da branch base usada no `git diff`. |
| `comment_on_pr` | no | `true` | Publica comentário no PR com instruções do artifact. |

## Outputs

| Output | Description |
| --- | --- |
| `should_run` | `true` quando a geração executa; `false` quando pula por tamanho. |
| `lines_changed` | Total de linhas adicionadas + removidas no diff. |
| `artifact_name` | Nome do artifact enviado. |

## Segurança e Limitações

- Em workflows disparados por **forks**, o GitHub não envia secrets ao runner, exceto `GITHUB_TOKEN`.
- Se `OPENROUTER_API_KEY` não existir, a action falha.
- Essa action é mais adequada para PRs internos e eventos confiáveis.
- Se você considerar `pull_request_target`, trate checkout e execução com extremo cuidado.

## O Que Falta para Publicar no Marketplace

Checklist objetivo:

- repositório público
- `action.yml` único na raiz
- nome da action disponível no Marketplace
- README claro com uso e limitações
- licença
- tag inicial `v1.0.0`
- tag móvel `v1`
- termos do Marketplace aceitos na hora da publicação

## Estratégia de Release

Recomendado:

- tags imutáveis: `v1.0.0`, `v1.1.0`
- tag maior móvel: `v1`

## CI

O workflow em `.github/workflows/ci.yml` valida o fluxo básico da action com uma resposta mockada da OpenRouter e garante que o HTML final é renderizado.

## Arquivos do Repositório

- `action.yml`
- `README.md`
- `explain-pr.js`
- `template.html`
- `.github/workflows/ci.yml`
- `LICENSE`
