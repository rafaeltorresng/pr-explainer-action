# PR Explainer AI — plano de execução

Plano de trabalho proposto em 9 de novembro de 2026; complementa [direção de produto](2026-11-09-evolution-direction.md) e [descoberta](2026-11-09-product-discovery.md). Issues públicas são intencionalmente objetivas e não contêm dados privados. Este documento detalha sequência, critérios e decisões; não altera produção, publica relatórios ou autoriza chamadas pagas.

## Mapa das frentes

| Frente | Issues | Entrega verificável |
|---|---|---|
| Avaliação e confiança | [#6](https://github.com/rafaeltorresng/pr-explainer-action/issues/6), [#7](https://github.com/rafaeltorresng/pr-explainer-action/issues/7), [#8](https://github.com/rafaeltorresng/pr-explainer-action/issues/8) | corpus autorizado, conteúdo seguro, evidências e limites visíveis |
| Contexto e inferência | [#9](https://github.com/rafaeltorresng/pr-explainer-action/issues/9), [#10](https://github.com/rafaeltorresng/pr-explainer-action/issues/10), [#11](https://github.com/rafaeltorresng/pr-explainer-action/issues/11) | recuperação limitada e provedores compatíveis, sem quebrar configuração atual |
| Experiência | [#12](https://github.com/rafaeltorresng/pr-explainer-action/issues/12), [#13](https://github.com/rafaeltorresng/pr-explainer-action/issues/13) | relatório editorial acessível e componentes adaptativos controlados |
| GitHub e distribuição | [#14](https://github.com/rafaeltorresng/pr-explainer-action/issues/14), [#15](https://github.com/rafaeltorresng/pr-explainer-action/issues/15), [#16](https://github.com/rafaeltorresng/pr-explainer-action/issues/16) | atualização manual, Markdown privado e estudo de Pages público |
| Adoção e apresentação | [#17](https://github.com/rafaeltorresng/pr-explainer-action/issues/17), [#18](https://github.com/rafaeltorresng/pr-explainer-action/issues/18) | documentação de instalação, privacidade e provedor; landing apenas após validação |

## Estratégia de trabalho

As atividades são agrupadas por resultados, não por microcorreções isoladas. As frentes podem avançar em conjunto quando não houver conflitos; a avaliação e as fronteiras de confiança orientam as demais. Proteger compatibilidade enquanto se explora a nova estrutura: não trocar o comportamento público ou alegar paridade até haver migração e testes. Design editorial será refinado em uma etapa visual mais profunda com amostras reais.

### Marco A — evidência, segurança e contratos

1. Criar fixtures sintéticas e públicas que reproduzam dificuldades reais sem copiar código privado; manter referências e comparação com PRs privados somente em ambiente autorizado.
2. Estabelecer baseline offline: fontes analisadas, tamanho, omissões, parsing, falhas e contratos atuais. Definir rubrica para conteúdo com critérios explícitos e avaliação humana de afirmações.
3. Projetar conteúdo semântico versionado e renderização controlada. Diferenciar dados de apresentação; escapar texto e código; verificar referências contra SHA. Diagramas representam dados validados, não HTML ou scripts produzidos pelo modelo.
4. Definir como apresentar respostas parciais úteis, omissões e discrepância entre descrição e diff. Rejeitar resposta inválida ou insegura; não presumir que schema válido garante correção.

**Verificar:** testes de dados maliciosos, referências inválidas, quiz ausente, truncamento e conteúdo parcial; conteúdo de PR e resposta do modelo nunca viram execução arbitrária. Avaliar impacto na compatibilidade antes de mudar o formato.

### Marco B — contexto e provedores

1. Fixar base/head e semântica do diff; recuperar texto do snapshot, não executar código de PR. Testar resolução de script literal adicionado em workflow, com paths seguros, arquivos pequenos, sem expansão arbitrária, com opção de desligar.
2. Definir orçamento global de prompt, diff, descrição, contexto e saída, com cortes explícitos. Limites de bytes são apenas proxy para tokens; custo é estimado salvo dados confiáveis do provedor. Não enviar mais contexto a custo da cobertura do diff sem comunicar.
3. Implementar transporte comum compatível com Chat Completions, com opções e normalização mínimas por serviço. Preservar `openrouter_api_key`, `openrouter_model` e defaults existentes; especificar regras de precedência e erros para combinações ambíguas antes da implementação.
4. Testar respostas de sucesso, formato inválido, truncamento, recusa, timeout, erro permanente, rate limit, retry e contagem de uso. Evitar fallback silencioso de formato, modelo ou provedor.

**Verificar:** testes de contrato com mocks para os seis serviços e regressão OpenRouter; snapshots e caminhos seguros; limites e omissões. A avaliação A/B com modelos reais e smoke tests dependem de autorização e teto financeiro explícitos. A capacidade de cada modelo não é garantida por um mock.

### Marco C — experiência visual e didática

1. Construir a página independente em torno da visão geral, narrativa, evidências e walkthrough, com design claro e identidade própria. Templates e componentes devem funcionar em inglês e português, inclusive estados parciais.
2. Selecionar visualizações por relevância; não impor um diagrama. Quiz é opcional e proporcional à mudança.
3. Explorar simulações com conjunto limitado de cenários cuja fidelidade possa ser sustentada por código/testes. Não executar expressões ou JS do modelo; quando não for possível garantir o escopo, exibir exemplo ilustrativo ou apenas narrativa.
4. Iterar com exemplos de lógica, UI e infraestrutura; inspecionar desktop/mobile e testar teclado, contraste, reduced motion e uso offline.

**Verificar:** artefatos locais representativos, interações e estados vazios; inspeção visual real quando o ambiente permitir. Não confundir protótipo conceitual com UX validada. A ausência de acesso ao navegador local na investigação inicial permanece limitação até ser resolvida por meio permitido.

### Marco D — ciclo de vida e distribuição GitHub

1. Eventos de abertura, reabertura e pronto para revisão, inclusive abertura draft; ao receber commits, atualizar apenas status desatualizado, sem nova inferência. `/explain` exige permissão de escrita verificada; falhar fechado. Tratar apenas comentários válidos em PRs, deduplicar, fixar SHA e lidar com corrida entre execuções.
2. Atualizar comentário Markdown identificado e preservar último sucesso em falha; não confiar em `author_association` como prova suficiente de permissão. Verificar permissões e não executar código de fork em ambiente privilegiado.
3. Expor link direto autenticado do artifact e retenção configurável, sem prometer persistência da interatividade. Verificar que Markdown continua acessível após expiração do artifact.
4. Prova de conceito de Pages somente em ambiente de teste autorizado: site vazio e site preexistente, múltiplos PRs, serialização, configuração, exclusão e proteção contra publicação indevida. Publicação pública depende de opt-in; não oferecer Pages privado como universal.

**Verificar:** testes de eventos, permissões, concorrência, reruns antigos, falhas parciais, expiração e forks; site existente não é sobrescrito. Entrega com Pages não entra como padrão antes de validação prática.

### Marco E — lançamento e adoção

Documentar exemplos de instalação, configuração, permissões, forks, privacidade, custos e funcionamento das saídas. Validar upgrade dos inputs existentes e estabelecer política de release. Landing e demonstração pública só após existir um exemplo revisado sem conteúdo privado e um produto representativo.

**Verificar:** execução local/CI apropriada, documentação testada contra comportamento efetivo e revisão de riscos de privacidade e supply chain. Não publicar release, abrir PR ou fazer commit sem pedido explícito.

## Matriz de decisão e limites

- **Já alinhado:** experiência principal independente; uso em revisão e aprendizado; light editorial com personalidade; contexto seletivo opt-out; seis serviços de inferência; quiz adaptativo; `/explain` para quem tem escrita; público Pages opt-in e privado Markdown + artifact como direção.
- **A definir na implementação:** schema e política de compatibilidade; configuração exata dos providers; seleção dos modelos e capacidades; limites mensuráveis; regras de status de atualização e concorrência; como integrar Pages ao site existente; prova de fidelidade de simulações; histórico e retenção.
- **Exige autorização adicional:** qualquer chamada paga ou uso de credencial de provedor, com modelo(s) e limite de gasto; publicação de protótipos, alterações em infra e releases. O acesso anterior a artifacts privados não autoriza sua publicação.
- **Segurança antes de publicação:** conteúdo do modelo é não confiável; nenhum conteúdo privado deve ser publicado em Pages público ou Gist secreto. Redação de segredos é imperfeita e precisa vir acompanhada de minimização de dados.
