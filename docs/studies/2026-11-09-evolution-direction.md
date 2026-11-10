# PR Explainer AI — direção de evolução

Documento de discussão, 9 de novembro de 2026. Complementa [a descoberta e auditoria](2026-11-09-product-discovery.md). Não autoriza implementação, publicação ou chamadas pagas.

## Produto que estamos buscando

Uma Action open source que transforma um PR em uma experiência independente de compreensão técnica: oferece uma visão rápida para revisão e permite aprofundamento e aprendizagem posterior. Explicações devem identificar evidências, separar intenção do autor e inferências, declarar limitações e não sugerir certeza onde não há. A experiência é predominantemente clara e editorial, com identidade própria; a direção visual foi aprovada como ponto de partida, com refinamento posterior.

A apresentação adapta-se à mudança por meio de componentes controlados. Diagramas e interações existem quando ajudam a compreender o caso. Quiz é opcional e adaptativo. Simulações só representam cenários verificáveis e escopo limitado; quando isso não puder ser sustentado, usar explicação ou diagrama com limites claros. O modelo não deve criar JavaScript, HTML ou expressões arbitrárias executáveis.

## Decisões de produto alinhadas

- Suportar OpenRouter e Featherless e integrações diretas OpenAI, Anthropic, xAI e Gemini; preservar inputs OpenRouter e comportamento padrão. Favorecer transporte compartilhado quando os contratos permitirem; diferenças documentadas e comprovadas podem exigir adaptações pequenas ou APIs nativas.
- Contexto adicional automático, seletivo, limitado e desativável. Começar investigando referências literais a scripts adicionadas em workflows; diff, arquivos e referências devem pertencer ao mesmo snapshot Git. Excluir conteúdos não autorizados ou sensíveis conforme política; informar o que foi selecionado e omitido. O uso de contexto adicional não deve impor explicações maiores.
- Permitir saída parcial útil com lacunas visíveis; falhar para respostas inválidas ou inseguras. Validação estrutural e citações verificadas não demonstram que toda interpretação é verdadeira.
- Em público, investigar Pages com opt-in explícito, sem substituir site já existente; em privado, Markdown persistente no PR + artifact HTML autenticado temporário. Não depender de infraestrutura externa. HTML privado durável e leitura direta continuam sem solução geral simples.
- Gerar na abertura, inclusive draft, na reabertura e quando pronto para revisão; não gerar a cada commit. Atualizar manualmente via `/explain`, inicialmente para usuários com permissão de escrita. Marcar relatório desatualizado ao mudar SHA sem gerar. Detalhes dos eventos, deduplicação, privacidade em forks e tratamento de falhas requerem validação.
- Manter a Action simples de adotar, sem quebrar usuários atuais. Decisões sobre formato público dos inputs e versão de lançamento ainda não foram tomadas.

## Sequência proposta

Estas frentes têm dependências e podem ser desenvolvidas de forma coordenada após o planejamento de execução; não são autorização para agir agora.

### 1. Base de avaliação e segurança

Congelar PRs reais autorizados, incluindo o caso do worker e casos de UI, backend, infra, descrição enganosa e PRs grandes; documentar evidências e respostas esperadas sem expor dados privados em fixtures públicas. Criar avaliação cega de fidelidade e utilidade e casos adversariais. Eliminar HTML e scripts arbitrários provenientes do modelo no caminho de publicação; estruturar conteúdo, validar e escapar. Modelar fontes, SHA, limites e resultados parciais.

**Aceite proposto:** nenhum conteúdo não confiável é executado no relatório; referências apontam para o snapshot validado; limites e estado parcial são visíveis; casos de prompt injection e conteúdo malformado são testados. Uma validação estrutural não é tratada como verificação factual.

### 2. Pipeline e provedores

Separar levemente o transporte e a normalização do pipeline; definir contrato de provedores/modelos e preservar OpenRouter atual. Usar transporte compatível compartilhado com configurações específicas somente quando necessário. Tratar saída estruturada, recusa, truncamento, `finish_reason`, usage, falhas temporárias e permanentes, timeout fim a fim e limites. Evitar fallback silencioso de modelo/provedor ou de garantias. Configurar contexto seletivo, com seleção e cortes transparentes.

**Aceite proposto:** testes de contrato por provedor e regressão dos inputs atuais; teste determinístico do contexto do PR 3008, limites e exclusões; erros claros sem tentativas desnecessárias. Mocks não provam compatibilidade real; smoke tests exigem autorização e orçamento. A melhoria de fidelidade precisa ser avaliada comparando variantes com mesmos PRs e modelo.

### 3. Experiência editorial adaptativa

Projetar conteúdo estruturado e renderer leve, compartilhado entre idiomas e independente de serviço externo. Prototipar abertura, navegação, comparação/fluxo, walkthrough com evidências e quiz opcional. Explorar simulação limitada somente onde a correspondência com código ou testes puder ser sustentada; não generalizar o protótipo manual para qualquer PR. Testar desktop, mobile, teclado, contraste, movimento reduzido, ausência de rede e estados parciais. Refinar identidade visual com exemplos de tipos de PR distintos.

**Aceite proposto:** leitores conseguem identificar mecanismo central, navegar até evidência e reconhecer o que não foi comprovado; componentes funcionam sem dependências CDN obrigatórias; resultados de acessibilidade e teste visual são registrados, não presumidos.

### 4. Integração GitHub e ciclo de vida

Implementar eventos acordados, comando autorizado, controle de concorrência, idempotência e estado de desatualização sem executar inferência em cada commit. Comment Markdown persistente atualizado e link autenticado direto ao artifact com retenção configurável. Para Pages público, primeiro protótipo isolado que preserve sites e relatórios existentes, respeite permissões e faça publicação opt-in; cenário privado nunca deve ser publicado em destino público por padrão.

**Aceite proposto:** testes com forks, atores sem permissão, execução antiga, falha parcial, atualizações concorrentes, expiração e preservação do último sucesso. Não executar código de PR não confiável em contexto com secrets. Provar que Pages existente não é sobrescrito antes de recomendar sua ativação.

### 5. Distribuição, documentação e validação de produto

Melhorar instalação, permissões e orientação de provedores, dados enviados, privacidade e custos. Avaliar utilidade com revisores e pessoas de onboarding em PRs representativos; medir fidelidade, cobertura, tempo, latência e custo inclusive retries. Landing é uma possibilidade posterior, baseada em demonstração pública revisada e produto real.

## Questões ainda abertas

1. Formato exato dos inputs de provider/model/key, tratamento de conflitos e versão de compatibilidade.
2. Quais modelos e teto financeiro para smoke tests e avaliação real; nenhuma credencial foi autorizada até agora.
3. Onde persistir conteúdo estruturado, retenção e histórico de versões; como integrar com Pages já existente sem sobreposição.
4. Escopo inicial de componentes adaptativos e método efetivo de verificar cenários de simulação. Nenhuma garantia geral é presumida.
5. Política de seleção/exclusão de contexto e limites de tokens/custo mensuráveis por modelo; avaliação com casos reais precisa justificar ampliar heurísticas.
6. Produto e mecanismo exatos de indicação de desatualização quando chega um commit sem geração; concorrência e políticas de fork/organização.
7. Quando e como refinar a identidade visual e avaliar com leitores; não confundir protótipos com interface testada.

## Limites e próximos passos

A investigação não fez chamadas pagas, alterações de implementação, publicação ou mudanças em recursos remotos. Antes de executar, transformar esta direção em plano detalhado com escopo, compatibilidade, fixtures e verificação; combinar separadamente autorização e teto para chamadas pagas. O estudo inicial contém evidências e limitações da inspeção visual.
