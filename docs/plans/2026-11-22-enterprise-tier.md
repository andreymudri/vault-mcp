# vault-mcp em nível enterprise — plano de implementação

Spec: `docs/specs/2026-11-22-enterprise-tier-design.md`. Execução inline, na ordem das tarefas.

## Statement

this application must be enterprise tier. find everything we can and should improve

do them all

("them" são os 19 achados numerados e os itens de higiene da auditoria de 2026-11-22, agrupados em
sete frentes: integridade dos dados, limites e recuperação, cadeia de suprimentos e release,
operação e protocolo, escala, produto, higiene.)

## Destination

Dois clientes MCP no mesmo vault não perdem escrita um do outro; nenhuma resposta nem o consumo de
memória crescem sem teto com o tamanho do vault ou da entrada; quem opera o servidor consegue ver o
estado dele, restringi-lo a leitura e ler um log; o pacote sai por um caminho de release auditável,
com dependências sem aviso de segurança em runtime; e um vault que não segue a convenção do autor
consegue usar o servidor com nomes de parâmetro em inglês.

## Acceptance

- Oito processos editando trechos diferentes da mesma nota deixam as oito edições no arquivo
- Seis processos em `vault_learn` no mesmo domínio deixam seis entradas no MOC e nenhum arquivo sem commit
- Um commit que falhou por `index.lock` é refeito na escrita seguinte, e `vault_status` o mostra enquanto pende
- `vault_learn` não anexa a uma nota de outro domínio por causa de uma tag em comum
- Seção vazia de template não aparece em resultado de busca
- `vault_list` sem filtro responde no máximo `limit` notas e diz como continuar
- A resposta de `vault_learn` tem teto de tamanho, e entrada acima do teto é recusada
- Um `.md` acima do teto de bytes ou binário sai do índice com diagnóstico
- Argumento desconhecido numa tool é recusado
- `npm audit --omit=dev` não lista aviso `high` nem `critical`
- O CI roda com `permissions` mínimas, actions fixadas por SHA, lint e cobertura
- Existem `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `dependabot.yml` e um workflow de release com provenance
- O repositório no GitHub tem secret scanning, push protection, Dependabot e ruleset em `main`
- Cada tag existente tem um GitHub Release
- Toda tool publica annotations e título
- O servidor escreve log estruturado em stderr no nível pedido e avisa de configuração inválida
- SIGTERM durante uma escrita deixa a escrita terminar e o lock solto
- `VAULT_READ_ONLY=1` não publica tool de escrita
- Toda recusa com código carrega o código no resultado, em `_meta["io.github.andreymudri/vault-mcp.error"]` (era `structuredContent.error`: o review final mostrou que isso quebra o `outputSchema` de três tools)
- Com o scan caro, chamadas seguidas dentro da validade não refazem `stat` do vault
- O índice de 20 mil notas sintéticas usa menos memória que antes, medido por `scripts/bench.mjs`
- O schema publicado usa nomes de parâmetro em inglês e os nomes em português continuam aceitos
- Um vault com pastas renomeadas em `.vault-mcp.json` é indexado e escrito nas pastas dele
- Com `VAULT_LANG=en`, avisos de git e o motivo do `vault_learn` saem em inglês
- `npm run lint` passa e a cobertura tem piso
- Link NFC resolve para arquivo NFD
- `src/server/tools.ts` deixa de ser um arquivo de 1.950 linhas
- Os dois READMEs descrevem as onze tools, as variáveis novas e os limites, sem contagem de teste na prosa

## Out of Scope

- Publicar no npm e no MCP Registry — exigem passkey e device flow do dono; o workflow e a versão ficam prontos.
- Assinar commits — depende de uma chave que só o dono tem e de configuração do git dele.
- Resources e prompts do MCP — as tools já leem tudo, e um resource devolveria corpo sem orçamento e sem escape.
- Indexação assíncrona em fatias e índice persistido em disco — o start frio continua síncrono.
- Tornar configuráveis as chaves de frontmatter (`tipo`, `criado`, `atualizado`) — elas atravessam scanner, chunker, template e propagação, e o destino só pede pastas e seções.
- Embeddings, stemming e decomposição de termo composto — decisões registradas no vault.

## Global Constraints

- Node >= 22 em runtime; a suíte roda em Node 26
- Zero dependência nova de runtime (ficam `@modelcontextprotocol/sdk`, `zod`, `gray-matter`)
- TypeScript strict, ESM, imports com sufixo `.js`
- Comentários de código em inglês; mensagem de commit em português, estilo conventional commits
- Toda string que o servidor diz ao cliente passa por `src/i18n/messages.ts`, nos dois idiomas
- Nada do que a 0.5.0 aceita deixa de ser aceito
- Teste primeiro: cada mudança de comportamento tem um teste visto falhando pelo motivo certo
- `npm test` e `npm run build && npm run smoke` verdes ao fim de cada frente

### Task 1: lock de vault entre processos

**Files:**
- Create: `src/write/vault-lock.ts`
- Test: `test/vault-lock.test.ts`

- [x] **Step 1:** Testes: adquire e solta; segundo `acquire` espera o primeiro; estoura com `lock.timeout`; toma lock de pid morto; toma lock mais velho que `staleMs`; não toma lock vivo; `release` de quem não é dono não apaga.
- [x] **Step 2:** `VaultLock` com `constructor({ lockPath, timeoutMs = 30_000, staleMs = 600_000, now, sleep })`, `acquire(): Promise<() => Promise<void>>`, `with<T>(task): Promise<T>`, `holder(): Promise<LockInfo | undefined>`, `releaseSync()`. Arquivo criado com `O_CREAT|O_EXCL|O_WRONLY`, conteúdo `{pid, host, token, at}`. Tomada de lock velho por `rename` para nome único.
- [x] **Step 3:** `resolveLockPath(vaultRoot)`: `<gitdir>/vault-mcp.lock` quando `.git` é diretório ou arquivo `gitdir:`; senão `<vault>/.vault-mcp.lock`.

### Task 2: git que aguenta contenção

**Files:**
- Modify: `src/write/git.ts`
- Modify: `src/i18n/messages.ts`
- Test: `test/git.test.ts`

- [x] **Step 1:** Testes: `index.lock` presente e removido durante a espera → commit acontece; `index.lock` que não sai → falha e entrada no diário; a chamada seguinte commita a pendência com a mensagem original; cinco falhas tiram a entrada; diretório que não é repositório → aviso com código `git.notARepo` e nada no diário; `push: false` não dá push.
- [x] **Step 2:** `gitDir(repoRoot)` com cache; `withIndexLockRetry` (esperas de 100, 200, 400, 800, 1600 ms, só quando `<gitdir>/index.lock` existe); diário em `<gitdir>/vault-mcp-pending.json` com `{paths, message, attempts, at}`; `pendingCommits(repoRoot)` exportado; `pushBranch` exportado como `pushIfEnabled`.
- [x] **Step 3:** `CommitResult` ganha `recovered?: number` e `warningCode?: string`.

### Task 3: lock e push adiado nas tools de escrita, com teste entre processos

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/write/writer.ts`
- Modify: `src/write/learn.ts`
- Modify: `src/write/relocate.ts`
- Modify: `src/i18n/messages.ts`
- Create: `test/helpers/ts-resolve.mjs`
- Create: `test/helpers/tool-worker.ts`
- Test: `test/cross-process.test.ts`

**Depends:** T1, T2

- [x] **Step 1:** Teste que sobe 8 processos com `vault_edit_note` na mesma nota e exige 8 edições e 8 commits; e 6 processos com `vault_learn` exigindo 6 notas, 6 entradas no MOC, 6 linhas na diária e árvore limpa. Visto falhando na 0.5.0.
- [x] **Step 2:** Opção `push?: boolean` em `writeNote`, `editNote`, `learn`, `moveNote`, `deleteNote`, repassada ao `commitFiles`.
- [x] **Step 3:** `ToolDeps.lock?: VaultLock`; `lockedWrite` em `createTools` = slot da fila → lock → tarefa com `push: false` → solta → push fora do lock → junta `pushed` e aviso.

### Task 4: vault_learn só anexa no mesmo domínio

**Files:**
- Modify: `src/write/learn.ts`
- Test: `test/learn.test.ts`

- [x] **Step 1:** Teste: topo em outro domínio com tag em comum → nota nova, motivo nomeando a nota parecida. Visto falhando.
- [x] **Step 2:** `decideDuplicate` exige `sameDomain`; a tag em comum deixa de ser condição suficiente.

### Task 5: tool vault_status

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/write/git.ts`
- Modify: `src/i18n/messages.ts`
- Modify: `scripts/smoke.mjs`
- Test: `test/tools.test.ts`

**Depends:** T2, T3

- [x] **Step 1:** Teste: responde versão, repositório, branch ou HEAD solto, à frente do upstream, pendências, dono do lock, notas, chunks, diagnósticos; em vault sem git diz que não há repositório.
- [x] **Step 2:** `repoState(repoRoot)` em `git.ts`; tool `vault_status` sem argumentos, com `outputSchema`.

### Task 6: chunk oco fora do índice e desempate numérico

**Files:**
- Modify: `src/index/chunker.ts`
- Modify: `src/retrieval/retrieval.ts`
- Test: `test/chunker.test.ts`
- Test: `test/retrieval.test.ts`

- [x] **Step 1:** Testes: seção só com heading, com `-` solto e com cerca vazia não vira chunk; seção com uma palavra vira; empate entre chunks da mesma nota sai em ordem de linha numérica.
- [x] **Step 2:** `isHollow(lines)` no `flush`; comparador por `(path, lineStart)`.

### Task 7: tetos de resposta e de entrada

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/i18n/messages.ts`
- Test: `test/tools.test.ts`

- [x] **Step 1:** Testes: `vault_list` com 450 notas devolve 200, diz o total e o próximo `offset`; `limit` e `offset` percorrem tudo sem repetir; diff acima de 20.000 caracteres sai cortado com marca; `content` acima de 1 MB e `insight` acima de 200 mil são recusados.
- [x] **Step 2:** `LIST_DEFAULT_LIMIT = 200`, `LIST_MAX_LIMIT = 1000`, `MAX_DIFF_CHARS = 20_000`, `MAX_WRITE_CHARS = 1_000_000`, `MAX_INSIGHT_CHARS = 200_000`.

### Task 8: tetos do scanner

**Files:**
- Modify: `src/vault/scanner.ts`
- Modify: `src/write/paths.ts`
- Modify: `src/i18n/messages.ts`
- Test: `test/scanner.test.ts`

- [x] **Step 1:** Testes: arquivo acima do teto não é lido (zero `readFile`) e gera `diag.tooLarge`; arquivo com NUL gera `diag.binary`; symlink para arquivo `.md` gera `diag.symlink`.
- [x] **Step 2:** `StatLike.size`; `VaultScannerOptions.maxNoteBytes` (padrão 5 MB, de `VAULT_MAX_NOTE_BYTES`); `DirEntry.isSymbolicLink()`.

### Task 9: argumento desconhecido é recusado

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/tools.test.ts`

- [x] **Step 1:** Teste: `vault_search({query, bogus: true})` é recusado nomeando `bogus`. Visto falhando.
- [x] **Step 2:** `z.object(shape).strict()` em `defineStructured`, com a mensagem traduzida em `describeIssues`.

### Task 10: dependências

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/server/tools.ts`

- [x] **Step 1:** `npm audit fix`; pisos `@modelcontextprotocol/sdk` e `zod` iguais ao instalado; migrar para `zod` 4; `engines.node >= 22`.
- [x] **Step 2:** `npm audit --omit=dev` sem `high`/`critical`; suíte verde.

### Task 11: CI, dependabot e workflow de release

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`

**Depends:** T10, T24

- [x] **Step 1:** `permissions: contents: read`; actions por SHA com a tag em comentário; passos `npm audit --omit=dev --audit-level=high`, `npm run lint`, cobertura; job de compatibilidade em Node 22.
- [x] **Step 2:** `release.yml` em tag `v*`: teste, build, smoke, `npm publish --provenance` por OIDC, GitHub Release com a seção do CHANGELOG.

### Task 12: documentos de governança

**Files:**
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `CONTRIBUTING.md`
- Create: `.github/CODEOWNERS`

- [x] **Step 1:** `SECURITY.md` com versões suportadas, como relatar e o modelo de ameaça; `CHANGELOG.md` no formato Keep a Changelog, com as sete versões existentes tiradas do `git log`; `CONTRIBUTING.md` com os comandos e as convenções.

### Task 13: configuração do repositório no GitHub

**Files:**
- Modify: `docs/followups.md`

**Depends:** T12

- [x] **Step 1:** Por `gh api`: secret scanning e push protection, alertas e correções do Dependabot, relato privado de vulnerabilidade, `delete_branch_on_merge`, ruleset em `main` (sem force-push, sem apagar).
- [ ] **Step 2:** Apagar `origin/feat/research-preview`, já contido em `main`. Criar um GitHub Release para cada uma das sete tags, com a seção correspondente do CHANGELOG. Registrar o que foi ligado.

### Task 14: annotations e títulos

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/server/index.ts`
- Modify: `src/i18n/messages.ts`
- Modify: `scripts/smoke.mjs`
- Test: `test/tools.test.ts`

- [x] **Step 1:** Teste: toda tool tem `title` e `annotations`; as de leitura têm `readOnlyHint: true`; só `vault_learn`, entre as de escrita, tem `destructiveHint: false` (é a única que só acrescenta — pela definição do spec, substituir, trocar trecho e mover não são aditivos).
- [x] **Step 2:** `ToolDefinition.title` e `.annotations`, repassados no `registerTool`; o smoke exige annotations.

### Task 15: log estruturado e validação de configuração

**Files:**
- Create: `src/server/logger.ts`
- Modify: `src/server/index.ts`
- Modify: `src/i18n/lang.ts`
- Test: `test/logger.test.ts`
- Test: `test/i18n.test.ts`

- [x] **Step 1:** Testes: nível filtra; cada linha é JSON com `ts`, `level`, `event`; raiz do vault sai redigida; `VAULT_LANG` inválido gera aviso; chamada de tool registra nome, duração e resultado.
- [x] **Step 2:** `createLogger({ level, write, redact })`; `VAULT_LOG_LEVEL` em `silent|error|warn|info|debug`, padrão `warn`; capability `logging` e `sendLoggingMessage`.

### Task 16: desligamento limpo

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/tools.ts`
- Test: `test/shutdown.test.ts`

**Depends:** T3, T15

- [x] **Step 1:** Teste com processo real: SIGTERM durante uma escrita lenta → a escrita termina, o lock some, saída 0.
- [x] **Step 2:** `WriteQueue.idle()`; handlers de SIGTERM/SIGINT com espera de até 5 s; `uncaughtException` e `unhandledRejection` registram e saem com 1.

### Task 17: modo somente leitura e tools desligadas

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/tools.ts`
- Modify: `server.json`
- Test: `test/tools.test.ts`

- [x] **Step 1:** Teste: `VAULT_READ_ONLY=1` publica só as tools de leitura; `VAULT_DISABLED_TOOLS=vault_delete` tira essa; nome desconhecido gera aviso.
- [x] **Step 2:** `ToolDefinition.writes: boolean`; `selectTools(tools, env)`.

### Task 18: código de erro estruturado e saída estruturada

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/tools.test.ts`

**Depends:** T5

- [x] **Step 1:** Testes: recusa por caminho fora do vault traz `structuredContent.error.code = 'path.outsideVault'`; entrada inválida traz `input.invalid`; erro de sistema de arquivos traz o errno; os parâmetros saem redigidos.
- [x] **Step 2:** Em `defineStructured`, toda falha vira `{ code, params }` no `_meta` do resultado (no plano original era `structuredContent.error`; mudou no review final, porque o `Client` do SDK valida `structuredContent` contra o `outputSchema` também em erro). `vault_list` e `vault_backlinks` NÃO ganham saída estruturada: ela dobraria, para o modelo, uma resposta que acabou de ganhar teto, e o inventário para programa já existe no `vault_graph`.

### Task 19: validade adaptativa do scan

**Files:**
- Modify: `src/vault/scanner.ts`
- Modify: `src/retrieval/retrieval.ts`
- Modify: `src/server/tools.ts`
- Test: `test/scanner.test.ts`

- [x] **Step 1:** Testes com `FsOps` contado e relógio injetado: scan barato nunca é reaproveitado; scan caro é reaproveitado até a validade; `invalidate()` força; `VAULT_SCAN_TTL_MS=0` desliga.
- [x] **Step 2:** `VaultScannerOptions.now`, `.scanTtlMs`; `refresh()` devolve delta vazio dentro da validade; escrita chama `scanner.invalidate()`.

### Task 20: memória do índice e bench

**Files:**
- Modify: `src/index/inverted-index.ts`
- Create: `scripts/bench.mjs`
- Test: `test/bm25.test.ts`

- [x] **Step 1:** `scripts/bench.mjs <notas>`: gera vault sintético, imprime start frio, busca morna, RSS e heap. Rodar na base para ter o antes.
- [x] **Step 2:** Internar termos no `InvertedIndex`; rodar o bench de novo e registrar antes/depois no CHANGELOG.

### Task 21: nomes de parâmetro em inglês, com os antigos aceitos

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/server/index.ts`
- Modify: `src/i18n/messages.ts`
- Test: `test/tools.test.ts`
- Test: `test/i18n.test.ts`

**Depends:** T9

- [x] **Step 1:** Testes: o schema publica `title`, `context`, `domain`, `project`, `confirm_new_domain`, `type`; chamada com `titulo`/`dominio`/`tipo` continua funcionando pelo handler e pelo protocolo; os dois nomes juntos com valores diferentes são recusados.
- [x] **Step 2:** `LEGACY_ARGS` por tool; `applyLegacyArgs(tool, args)`; decorador de transporte que o aplica em `tools/call`.

### Task 22: layout configurável

**Files:**
- Create: `src/config/layout.ts`
- Modify: `src/vault/scanner.ts`
- Modify: `src/retrieval/retrieval.ts`
- Modify: `src/index/inverted-index.ts`
- Modify: `src/write/paths.ts`
- Modify: `src/write/learn.ts`
- Modify: `src/write/propagate.ts`
- Modify: `src/write/relocate.ts`
- Modify: `src/write/writer.ts`
- Modify: `src/server/tools.ts`
- Modify: `src/server/index.ts`
- Test: `test/layout.test.ts`

**Depends:** T21

- [x] **Step 1:** Testes: sem arquivo, o layout é o de hoje; `.vault-mcp.json` com `wiki: "knowledge"` e `daily: "journal"` faz `vault_learn` escrever lá; arquivo inválido é erro de start com a chave nomeada.
- [x] **Step 2:** `loadLayout(vaultRoot)` → `Layout` com `folders` e `sections`; `DEFAULT_LAYOUT`; parâmetro opcional `layout` em cada função que hoje usa constante de pasta ou de seção.

### Task 23: avisos e motivos traduzidos

**Files:**
- Modify: `src/write/git.ts`
- Modify: `src/write/learn.ts`
- Modify: `src/write/relocate.ts`
- Modify: `src/write/rewrite-links.ts`
- Modify: `src/write/writer.ts`
- Modify: `src/server/tools.ts`
- Modify: `src/i18n/messages.ts`
- Modify: `src/i18n/lang.ts`
- Test: `test/i18n.test.ts`

**Depends:** T2, T3

- [x] **Step 1:** Teste: com `en`, a resposta de uma escrita com falha de commit e o `Reason` do `vault_learn` não têm palavra do catálogo português.
- [x] **Step 2:** Avisos e motivos passam a carregar `{code, params}` ao lado do texto; a fronteira da tool resolve pelo catálogo.

### Task 24: lint e cobertura

**Files:**
- Create: `biome.jsonc`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`

**Depends:** T10

- [x] **Step 1:** Biome (`lint`, formatter desligado); `npm run lint`; corrigir o que aparecer sem mudar comportamento. Era ESLint com typescript-eslint no plano: o typescript-eslint 8.73 exige `typescript <6.1` e este projeto usa a 7.
- [x] **Step 2:** `@vitest/coverage-v8`, `npm run coverage`, piso no valor medido menos um ponto.

### Task 25: correções menores

**Files:**
- Modify: `src/vault/links.ts`
- Modify: `src/write/paths.ts`
- Modify: `src/i18n/messages.ts`
- Test: `test/links.test.ts`
- Test: `test/paths.test.ts`

- [x] **Step 1:** Testes: link NFC resolve para arquivo de nome NFD; segmento de caminho acima de 255 bytes é recusado com `path.nameTooLong`.
- [x] **Step 2:** Comparação de basename em NFC; checagem de tamanho de segmento em `resolveWritePath`.

### Task 26: dividir tools.ts

**Files:**
- Modify: `src/server/tools.ts`
- Create: `src/server/tools/write-queue.ts`
- Create: `src/server/tools/sanitize.ts`
- Create: `src/server/tools/tag-guard.ts`
- Create: `src/server/tools/render.ts`
- Create: `src/server/tools/define.ts`
- Create: `src/server/tools/read-tools.ts`
- Create: `src/server/tools/write-tools.ts`

**Depends:** T3, T5, T7, T9, T14, T17, T18, T21, T22, T23

- [x] **Step 1:** Movimento puro; `tools.ts` vira barrel com os mesmos exports. Suíte verde sem tocar em teste.

### Task 27: documentação e versão

**Files:**
- Modify: `README.md`
- Modify: `README.pt-BR.md`
- Modify: `docs/followups.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `server.json`
- Modify: `CHANGELOG.md`

**Depends:** T12, T20, T24, T26

- [x] **Step 1:** Onze tools, variáveis novas, limites, layout, release; a seção "0.5.0 release candidate" vira seção normal nos dois READMEs; contagem de teste sai da prosa.
- [x] **Step 2:** Versão 0.6.0 em `package.json` e `server.json`; entrada no CHANGELOG.
