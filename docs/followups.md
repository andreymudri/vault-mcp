# Follow-ups conhecidos

**Todos os nove itens levantados na construção estão FECHADOS** (2026-08-26), mais um décimo
levantado durante a própria correção (item 10, abaixo). Este documento deixou
de ser uma lista de pendências e virou o registro do que era cada um, como foi corrigido e onde está
o teste que impede a volta — mais a seção final, **Aceito deliberadamente**, que continua valendo.

A suíte passa com 1.014 testes, o `tsc` está limpo sobre `src/` E sobre `test/`, e o binário responde
o handshake MCP com as sete tools.

Cada item foi corrigido pelo ciclo teste-primeiro: um teste que reproduz o defeito, visto falhando
pelo motivo certo, e só então a correção. Onde o defeito era uma LACUNA DE COBERTURA e não um bug de
comportamento (itens 7 e 9), o "visto falhando" foi feito por mutação — apagar o clamp, inverter a
flag — e o teste novo tem de pegar essa mutação.

---

## 1. Mapa aninhado com alias travava o event loop (~5 s) — CORRIGIDO

**`src/server/tools.ts`** — o descenso de um nível chamava `Object.entries(value)` **antes** do teste
`depth <= 0` e não memoizava nada. Como um alias YAML faz o mesmo objeto ser referenciado várias
vezes, ele era resumido uma vez por REFERÊNCIA.

Medido através da tool real: uma nota de 0,89 MB cujo frontmatter é `w: &w {k0: 0, … k59999: 59999}`
mais 40 chaves de `b0: {k0: *w, … k24: *w}` fazia `vault_get_note` devolver 3.911 caracteres depois
de **5.237 ms de trabalho síncrono** — durante os quais o servidor stdio não atendia mais nada.

**Correção:** o teste `depth <= 0` passou a vir antes de qualquer enumeração (e usa `Object.keys`
quando só o número importa), e o resumo de cada container é memoizado por identidade de objeto num
`WeakMap` por chamada de `renderFrontmatterBlock` — o mapa morre com a chamada, de propósito: um
cache de módulo responderia por um objeto que o scanner segurou entre refreshes.

**Fixado por:** `test/tools.test.ts`, "um mapa largo referenciado por alias não trava o event loop".
O teste descarta a primeira chamada (que paga o parse do YAML) e mede a segunda.

## 2. Hard link era indexado na leitura — CORRIGIDO

**`src/vault/scanner.ts`** — o scanner indexava por `entry.isFile()`, e um hard link **é** um arquivo
regular. A escrita já recusava (`classifyStat` reprova `nlink > 1`), a leitura não:
`fs.link(<segredo fora do vault>, <vault>/02-wiki/x.md)` fazia o segredo virar nota indexada, e
`vault_get_note` devolvia uma chave privada que vive fora do vault.

**Correção:** `classifyStat` — a mesma função, agora sobre um `StatLike` estrutural — roda no
caminho de leitura, sobre o mesmo `Stats` que já respondia o mtime. Um nó reprovado sai do índice
**com diagnostic**, nomeando a causa.

**Decisão deliberada sobre `cp -al`:** a regra é sobre `nlink`, não sobre onde a contraparte vive —
não há como perguntar isso a um hard link sem varrer o filesystem. Um vault restaurado com `cp -al`
fica portanto fora do índice, mas de forma RUIDOSA: um diagnostic por nota. Silenciar seria pior.

**Fixado por:** `test/scanner.test.ts`, describe "VaultScanner: hard link" — os dois casos, o link
para fora e o link entre dois nomes de dentro.

## 3. Corrida entre processos na escrita — CORRIGIDO

**`src/write/atomic.ts`** — a publicação era um `fs.rename` puro. O `O_EXCL` protegia o arquivo
temporário, não o alvo, então a garantia vinha de um teste seguido de um rename, e não da escrita.
Reproduzido com duas chamadas `learn()` sobrepostas: as duas respondiam `created`/`committed` e o
primeiro insight não existia em arquivo nenhum nem em blob nenhum.

**Correção:** `atomicWrite` ganhou `{ exclusive: true }`, usado exatamente quando o chamador
concluiu que o alvo não existe (`WriteResult.created`). A publicação exclusiva é um `fs.link` — uma
syscall que publica os bytes prontos e FALHA com `EEXIST` se o nome estiver ocupado — seguido do
`unlink` do temporário. Preferido a reservar o nome com `O_CREAT|O_EXCL` e renomear por cima porque
essa variante tem uma janela em que o leitor vê uma nota vazia, e "nenhum leitor observa arquivo
parcial" é a garantia que este módulo existe para dar. O perdedor recebe `WriteRaceError`, e
`learn.ts` responde procurando outro nome livre (até 8 vezes) — a mesma saída que o ramo
"ocupado e não anexável" já tomava.

**Fixado por:** `test/writer.test.ts`, describe "atomicWrite > exclusive" (três casos), e
`test/learn.test.ts`, "duas learn() sobrepostas no mesmo nome não perdem insight".

## 4. `package.json` sem `private`, com nome já publicado — CORRIGIDO

`"private": true` está no `package.json`: um `npm publish` acidental falha aqui e não no registry. O
nome `vault-mcp` continua sendo de outro autor no npm (`vault-mcp@0.0.1`, 443 bytes, por ars923);
publicar um dia exige renomear com escopo. O README, a mensagem de erro do servidor e o docblock de
`src/server/index.ts` dizem todos o caminho absoluto, nunca `npx vault-mcp`.

**Fixado por:** `test/package.test.ts`.

## 5. Classe de caracteres duplicada em `tools.ts` — CORRIGIDO

`src/server/tools.ts` carregava a própria cópia de `INVISIBLE_CHARS`. Agora importa de
`src/write/paths.ts` e deriva a forma global de `.source`, como `propagate.ts` e `learn.ts` já
faziam — `paths.ts` exporta sem a flag `g` de propósito, para não haver `lastIndex` compartilhado.
As cópias eram idênticas na hora da troca (verificado byte a byte antes).

## 6. Vitest não saía quando um teste bloqueava o worker — CORRIGIDO, por fora do vitest

O gate lê o **exit code** de `npm test`. Uma suíte que trava não dá exit code nenhum — vira uma
parada indefinida em vez de um FAIL limpo, e um gate que pode travar não serve como evidência.

**A correção sugerida na versão anterior deste documento não funciona.** Medido em vitest 4.1, com um
teste bloqueado em leitura SÍNCRONA de um FIFO sem escritor: `teardownTimeout` não resolve,
`pool: 'forks'` não resolve, e o próprio `testTimeout` não chega a disparar — o event loop do worker
está bloqueado antes disso. Os três passaram de 120 s sem imprimir uma linha sequer. (A variante
ASSÍNCRONA, que era o caso medido originalmente, o vitest 4 já encerra sozinho em ~2 s.)

**Correção:** o limite vem de fora do runner. `npm test` roda `scripts/test.mjs`, que sobe o vitest
em seu próprio GRUPO de processos e sinaliza o grupo — o worker travado não é o processo que o
script iniciou, então matar só o pai o deixaria para trás. Estourado o limite (15 min, ajustável por
`VAULT_MCP_TEST_TIMEOUT_MS`), a suíte sai com **124**. Verificado nos três caminhos: suíte verde sai
0, falha real sai 1, suíte travada sai 124 dentro do limite.

A outra metade da sugestão — estender o `withFifoWatch` — já estava feita: os nove `mkfifo` dos
testes estão todos sob o watcher.

## 7. Teardown de repositório descartável em `test/git.test.ts` — CORRIGIDO

Criava repositórios com `git init` + commit e removia com `fs.rm` puro, sem `gc.auto 0` e sem
`maxRetries` — a forma exata que falhou uma vez no gate com `ENOTEMPTY: rmdir '.../vault/.git'`.
Agora usa o mesmo par `initScratchRepo`/`removeTree` de `test/writer.test.ts`, nos três sítios.

## 8. Guard de tag: as três lacunas medidas — CORRIGIDAS

Todas em **`src/server/tools.ts`**, no `tagRoundTripProblem`:

- **Sexagesimal FLOAT** era um resolver separado que o guard não cobria: `1:30.5`→90,5, `1:30.`→90,
  `0:30.5`→30,5, `12:00.25`→720,25, `1:30:00.5`→5400,5, `59:59.999`→3599,999. Duas diferenças em
  relação ao inteiro, as duas medidas: o grupo inicial pode começar com zero, e a forma termina em
  ponto com dígitos opcionais.
- **Timestamp ISO completo** passava batido — só a forma curta era coberta —, então
  `2026-01-10T00:00:00Z` voltava `2026-01-10`. É um regex SEPARADO no js-yaml, e é justamente o que
  torna mês e dia de um dígito legais nele: `2026-1-5` sozinho é texto, `2026-1-5T01:02:03Z` é uma
  data.
- **`NUMERIC_LIKE_RE` era mais LARGA que os resolvers do js-yaml**, recusando tags que sobreviveriam:
  `009`/`018`/`09` (zero à esquerda significa octal, e 8 e 9 não são dígitos octais — um id de ticket
  com zero-padding é o caso real), `1_`/`007_` (numérico não termina em underscore), `0X1F`/`0B11`
  (os prefixos de radix são só minúsculos) e `+.0`/`+.1`/`+.9` (o float de ponto nu do js-yaml não
  leva sinal).

Uma quarta lacuna apareceu durante a medição e foi corrigida junto: a mensagem nomeava o valor de
volta com `Number`, que ignora o radix — `017` era anunciado como 17 quando o YAML lê 15. O valor
agora é lido por radix.

**Método, e ele é o ponto:** um corpus de 128 formas foi escrito pelo serializador real e relido pelo
parser real, e a tabela de `test/tools.test.ts` ("a tag %s só é recusada se realmente não sobreviver
ao YAML") é esse corpus inteiro. A propriedade é `refused === !roundTrips`, então uma correção errada
falha nos dois sentidos — recusar o que sobrevive é tão erro quanto aceitar o que não sobrevive.

## 9. Itens menores — CORRIGIDOS (um deles não reproduziu)

- **Aviso de exclusividade em chamada solitária** (`src/server/tools.ts`) — disparava para uma
  escrita que estava SOZINHA na fila: o próprio slot dela expirando incrementava `expired` e
  `outstanding`, e `overlapped` lia isso como exclusão perdida. A fila agora conta TAREFAS QUE
  COMEÇARAM, que é a pergunta de verdade: o aviso sai se algo começou enquanto esta rodava, ou se
  algo abandonado ainda corria quando ela começou. Um aviso que aparece onde nada se sobrepôs ensina
  o leitor a ignorá-lo onde algo se sobrepôs. Fixado pelos dois casos — sozinha e com alguém atrás.
- **`relayDiff` colapsando CRLF** — **não reproduz.** `relayDiff` chama `sanitizeQuoted(diff, false)`,
  que é a variante que MOSTRA o `\r`, e uma edição só de fim de linha renderiza `+linha um\r`,
  medido através da tool real. A metade do diff também já estava fixada: inverter a flag quebra um
  teste existente. O item era um engano de leitura do documento anterior.
- **CR órfão no trecho** — achado ao escrever o teste da metade do snippet: `chunker.ts` divide o
  corpo em `\n` e junta em `\n`, então o terminador da ÚLTIMA linha é o separador que se perde e o
  `\r` dela fica órfão. Todo trecho de nota escrita no Windows saía com um `\r` visível na última
  linha citada. Removido só no fim e só no chamador que colapsa — um `\r` solto em qualquer outro
  lugar continua sendo uma quebra que reescreve linha renderizada, e continua escapado.
- **Docblock de `src/server/index.ts`** — dizia "The process a user starts: `npx vault-mcp`",
  contradizendo o README e a mensagem de erro. Corrigido, e as menções a `npx`/`npm` mais abaixo
  ficaram: elas explicam que o bin é instalado como SYMLINK, que é outro assunto e continua verdade.
- **Clamp de `tags` em `renderNoteLine`** — não estava fixado: o teste que existia era dominado por
  `tipo` e `status` gigantes, então apagar o terceiro clamp mantinha tudo verde. O teste novo usa o
  MÁXIMO LEGAL que `frontmatter.ts` aceita (64 tags de 128 caracteres) e pega a mutação: 8.385
  caracteres na linha sem o clamp, contra menos de 1.000 com ele — uma vez por nota.
- **Metade CRLF do snippet** — não estava fixada: trocar `quoteSnippet` para
  `sanitizeQuoted(text, false)` mantinha tudo verde. Fixada, e a verificação foi por mutação nos dois
  sentidos.

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

---

## 10. Os testes não passavam pelo `tsc` — CORRIGIDO

Levantado durante a correção dos nove: `tsconfig.json` cobre só `src/`, então um fake que deixasse de
satisfazer a interface que declara `implements` só aparecia quando o teste rodasse — e podia não
aparecer nunca, se nenhum caso exercitasse a parte que ficou de fora. Foi exatamente o que aconteceu
com o `MemoryFs` de `test/retrieval.test.ts` quando `FsOps.stat` ganhou `nlink`: 14 testes quebraram
em execução com um `TypeError`, e o `tsc` estava limpo.

**Correção:** `tsconfig.test.json` estende o base com `noEmit` e inclui `src`, `test` e
`vitest.config.ts` — o de build fica intocado, com seu `rootDir`/`outDir`/`declaration`, porque quem
emite não pode compilar teste. `npm run typecheck` roda esse projeto, e o `pretest` do npm o roda
antes de qualquer teste: a checagem está DENTRO do comando que o gate lê, e não ao lado dele.

Verificado por mutação: com o fake estreito de volta, `npm test` para no `pretest` com
`TS2416: Property 'stat' in type 'MemoryFs' is not assignable to the same property in base type
'FsOps'` e sai 1, antes de rodar um teste sequer.

**Cinco erros de tipo reais apareceram no primeiro `tsc` sobre `test/`,** todos corrigidos:
um `Note` literal sem `bodyStartLine` (`graph.test.ts`), duas chamadas de `learn()` cujo `as const`
congelava `tags` numa tupla `readonly` que `LearnOptions.tags: string[]` não aceita
(`learn.test.ts`), e dois acessos a `matter.clearCache()`/`matter.cache` (`template.test.ts`) — API
real do gray-matter em execução, ausente do `@types` dele, agora declarada num acessor tipado em vez
de silenciada com `any`.
