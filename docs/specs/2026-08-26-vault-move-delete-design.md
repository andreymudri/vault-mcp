---
tipo: spec
projeto: vault-mcp
status: aprovado
criado: 2026-08-26
---

# vault_move e vault_delete — mover, renomear, promover e apagar notas

## Objetivo

Fechar as quatro operações que hoje só existem fora do MCP e que, feitas à mão, deixam o vault
inconsistente em silêncio:

1. **Promover** material validado de `01-raw/` para `02-wiki/<dominio>/`.
2. **Corrigir** o domínio ou o slug que um `vault_learn` escolheu errado.
3. **Apagar** uma nota que não deveria existir — duplicata, teste, lixo.
4. **Arquivar** em `99-archive/` uma nota que não vale mais mas cuja história importa.

## Contexto

Três fatos do código existente decidem o desenho inteiro:

- **Wiki-link resolve por BASENAME, não por caminho.** `resolveOne` (`src/vault/links.ts:145`)
  tenta, nesta ordem: caminho relativo à nota que linka, caminho relativo à raiz do vault, e por
  fim o índice de basename — desempatando pela nota mais rasa. Consequência direta: mover uma nota
  sem trocar o nome do arquivo **não quebra link nenhum**, enquanto renomear quebra todo
  `[[slug-antigo]]`.
- **`99-archive/` e `_templates/` estão em `DENIED_PREFIXES`** (`src/write/paths.ts:5`), e nenhuma
  escrita chega lá. Arquivar exige abrir exatamente uma dessas duas portas.
- **O scanner já reporta remoções.** `refresh()` devolve `{ changed, removed }`
  (`src/vault/scanner.ts:106`), e o retriever consome esse delta. Índice e grafo se acertam sozinhos
  depois de um move ou delete; nada de invalidação manual.

## A invariante

> **Um edge que resolvia antes da operação resolve para a MESMA nota depois.**

É a regra única da qual sai toda correção de link, em vez de uma pilha de casos especiais. Ela cobre
os três cenários que regras separadas erram:

- slug mudou → `[[antigo]]` nas outras notas vira `[[novo]]`;
- slug NÃO mudou, mas a nota saiu de um diretório onde uma irmã a linkava relativamente → o link
  continua resolvendo pelo índice de basename, e **nada é reescrito** (a regra ingênua
  "renomeie o slug em todo lugar" mexeria em arquivos à toa);
- os links relativos de SAÍDA da própria nota movida — `[[../../00-index/index-knowledge|índice de
  conhecimento]]`, que o `buildMoc` escreve (`src/write/propagate.ts:334`) — eram relativos ao
  diretório ANTIGO e quebram na mudança.

A aplicação é mecânica: monta-se o índice do vault **como ele ficará depois** da operação,
re-resolve-se cada alvo bruto afetado com `resolveOne` sob os dois índices, e reescreve-se
exatamente aqueles que mudaram de resposta.

`resolveOne` é **exportado e reusado, nunca copiado**. Uma segunda cópia da regra de resolução é
exatamente como uma reescrita passa a apontar para outro lugar — o mesmo formato do item 5 de
`docs/followups.md`.

## Superfície

```
vault_move    from, to, confirm_novo_dominio?
vault_delete  path, confirm?
```

`to` é um caminho completo relativo ao vault, com `.md`. Mover, renomear e promover são portanto
UMA operação: `01-raw/inbox/rascunho.md` → `02-wiki/nestjs/auth-guard.md` é promoção, renomeação e
atribuição de domínio ao mesmo tempo, e a invariante trata as três igual.

### `99-archive/`

`guardedPath` ganha um modo em que `99-archive/` é legal como **origem e destino**, usado
exclusivamente pelo `vault_move`. Isso dá arquivar e desarquivar com uma regra só.

`vault_write_note`, `vault_edit_note`, `vault_learn` e `propagate` continuam recusando: nada pode
CRIAR nem EDITAR conteúdo lá dentro, só mover para dentro e para fora. `_templates/`, `.git`,
`.obsidian` e `node_modules` seguem negados **sem flag nenhuma que os abra**.

`vault_delete` **não** recebe a exceção. É o que faz `99-archive/` significar de verdade "aqui nada
é destruído, só entra e sai" — apagar uma nota arquivada continua sendo trabalho de `rm`, fora do MCP.

## Módulos

| Arquivo | Mudança |
|---|---|
| `src/write/relocate.ts` | **novo** — `moveNote` / `deleteNote`, só orquestração |
| `src/write/rewrite-links.ts` | **novo**, puro — reescreve `[[alvo]]` no lugar, preservando `#âncora` e `\|alias`, pulando código cercado |
| `src/vault/links.ts` | exporta `resolveOne` como `resolveLinkTarget` |
| `src/write/propagate.ts` | exporta `fencedLines` (:149); ganha `removeFromSection`, a contraparte que falta de `insertUnderSection` (:203) |
| `src/write/paths.ts` | `guardedPath(root, rel, { allowArchive })` — isenta **apenas** `99-archive` de `DENIED_PREFIXES` |
| `src/write/diff.ts` | `unifiedDiff(before, after, path, toPath?)` para o cabeçalho de rename |
| `src/server/tools.ts` | duas entradas `define(...)`; "sete tools" vira "nove" em 3 docblocks, 3 testes e os READMEs |

`fencedLines` é exportado em vez de reimplementado de propósito: `links.ts`, `propagate.ts` e
`chunker.ts` já carregam três parsers de cerca, e um quarto que discorde dos outros é o item 5
acontecendo de novo.

## `vault_move` — fluxo

1. `refreshVault(deps)` primeiro. Os backlinks saem do grafo, e um grafo velho reescreve o arquivo
   errado. As tools de escrita não fazem refresh hoje; estas duas precisam.
2. `guardedPath` nos dois lados, com `allowArchive`. Recusa `from === to`.
3. `classifyNode`: `from` tem de ser `file`, `to` tem de ser `missing`. Symlink, diretório, FIFO ou
   hard link em qualquer um dos lados é recusado — a mesma regra de todo o resto.
4. Calcula **em memória** o conteúdo novo de cada arquivo — o rename, as reescritas de link, as
   edições de MOC — e todos os diffs, antes de publicar um byte sequer. Mesma ordem de
   `writeAndCommit` (`src/write/writer.ts:305`): "escrito mas não reportado" não pode ser um estado
   alcançável.
5. Publica o rename como **`fs.link(from, to)` seguido de `unlink(from)`**, nunca `fs.rename`.
   `rename` sobrescreve em silêncio, então um move em cima de uma nota existente a destrói; `link`
   falha com `EEXIST` e nada se perde. É o mesmo truque de publicação exclusiva que
   `src/write/atomic.ts:168` já usa, pelo mesmo motivo (item 3 dos follow-ups). Diretório de destino
   criado com `mkdir -p`, como as escritas já fazem.
6. **Pertencimento a MOC:** remove a linha do MOC de origem **preservando o `— resumo` dela** e
   insere no MOC de destino. MOC de destino inexistente exige `confirm_novo_dominio`, e então
   `buildMoc` mais a linha no `00-index/index-knowledge.md`, espelhando o `vault_learn` exatamente.
   **A nota diária nunca é tocada** — ela registra o que ACONTECEU naquele dia, o MOC indexa o que
   EXISTE.
7. Um `commitFiles` só, sobre `[fromAbs, toAbs, ...reescritos]`. O `git add` nos dois caminhos
   registra o delete mais o add, e o git renderiza como rename.

A ordem de publicação é rename-depois-reescritas, de propósito: o rename é o passo que pode perder
uma corrida, e reescritas que tivessem aterrissado antes de um rename falho apontariam para uma nota
que não se moveu. Uma reescrita que falhe DEPOIS do rename é um aviso nomeando o arquivo, nunca um
rollback — a nota já está onde o usuário pediu.

## `vault_delete` — fluxo

Os três primeiros passos são os do move, e depois:

4. **A pergunta ao git, antes de qualquer destruição:** `git rev-parse --verify HEAD:<caminho>`.
   Sem blob no `HEAD` — o vault não é repositório, ou a nota foi criada e nunca commitada — a
   exclusão é irreversível de verdade, e a tool **para e diz isso**. Rastreada mas com edições não
   commitadas **não** é recusa: é um aviso dizendo que a restauração traz de volta a versão
   commitada, não o que está em disco agora.
5. **Notas estruturais são recusadas sem escape:** `tipo: moc`, `tipo: daily` e
   `00-index/index-knowledge.md`. Apagar uma delas é quase sempre engano, e a de verdade se faz
   fora do MCP.
6. Backlinks existentes exigem `confirm: true`, e a recusa **lista as notas que apontam**, para que
   a decisão seja informada. Não há para onde reescrever os links, então os que sobrarem viram links
   quebrados — que o vault já modela como cidadão de primeira classe (`vault_get_note` reporta
   `brokenLinks`).
7. Linha do MOC removida. Nota diária intocada, pelo mesmo motivo do move.
8. `unlink` → commit `docs(vault): remover <título>`.
9. A resposta nomeia o desfazer exato, com o sha do commit recém-feito:
   `git -C <vault> checkout <sha>^ -- <caminho>`.

## Recusas

- `from` não é nota; `to` já existe; `from === to`
- `_templates/`, `.git/`, `.obsidian/`, `node_modules/` — inclusive com `allowArchive` ligado
- metacaractere de glob e caractere de controle no caminho (já em `guardedPath`)
- delete sem blob no `HEAD`
- delete de nota estrutural (MOC, daily, índice)
- delete com backlinks e sem `confirm`
- move para domínio novo sem `confirm_novo_dominio`

## Testes

`test/rewrite-links.test.ts` (puro): âncora e alias preservados, `[[...]]` dentro de cerca de código
intocado, e as cargas de backtracking do docblock de `links.ts` continuam lineares.

`test/relocate.test.ts`:

- move dentro do mesmo domínio;
- move entre domínios, com o pertencimento ao MOC migrado e o resumo preservado;
- promoção de `01-raw/`;
- arquivar e desarquivar;
- renomeação com backlinks reescritos;
- **colisão de basename** — duas `auth-guard.md`, onde o move troca qual delas `[[auth-guard]]`
  resolve e a reescrita tem de desambiguar;
- links relativos de saída da própria nota movida;
- destino já existente (corrida);
- `_templates` e `.git` ainda recusados com `allowArchive` ligado;
- delete sem blob no `HEAD` recusado;
- delete de MOC, daily e índice recusados;
- delete com backlinks recusado sem `confirm`;
- nota diária byte a byte idêntica depois das duas operações.

Onde o teste fecha uma LACUNA DE COBERTURA e não reproduz um bug, o "visto falhando" é por mutação —
apagar o guard, inverter a flag — e o teste novo tem de pegar essa mutação. É a regra que
`docs/followups.md` já aplica.
