# vault-mcp em nível enterprise — design

**Data:** 2026-11-22 · **Branch:** `feat/enterprise-tier` · **Versão alvo:** 0.6.0

## Pedido

> this application must be enterprise tier. find everything we can and should improve

Seguido, depois da auditoria com 19 achados numerados mais os de higiene, de: **"do them all"**.

## De onde partimos

Auditoria de 2026-11-22 sobre a 0.5.0 (22 arquivos de teste, 1.242 testes verdes). O núcleo de um
usuário em uma sessão é sólido: todas as sondas de segurança seguraram. O que falta para o nível
pedido está em sete frentes, e cada uma é um trecho deste documento. As medições que justificam cada
decisão estão no vault (`03-projects/vault-mcp/README.md`, "Limitações conhecidas") e nas duas
notas de `02-wiki/patterns/` que ele aponta.

## Decisões que valem para tudo

- **Nada do que existe quebra.** Nome de parâmetro em português continua aceito; layout atual do
  vault é o padrão do layout configurável; saída estruturada do `vault_graph` não muda (é contrato
  do deck do fleetmates).
- **Zero dependência nova de runtime.** Continuam `@modelcontextprotocol/sdk`, `zod` e
  `gray-matter`. Sem LLM, sem embeddings, sem banco: decisão registrada no vault e mantida.
- **Todo limite novo é configurável por ambiente** e tem padrão que não muda o comportamento de um
  vault do tamanho do atual (709 notas).
- **Teste primeiro**, e onde o defeito é corrida entre processos o teste sobe processos de verdade.

## 1. Integridade dos dados

**Problema medido:** a `WriteQueue` serializa dentro de UM processo, e cada cliente MCP sobe o seu.
Oito processos editando a mesma nota: oito sucessos, seis ou sete edições no arquivo.

**Lock de vault entre processos** (`src/write/vault-lock.ts`). Um arquivo criado com
`O_CREAT|O_EXCL`, contendo `{pid, host, token, at}`:

- Fica em `<gitdir>/vault-mcp.lock` quando o vault é repositório, e em `<vault>/.vault-mcp.lock`
  quando não é. O caminho deriva SÓ do vault: um lock em `os.tmpdir()` não serve, porque dois
  clientes podem ter `TMPDIR` diferentes e nunca se enxergariam.
- Espera com recuo e jitter até 30 s (`VAULT_LOCK_TIMEOUT_MS`). Estourou: a escrita é RECUSADA com
  código `lock.timeout`. Recusar é a direção segura; escrever sem exclusão é o defeito.
- Lock velho é tomado quando o `pid` do mesmo host não existe mais, ou quando passa de 2 min. A
  tomada é por `rename` para um nome único: de dois que tentam, só um consegue.
- Envolve ler-modificar-escrever-commitar. O **push fica fora** do lock: `git push` leva o branch
  inteiro, e um push preso na rede não pode segurar os outros escritores por 30 s.
- A `WriteQueue` continua: o lock é tomado DENTRO do slot dela.

**Git que aguenta contenção** (`src/write/git.ts`):

- `add` e `commit` são repetidos com espera (até ~3 s) quando `<gitdir>/index.lock` EXISTE. A
  decisão olha o arquivo, nunca a prosa do git, pela regra que o módulo já tem.
- Commit que falha vai para um diário (`<gitdir>/vault-mcp-pending.json`). A escrita seguinte, já
  com o lock, tenta de novo cada entrada antes de commitar a própria. Entrada que falha cinco vezes
  sai do diário com aviso.
- Vault que não é repositório responde UM aviso com código (`git.notARepo`), em vez do stderr cru
  do git a cada escrita.

**`vault_learn` só anexa dentro do mesmo domínio.** Tag em comum deixa de bastar: o caso de
2026-11-08 (aprendizado de `trading` anexado a uma nota de `rustot`) é exatamente o que a regra
"tag OU domínio" permite. Topo em outro domínio vira nota nova, com o motivo dizendo qual nota
parecida existe.

**`vault_status`** (tool nova, só leitura): versão, repositório sim/não, branch ou HEAD solto,
commits à frente do upstream, entradas no diário de pendências, dono do lock, notas, chunks,
diagnósticos do scanner, modo somente-leitura. É a superfície de operação que não existia.

## 2. Limites e recuperação

- **Chunk oco não é indexado.** Um chunk que, tirando a linha de heading, só tem espaço, marcador
  de lista vazio e cerca de código vazia, não vira chunk. Medido: 36% do índice, 22,7% dos slots.
  Simulado: nada piora. O desempate do ranking passa a ser `(path, lineStart numérico)`.
- **`vault_list`** ganha `limit` (padrão 200, teto 1.000) e `offset`, com o total e de onde
  continuar. Mesmo desenho do `offset` do `vault_get_note`.
- **Diff repassado tem teto** (20.000 caracteres, com marca de corte) em toda tool de escrita.
- **Entrada tem teto**: conteúdo e trechos de edição 1 MB, `insight` 200 mil caracteres.
- **Scanner**: arquivo acima de 5 MB (`VAULT_MAX_NOTE_BYTES`) e arquivo com byte NUL saem do índice
  com diagnóstico; symlink pulado passa a ter diagnóstico, como hard link já tem.
- **Argumento desconhecido é recusado** (`.strict()`): um filtro digitado errado deixa de virar
  busca sem filtro.

## 3. Cadeia de suprimentos e release

- `npm audit fix`, pisos de versão iguais ao que se testa, `zod` 4 (o aviso de memória não tem
  correção na 3) e `engines.node >= 22` (a 20 saiu de suporte em abril de 2026).
- CI: `permissions: contents: read`, actions fixadas por SHA, `npm audit` de produção, lint e
  cobertura. `dependabot.yml` para npm e actions.
- Workflow de release por tag: testes, build, GitHub Release com a seção do CHANGELOG e
  `npm publish --provenance` por trusted publishing (OIDC). O cadastro do publisher no npm é passo
  do dono, uma vez.
- `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODEOWNERS`.
- No GitHub: secret scanning, push protection, alertas e correções do Dependabot, relato privado
  de vulnerabilidade e um ruleset em `main` que proíbe force-push e apagar o branch. NÃO exige PR:
  o dono dá push direto de release em `main`.

## 4. Operação e protocolo

- **Annotations e título** nas tools: `readOnlyHint` nas de leitura; `destructiveHint: false` só
  em `vault_learn`, a única escrita que só acrescenta; `idempotentHint` em `vault_write_note`;
  `openWorldHint: false` em todas.
- **Log** em stderr, uma linha JSON por evento, nível por `VAULT_LOG_LEVEL` (padrão `warn`): start,
  configuração inválida, vault sem git, chamada lenta, falha de commit. O servidor também declara a
  capability `logging` do MCP e manda os mesmos eventos ao cliente.
- **Desligamento limpo**: SIGTERM/SIGINT esperam a escrita em curso (até 5 s), soltam o lock e saem.
- **Somente leitura**: `VAULT_READ_ONLY=1` não registra tool de escrita; `VAULT_DISABLED_TOOLS`
  tira tools pelo nome.
- **Erro com código** em `structuredContent.error` em toda recusa que tem código. Saída
  estruturada em `vault_list`, `vault_backlinks` e `vault_status`. **`vault_search` e
  `vault_get_note` continuam só texto, de propósito**: o texto citado e escapado é a defesa contra
  conteúdo do vault se passar por instrução, e um cliente que preferisse o JSON a perderia.
- **Fora:** resources e prompts do MCP. As tools já leem tudo, e um resource devolveria o corpo
  sem orçamento e sem o escape.

## 5. Escala

- **Validade adaptativa do scan.** Hoje toda chamada anda o vault inteiro (291 ms com 20 mil
  notas). Um scan que custou menos de 20 ms nunca é reaproveitado, então vault pequeno e a suíte
  não mudam; acima disso o resultado vale por dez vezes o custo, até 2 s. Escrita deste processo
  invalida na hora. `VAULT_SCAN_TTL_MS` fixa o valor (0 desliga).
- **Memória.** Internar os termos do índice (hoje cada chunk guarda a própria cópia de cada string)
  e medir. `scripts/bench.mjs` gera um vault sintético e imprime tempos e RSS, para a próxima
  mudança ser medida do mesmo jeito.
- **Fora:** indexação assíncrona em fatias e índice persistido. O start frio de 6 s com 20 mil notas
  continua síncrono; para um servidor stdio a fatia só melhoraria a resposta a `ping`.

## 6. Produto

- **Nomes de parâmetro em inglês** no schema (`title`, `context`, `domain`, `project`,
  `confirm_new_domain`, `type`). Os nomes em português continuam aceitos nos dois pontos de
  entrada: no handler e num decorador do transporte que os troca ANTES da validação do SDK. É o
  único jeito de aceitar os dois sem tirar o `required` do schema publicado.
- **Layout configurável** em `<vault>/.vault-mcp.json`: nomes das sete pastas e dos títulos de
  seção. Padrão é o layout de hoje. O arquivo fica no vault porque todo cliente tem de concordar.
  Chaves de frontmatter (`tipo`, `criado`, `atualizado`) ficam fixas nesta versão.
- **Avisos e motivos traduzidos** com `VAULT_LANG=en`: os de git, de mover/reescrever links e o
  `Reason` do `vault_learn`, que eram a exceção declarada em `lang.ts`.

## 7. Higiene

- Biome como linter (o typescript-eslint não aceita TypeScript 7); formatter desligado, para não reescrever a árvore inteira num diff só.
- Cobertura com piso no valor medido.
- Teste de corrida entre processos, de teto de tamanho e de contagem de `stat` no scan.
- Link NFC contra arquivo NFD resolve; nome de arquivo longo demais vira erro com código.
- `src/server/tools.ts` (1.950 linhas) vira módulos em `src/server/tools/`, com o arquivo atual
  como barrel. Movimento puro, no fim, para o diff das outras frentes ficar legível.
- Documentação: os dois READMEs, `followups.md`, comentários do CI. Contagem de teste sai da prosa,
  porque já envelheceu três vezes.

## O que este trabalho não faz

- Publicar no npm e no MCP Registry (passkey e device flow do dono).
- Assinar commits (chave do dono).
- Embeddings, stemming, decomposição de composto: decisões registradas.
