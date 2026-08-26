# Follow-ups conhecidos

Levantado durante a construção (20 tarefas, 8 fases, todas com gate PASS registrado) e verificado
contra o código em `main` no commit inicial do repositório. Nada aqui bloqueia: a suíte passa com
913 testes, o `tsc` está limpo e o binário responde o handshake MCP com as sete tools.

Este documento é **curado, não um log**. Vários itens levantados durante a run foram corrigidos
antes do fim (a classe do FIFO, o guard de caminho duplicado, a serialização de escritas, a colisão
de nome no README e na mensagem de erro) e não aparecem aqui. O que está listado foi confirmado
aberto por execução, não por leitura.

Cada item traz o arquivo, a medição que o caracteriza e a forma da correção. A ordem é de
prioridade, não de descoberta.

---

## 1. Mapa aninhado com alias trava o event loop (~5 s)

**`src/server/tools.ts:451`** — o descenso de um nível chama `Object.entries(value)` **antes** do
teste `depth <= 0` e não memoiza nada. Como um alias YAML faz o mesmo objeto ser referenciado várias
vezes, ele é resumido uma vez por referência.

Medido através da tool real: uma nota de 0,89 MB cujo frontmatter é
`w: &w {k0: 0, … k59999: 59999}` mais 40 chaves de `b0: {k0: *w, … k24: *w}` faz `vault_get_note`
devolver 3.911 caracteres depois de **5.237 ms de trabalho síncrono** — durante os quais o servidor
stdio não atende mais nada. O mesmo valor custava 7 ms antes do descenso. A variante em lista
(`b0: [*w, *w, …]`) já custava 3.933 ms antes e agora custa 10.936 ms.

**Correção:** testar `depth <= 0` antes de enumerar, e memoizar o resumo de containers por
identidade de objeto num `WeakMap`. Bombas de alias exponenciais clássicas continuam limitadas
(<1 ms, RSS estável) — esta é uma forma diferente, de mapa largo por referência.

## 2. Hard link é indexado na leitura

**`src/vault/scanner.ts:208`** — o scanner indexa por `entry.isFile()`, e um hard link **é** um
arquivo regular. A escrita já recusa (`classifyStat` reprova `nlink > 1` em `src/write/paths.ts`),
mas a leitura não: `fs.link(<segredo fora do vault>, <vault>/02-wiki/x.md)` faz o segredo virar uma
nota indexada, e `vault_get_note` devolveu uma chave privada que vive fora do vault.

Fechar só a escrita não resolve — o ponto do guard é que conteúdo do vault não puxe bytes de fora, e
o caminho de leitura faz exatamente isso, direto para o resultado que o agente lê.

**Correção:** aplicar a mesma regra do `classifyStat`, que já é pura sobre `Stats` — é um import e
uma condição, não um mecanismo novo. **Atenção ao falso positivo:** um snapshot `cp -al` hardlinka
todo arquivo, então um vault restaurado assim ficaria inteiro fora do índice. Decidir
deliberadamente entre recusar, avisar, ou recusar apenas links cujo alvo resolve fora da raiz.

## 3. Corrida entre processos na escrita

**`src/write/atomic.ts:141`** — a publicação é um `fs.rename` puro. O `O_EXCL` da linha 21 protege o
arquivo temporário, não o alvo, então a garantia vem de um teste seguido de um rename, e não da
escrita em si.

Dentro do processo isso está fechado: `src/server/tools.ts` serializa `vault_learn`,
`vault_write_note` e `vault_edit_note` numa fila. Fora do processo, não — Obsidian salvando, um
cliente de sync, ou uma segunda instância do servidor. Reproduzido com duas chamadas `learn()`
sobrepostas: as duas responderam `created`/`committed` e o primeiro insight não existia em arquivo
nenhum nem em blob nenhum.

**Correção:** publicar com `O_CREAT|O_EXCL` (ou criar o alvo exclusivamente antes do rename) e
repetir a busca por nome livre em `EEXIST`, para a garantia vir da escrita e não do teste.

## 4. `package.json` sem `private`, com nome já publicado

**`package.json`** — não tem `"private": true`, e `bin: {"vault-mcp": …}` reivindica um nome que já
existe no npm:

    npm view vault-mcp
      name 'vault-mcp', version 0.0.1, 443 bytes
      description 'MCP server namespace - part of HLOS ecosystem'
      maintainer ars923 <context@hlos.ai>

O README e a mensagem de erro do servidor já foram corrigidos para nunca sugerir `npx vault-mcp`.
Falta o guard local.

**Correção:** `"private": true`, para um `npm publish` acidental falhar aqui e não no registry. Se um
dia for publicar, o pacote precisa ser renomeado (com escopo, ex.: `@andreymudri/vault-mcp`) — o
nome puro não está disponível.

## 5. Classe de caracteres duplicada em `tools.ts`

**`src/server/tools.ts`** — carrega a própria cópia de `INVISIBLE_CHARS`, que é a classe
consolidada em `src/write/paths.ts` durante a mesma fase. As cópias são idênticas hoje; o risco é
divergirem.

Isso não é hipotético neste projeto: o escape para dentro de `.git/` corrigido na fase 4 existiu
justamente porque `propagate.ts` carregava a própria cópia do guard.

**Correção:** importar de `paths.ts`. Ele exporta a regex **sem** a flag `g` de propósito (nada de
`lastIndex` compartilhado), então derive uma global a partir de `.source`, como `propagate.ts` e
`learn.ts` já fazem. `paths.ts` importa só `node:path` e `node:fs`, então não há ciclo.

## 6. Vitest não sai quando um teste assíncrono estoura o timeout

**`vitest.config.ts`** — quando um teste com leitura bloqueada falha (os testes de FIFO), o vitest
**imprime** a falha e depois nunca termina: `close timed out`, `Failed to terminate worker`. Medido
com kill externo em exit 124.

Importa porque o gate lê o **exit code** de `npm test`. Uma suíte que imprime a falha e trava não dá
exit code nenhum — vira uma parada indefinida em vez de um FAIL limpo, e um gate que pode travar não
serve como evidência.

Não é alcançável hoje: os testes de FIFO passam em milissegundos no código correto, então só uma
regressão dispara. `test/learn.test.ts` e `test/propagate.test.ts` já usam um helper `withFifoWatch`
que abre a ponta de escrita com `O_WRONLY|O_NONBLOCK` e faz a falha acontecer em ~2 s com saída
limpa — esse é o padrão a seguir.

**Correção:** `teardownTimeout` em `vitest.config.ts`, ou estender o `withFifoWatch` aos testes que
ainda dependem do timeout do runner.

## 7. Teardown de repositório descartável em `test/git.test.ts`

**`test/git.test.ts:28,77,293`** — cria repositórios com `git init` + commit e remove com `fs.rm`
puro, sem `gc.auto 0` e sem `maxRetries`. É a forma exata que falhou uma vez no gate com
`ENOTEMPTY: rmdir '.../vault/.git'` — o teardown correndo com o `gc --auto` que o git dispara em
segundo plano e que sobrevive ao commit já aguardado.

`test/writer.test.ts` já recebeu o endurecimento (`initScratchRepo` com `gc.auto 0` e um `removeTree`
com `maxRetries`); este arquivo ficou de fora.

**Correção:** aplicar o mesmo par. Um teste que falha por acaso é pior que um lento.

## 8. Guard de tag: três lacunas medidas

Todas em **`src/server/tools.ts`**, no `tagRoundTripProblem`. O guard foi reconstruído a partir de
medição — 55 formas escritas pelo serializador real e lidas de volta pelo parser real — e acerta o
que foi medido. Estas três ficaram fora da tabela:

- **`:723`** — `SEXAGESIMAL_RE` cobre só o **inteiro** sexagesimal do YAML 1.1. Floats passam e são
  reescritos: `1:30.5` é aceito e volta `90.5`; também `1:30.` → 90, `0:30.5` → 30.5, `12:00.25` →
  720.25, `1:30:00.5` → 5400.5, `59:59.999` → 3599.999. Note que a restrição de `[1-9]` inicial está
  certa para inteiros e errada para floats (`0:30` sobrevive, `0:30.5` não).
- **`:726`** — `YAML_DATE_RE` cobre só o timestamp curto, então a forma ISO completa passa:
  `2026-01-10T00:00:00Z` volta como `2026-01-10`.
- **`:719`** — `NUMERIC_LIKE_RE` é **mais larga** que os resolvers do js-yaml em quatro pontos
  medidos, recusando tags que sobreviveriam, com uma mensagem que nomeia um valor que o YAML nunca
  produz: decimais com zero à esquerda contendo 8 ou 9 (`009`, um id de ticket com zero-padding é o
  caso real mais plausível), underscore final (`1_`, `007_`), prefixo de radix maiúsculo (`0X1F`,
  `0B11`), e `+.0`/`+.1`/`+.9`.

**Correção:** os três são ajustes de regex. O método já está estabelecido — medir a forma pelo
serializador e pelo parser reais, e recusar só o que de fato não faz round-trip. A tabela de testes
já é property-based (`refused === !roundTrips`), então uma correção errada falha nos dois sentidos.

## 9. Itens menores, todos medidos

- **`src/server/tools.ts:249`** — o aviso de exclusividade dispara para uma chamada que estava
  **sozinha** na fila: o próprio slot dela expirando incrementa `expired`, e o terceiro termo de
  `overlapped` lê isso como exclusão perdida. Conservador, não perigoso; precisa de uma escrita de
  mais de 60 s para aparecer.
- **`src/server/tools.ts:557`** — `relayDiff` colapsa CRLF dentro do diff, então uma edição só de
  fim de linha aparece como um par `-`/`+` visualmente idêntico. O usuário vê uma mudança descrita
  como mudança, sem diferença visível.
- **`src/server/index.ts:15`** — o docblock do módulo ainda diz "The process a user starts:
  `npx vault-mcp`", contradizendo o README e a mensagem de erro, ambos corrigidos. Só comentário.
  (As menções em `:156,158` explicam que `npx`/`npm` instalam o bin como **symlink**, que é o motivo
  de `isDirectRun` comparar via `realpathSync` — isso continua verdade, deixe.)
- **`test/tools.test.ts:892`** — o teste dos clamps de `renderNoteLine` fixa `tipo` e `status` mas
  **não** `tags`: apagar aquele terceiro clamp mantém os 913 testes verdes. Uma nota no máximo que o
  próprio `frontmatter.ts` permite (64 tags × 128 chars) renderiza uma linha de 8.380 caracteres sem
  o clamp contra 584 com ele — 14×, uma vez por nota.
- **`test/tools.test.ts:497`** — a metade do CRLF no **snippet** não está fixada: trocar
  `quoteSnippet` para `sanitizeQuoted(text, false)` mantém tudo verde enquanto toda linha de toda
  nota escrita no Windows ganha um `\r` visível.

---

## Aceito deliberadamente

**`src/server/tools.ts` — `vault_get_note` devolve o corpo da nota cru.** Um corpo com `ESC[F` +
`ESC[2K` consegue reescrever, num cliente que renderiza para terminal, as linhas que a própria tool
imprimiu acima dele.

Foi avaliado e mantido, e a razão é boa: `vault_edit_note` casa `old_text` como substring exata do
arquivo, então escapar o corpo quebraria silenciosamente todo fluxo ler-depois-editar exatamente nas
notas que carregam um caractere de controle. A tool não faz nenhuma afirmação de estrutura por
linha, o corpo é o **último** elemento da saída, ela é limitada por `MAX_NOTE_CHARS` e devolve uma
nota que o chamador nomeou por caminho.

As superfícies que **fazem** afirmação por linha — o trecho do `vault_search` e o diff repassado —
são sanitizadas: ESC, CSI, DEL, C0/C1, U+061C, LRM/RLM e os overrides bidi saem escapados, e os
juntadores (soft hyphen, ZWSP/ZWNJ/ZWJ, word joiner, BOM) ficam crus de propósito, para não partir
palavras no meio da prosa.

Registrado aqui para não ser redescoberto como bug.
