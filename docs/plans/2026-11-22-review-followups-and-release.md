# Achados do review final e release automático

## Statement

"fix everything, lets automate the release and also push and open pr"

Dito depois do relatório do branch `feat/enterprise-tier`, que listava 8 achados `medium` e 7 `low`
do review final como abertos (`docs/followups.md`, item 33) e três passos de release como manuais:
cadastrar o trusted publisher no npm, criar a tag `v0.6.0` e publicar no MCP Registry.

## Destination

O item 33 de `docs/followups.md` não tem nada aberto; dar merge em `main` de uma versão ainda sem
tag publica essa versão no npm, cria a tag e o GitHub Release e publica no MCP Registry, sem
ninguém rodar comando; e o branch está num PR com o CI do GitHub verde.

## Acceptance

- Dois servidores no mesmo vault usam o mesmo arquivo de lock mesmo quando só um deles tem `git` no PATH
- Um lock é carimbado quando é obtido, e não quando a espera começa
- Com `.git` sem permissão de escrita, a nota é gravada e o commit vira aviso, como na 0.5.0
- O resultado estruturado do `vault_learn` tem teto, na escrita e na prévia
- Um argumento inválido chega ao cliente, pelo protocolo, como recusa traduzida com o código `input.invalid`
- Um nome antigo de parâmetro continua aceito pelo protocolo, sem decorador de transporte
- O `tools/list` publica os mesmos schemas de antes
- Com o stderr fechado, o servidor continua respondendo
- Uma nota que já existe com nome de 221 a 255 bytes pode ser movida e apagada
- Cada um dos oito achados de teste tem um teste que falha com a mutação que o revisor descreveu
- O workflow de release publica no npm por OIDC num job que não roda teste nem instala dependência
- O workflow de release cria a tag e o GitHub Release depois do npm, e publica no MCP Registry por último
- Cada passo do release pode ser repetido sem erro quando já foi feito
- Uma versão sem seção no CHANGELOG, ou com `server.json` fora de passo, não é publicada
- O branch está num PR e o `gh pr checks` está verde

## Global Constraints

- Node >= 22 para rodar; a suíte roda no Node 26
- Zero dependência nova de runtime
- TypeScript strict, ESM, `erasableSyntaxOnly`; comentários de código em inglês
- Commits em português, estilo conventional commits
- Toda correção começa por um teste visto falhando pelo motivo certo; teste de lacuna é conferido por mutação
- Nada de `npx <nome>` solto: `./node_modules/.bin/<bin>` ou `npm run`
- Actions fixadas por SHA; nenhum binário baixado sem versão fixa e verificação

### Task 1: caminho do lock derivado do sistema de arquivos

**Files:**
- Modify: `src/write/git.ts`
- Test: `test/git.test.ts`
- Test: `test/cross-process.test.ts`

- [ ] **Step 1:** Testes: `lockPathFor` responde `<vault>/.git/vault-mcp.lock` com o PATH sem `git`; segue `.git` arquivo (`gitdir:`); sobe até o repositório quando o vault é subpasta; sem repositório, o dotfile; com `.git` sem permissão de escrita, o dotfile. Processos reais, metade sem `git`: todas as edições ficam.
- [ ] **Step 2:** `lockPathFor` anda o sistema de arquivos a partir do `realpath` do vault, sem chamar o binário.

### Task 2: carimbo do lock na obtenção

**Files:**
- Modify: `src/write/vault-lock.ts`
- Test: `test/vault-lock.test.ts`

- [ ] **Step 1:** Teste: quem esperou por um lock o obtém com `at` posterior à soltura do anterior.
- [ ] **Step 2:** `acquire()` monta o conteúdo do lock a cada tentativa de criação.

### Task 3: o servidor responde `tools/list` e `tools/call`

**Files:**
- Modify: `src/server/index.ts`
- Test: `test/tools.test.ts`

**Depends:** T2

- [ ] **Step 1:** Fotografar o `tools/list` atual. Testes: argumento desconhecido e conflito de alias chegam ao cliente real como recusa traduzida com `input.invalid` no `_meta`; nome antigo aceito; tool não publicada recusada; saída fora do schema vira erro.
- [ ] **Step 2:** `Server` no lugar de `McpServer`, com os dois handlers; sai o decorador de transporte. O `tools/list` novo é igual à fotografia.

### Task 4: teto no resultado estruturado do `vault_learn`

**Files:**
- Modify: `src/server/tools/write-tools.ts`
- Modify: `src/server/tools/sanitize.ts`
- Test: `test/tools.test.ts`

**Depends:** T3

- [ ] **Step 1:** Teste: com um insight de 187 mil caracteres, o `structuredContent` inteiro fica abaixo de um teto, na escrita e na prévia, e diz o que foi cortado.
- [ ] **Step 2:** `diff`, `before` e `after` cortados no mesmo teto do texto, com marca no schema de saída.

### Task 5: stderr fechado e teto de nome só para o que é criado

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/write/paths.ts`
- Modify: `src/write/relocate.ts`
- Test: `test/tools.test.ts`
- Test: `test/relocate.test.ts`

**Depends:** T3

- [ ] **Step 1:** Testes: processo real com o stderr fechado responde a segunda chamada; nota de 229 bytes de nome é movida para nome curto e apagada.
- [ ] **Step 2:** Listener de erro no stderr; `existing: true` no guard de caminho para a origem do move e para o delete.

### Task 6: as lacunas de teste do review

**Files:**
- Modify: `src/server/index.ts`
- Test: `test/tools.test.ts`
- Test: `test/scanner.test.ts`

**Depends:** T4, T5

- [ ] **Step 1:** Um teste por lacuna: redação dos parâmetros do erro; `invalidate` na saída do lock; as três variáveis de limite até o componente; SIGINT, saída forçada, erro fatal e `releaseLocks`; push fora do lock e aviso de lock perdido; tetos de `limit`, `old_text`/`new_text` e `context`; reaproveitamento do scan pelas tools.
- [ ] **Step 2:** Cada teste conferido pela mutação que o revisor descreveu.

### Task 7: release automático

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `scripts/release-check.mjs`
- Modify: `CONTRIBUTING.md`
- Test: `test/package.test.ts`

- [ ] **Step 1:** `scripts/release-check.mjs`: versão igual em `package.json`, `package-lock.json` e `server.json`, `mcpName` igual ao nome do `server.json`, seção no CHANGELOG. Testado.
- [ ] **Step 2:** `release.yml` em push para `main` e disparo manual: job que decide, job que verifica e empacota sem identidade de publicação, job que publica o tarball no npm por OIDC, cria tag e Release e publica no MCP Registry com `mcp-publisher` fixado e verificado.

### Task 8: documentação, PR e CI

**Files:**
- Modify: `docs/followups.md`
- Modify: `README.md`
- Modify: `README.pt-BR.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`

**Depends:** T1, T2, T3, T4, T5, T6, T7

- [ ] **Step 1:** Item 33 fechado; limites e release nos documentos.
- [ ] **Step 2:** Um review sobre o diff desta rodada, CI local, push, PR, `gh pr checks`.
