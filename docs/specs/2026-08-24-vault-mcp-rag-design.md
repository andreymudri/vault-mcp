---
tipo: spec
projeto: vault-mcp
status: aprovado
criado: 2026-08-24
---

# vault-mcp — RAG sobre o Knowledge Vault via MCP

## Objetivo

Expor o Knowledge Vault (`~/Work/Knowledge Vault`) ao Claude Code através de um MCP server
local, com busca ranqueada por relevância em vez de leitura integral, e com um caminho de
escrita que permite ao agente registrar aprendizados durante a sessão sem duplicar
conhecimento já existente.

## Contexto

O vault é um cofre Obsidian: 76 notas `.md`, ~404KB, em português (BR) com vocabulário
técnico em inglês. Estrutura:

```
00-index/     MOCs por domínio
01-raw/       staging não-validado (clippings, inbox, transcripts)
02-wiki/      conhecimento técnico curado (cpp, nestjs, docker, tauri, patterns, ...)
03-projects/  um diretório por projeto ativo, README.md como entrypoint
04-daily/     notas diárias YYYY-MM-DD.md
99-archive/   somente leitura
_templates/   templates Templater (wiki.md, projeto.md)
```

Convenções do vault (de `Knowledge Vault/CLAUDE.md`) que este sistema deve respeitar:
frontmatter YAML com `tipo`/`tags`/`criado`, wiki-links `[[nome]]` para referência cruzada,
datas `YYYY-MM-DD`, `01-raw/` não é lido sem necessidade explícita, `99-archive/` é imutável,
e toda citação de conhecimento inclui o caminho do arquivo.

O vault já é um repositório git.

## Decisões

| Decisão | Escolha | Razão |
|---|---|---|
| Consumidor | MCP server stdio para Claude Code | Integra ao fluxo de trabalho existente; sem servidor HTTP, sem rede |
| Retrieval | BM25 léxico + expansão pelo grafo de wiki-links | 76 notas curadas e densamente linkadas; embeddings não pagam a complexidade nessa escala |
| Armazenamento do índice | Em memória, rebuild incremental por `mtime` | 404KB indexa em ~50ms; SQLite/FTS5 traria dependência nativa sem benefício |
| Escrita | Irrestrita no vault, com commit git por operação | Pedido explícito do usuário; git torna toda escrita reversível |
| Ingestão de aprendizado | Tool `vault_learn` chamada pelo agente durante a sessão | Captura o conhecimento no momento em que aparece, sem job em background |
| Runtime | Node + TypeScript strict | Convenção do usuário; SDK oficial do MCP é TypeScript |

### Não-objetivos

- Sem embeddings, banco vetorial ou chamada a API de LLM. O modelo é o próprio Claude Code;
  este servidor só faz retrieval e escrita.
- Sem `vault_delete`. Apagar nota é raro e se faz com `rm`; não vale a superfície de risco.
- Sem watcher de filesystem ou daemon de sincronização. Revalidação acontece por chamada.
- Sem job periódico de consolidação. Se fizer falta, é feature futura sobre as mesmas tools.

### Gatilho de migração

Se o vault ultrapassar ~50MB ou ~5000 notas, o cold start deixa de ser aceitável e o índice
deve migrar para SQLite + FTS5. O contrato `SearchResult[]` entre `retrieval/` e `server/`
existe para que essa troca não toque nas tools.

## Arquitetura

Processo Node único, transporte stdio, registrado como MCP server no Claude Code.
Configurado por `VAULT_PATH` (obrigatório, caminho absoluto do vault).

### Módulos

| Módulo | Responsabilidade | Depende de |
|---|---|---|
| `vault/` | Varrer o diretório, parsear frontmatter + corpo, resolver `[[wiki-links]]` para caminhos reais | fs |
| `index/` | Chunking, tokenização PT/EN, índice invertido, scoring BM25 | `vault/` |
| `graph/` | Adjacência de links: backlinks, vizinhos, expansão de um salto | `vault/` |
| `retrieval/` | Orquestra BM25 → expansão no grafo → dedupe → ranking → montagem do contexto citado | `index/`, `graph/` |
| `write/` | Criar/editar nota, aplicar template, garantir frontmatter, commitar | `vault/` |
| `server/` | Definição das tools MCP, validação de entrada com zod, tradução para os módulos acima | todos |

Cada módulo é testável isoladamente. `server/` não contém lógica de domínio — só validação
e tradução.

### Fluxo de leitura

1. Tool call chega em `server/`, validada por schema zod.
2. `retrieval` revalida mtimes; só arquivo sujo é re-parseado e tem chunks substituídos.
3. BM25 sobre os chunks, filtrado por `tipo`/`folder` se informado.
4. Top-K do BM25 → coleta notas de origem → puxa vizinhos no grafo (links de saída +
   backlinks) → pontua chunks vizinhos com amortecimento.
5. Merge, dedupe por chunk id, reordena, corta no orçamento.
6. Retorna trechos com `caminho:linha`, heading e score.

### Fluxo de escrita

1. Valida que o caminho resolvido está dentro de `VAULT_PATH` (bloqueia `..` e symlink para fora).
2. Rejeita se o caminho cai em `99-archive/` ou `_templates/`.
3. Escrita atômica: grava em arquivo temporário no mesmo diretório e faz `rename`.
4. `git add <paths...> && git commit` com mensagem convencional, um commit por operação de tool.
5. Invalida a entrada do arquivo no índice.

## Indexação e retrieval

### Chunking

Consciente de markdown: quebra nos headings `##` e `###`, nunca dentro de um bloco de código
cercado. Cada chunk carrega `{ path, headingPath, lineStart, lineEnd, tipo, tags }`, os dois
últimos vindos do frontmatter da nota. Notas de ~5KB produzem tipicamente 3-6 chunks.

O corpo anterior ao primeiro heading vira um chunk próprio, atribuído ao título da nota.

### Tokenização

- Lowercase e *accent folding*: `decisão` e `decisao` colapsam no mesmo termo, tanto na
  indexação quanto na query.
- Stopwords de português e inglês, ambas aplicadas.
- **Sem stemming.** O RSLP para português é agressivo demais e corromperia vocabulário
  técnico (`bullmq`, `nestjs`, `mongoose`). Se busca por radical se mostrar necessária na
  prática, é alteração localizada em `index/`.
- Tokens preservam dígitos e hífen interno (`multi-stage`, `v6`, `oauth2`).

### Normalização de datas do frontmatter

YAML resolve data não-aspada (`criado: 2026-01-10`) para um objeto `Date`, não string — comportamento
padrão do js-yaml, que o `gray-matter` usa. Todas as notas do vault escrevem datas assim. O parser
converte `criado` e `atualizado` de volta para string `YYYY-MM-DD` na normalização, porque o resto do
sistema compara e serializa essas datas como texto: `atualizado:` é reescrito por string e a captura
diária monta um nome de arquivo. Um `Date` vazando para lá vira erro silencioso, não exceção.

### Scoring BM25

Parâmetros `k1 = 1.2`, `b = 0.75`.

Pesos por campo, aplicados como multiplicador na frequência do termo:

| Campo | Peso |
|---|---|
| Título da nota e heading do chunk | 3.0 |
| Tags do frontmatter | 2.0 |
| Corpo em prosa | 1.0 |
| Conteúdo dentro de bloco de código | 0.5 |

O peso reduzido em bloco de código impede que um Dockerfile ou um dump de tipos domine
qualquer query por acúmulo de termos.

**Peso por tipo de nota.** Depois do BM25, o score de cada chunk é multiplicado por um fator que
depende do `tipo` da nota: `moc` e `daily` valem **0.3**, qualquer outro tipo vale **1.0**.

A razão é estrutural, não ajuste empírico. Um MOC contém linhas como
`- [[bullmq-worker]] — worker de fila separado do API`: elas repetem a query inteira num chunk de
~11 tokens contra uma média de ~18, e a normalização por comprimento do BM25 então coloca **o
ponteiro acima da coisa apontada**. Capturas diárias (`- 09:14 [[nota]] (pattern, projeto)`) têm o
mesmo formato e o mesmo efeito. MOC e daily são navegação e log — listas de ponteiros para
conhecimento, não o conhecimento. O fator os mantém alcançáveis quando são de fato a melhor
resposta, sem deixá-los superar a nota que indexam.

### Expansão pelo grafo

- Toma os 8 melhores chunks do BM25.
- Coleta as notas de origem desses chunks.
- Para cada uma, reúne vizinhos: notas linkadas e notas que a linkam (backlinks).
- Pontua os chunks dessas vizinhas com **0.4 × o score do chunk de origem** que as alcançou —
  não com o BM25 do próprio chunk vizinho.
- Merge com o conjunto original, dedupe por chunk id (mantendo o maior score), reordena.

Herdar o score da origem, em vez de re-pontuar o vizinho com BM25, é o que faz a expansão
existir. Se o vizinho fosse pontuado por BM25 e depois amortecido, um vizinho que não casa
lexicalmente com a query valeria `0 × 0.4 = 0` e nunca apareceria — a expansão só reordenaria o
que o BM25 já encontrou, que é precisamente o que ela não deve fazer. O caso que ela existe para
cobrir é a nota relevante escrita com outro vocabulário, alcançável apenas pelo link.

Quando um chunk chega pelas duas vias, o merge mantém o **maior** dos dois scores, então expansão
nunca rebaixa um acerto direto.

Expansão é de **um salto apenas**. Dois saltos, num vault com essa densidade de links, alcança
praticamente todo o conteúdo e destrói a precisão.

### Orçamento de retorno

Padrão: até 6 chunks ou ~8000 caracteres, o que vier primeiro; `limit` sobrescreve a
contagem. Retorna trecho, nunca a nota inteira — `vault_get_note` cobre esse caso.

### Diretórios fora do índice

`.git/`, `.obsidian/`, `node_modules/` e qualquer entrada iniciada por ponto são ignorados, e
**`_templates/` também**. Os templates carregam frontmatter real (`tipo: projeto`), então indexá-los
faria `vault_list` com `tipo: 'projeto'` devolver o template junto dos projetos de verdade. Template
é andaime de escrita, não conteúdo.

### Reindexação incremental

Mapa `path → mtime` mantido em memória. A cada chamada, `vault/` compara mtimes; apenas
arquivos com mtime alterado (ou novos) são re-parseados, e seus chunks antigos são removidos
do índice invertido antes de inserir os novos. Arquivos removidos do disco têm seus chunks
descartados. Cold start completo varre 76 arquivos em ~50ms, então não há cache em disco.

## Superfície de tools MCP

### Leitura

| Tool | Entrada | Saída |
|---|---|---|
| `vault_search` | `query: string`, `limit?: number`, `tipo?: string`, `folder?: string`, `include_raw?: boolean` | Chunks ranqueados com `caminho:linha`, heading, score |
| `vault_get_note` | `path: string` | Nota inteira, frontmatter parseado, links de saída, links quebrados |
| `vault_list` | `tipo?: string`, `tags?: string[]`, `status?: string`, `folder?: string` | Lista de notas filtrada por frontmatter |
| `vault_backlinks` | `path: string` | Notas que apontam para o caminho dado |

`vault_search` exclui `01-raw/` por padrão, conforme a regra do vault de que aquilo é staging
não-validado. `include_raw: true` inclui.

### Escrita

| Tool | Entrada | Comportamento |
|---|---|---|
| `vault_write_note` | `path`, `content`, `frontmatter?` | Cria ou substitui. Aplica `_templates/wiki.md` ou `_templates/projeto.md` conforme `tipo`, garante frontmatter válido com `criado`, commita |

| `vault_edit_note` | `path`, `old_text`, `new_text` | Substituição exata de trecho; falha se `old_text` não for encontrado ou não for único. Evita reescrever a nota inteira |
| `vault_learn` | `titulo`, `insight`, `contexto`, `dominio`, `projeto?`, `tags?`, `links?` | Ver abaixo |

### `vault_learn`

O ciclo fechado: o retrieval é usado na **entrada** de conhecimento, não só na saída.

1. Roda `titulo` + `insight` como query no retrieval.
2. Se o melhor match passa na **regra de duplicata** (abaixo), **anexa** à nota existente uma
   seção datada `## YYYY-MM-DD — {titulo}`.
3. Caso contrário, **cria** nota nova em `02-wiki/{dominio}/` a partir de `_templates/wiki.md`,
   com frontmatter preenchido (`tipo: wiki`, `tags`, `criado`) e wiki-links para `links?`.
4. Em ambos os casos, **propaga** (abaixo), commita tudo num único commit e **retorna o diff
   aplicado**, cobrindo todos os arquivos tocados.

`titulo` e `dominio` são fornecidos pelo agente, não inferidos pelo servidor — não há LLM
neste processo. `dominio` é validado contra os diretórios existentes em `02-wiki/`; um domínio
novo exige `confirm_novo_dominio: true`, para que o agente não invente taxonomia por engano.

Retornar o diff é obrigatório: a decisão de anexar-vs-criar fica visível na hora, em vez de
ser descoberta depois numa nota errada.

### Propagação automática

`vault_learn` é a operação de uso diário, então ela mantém as estruturas de navegação do vault
coerentes sozinha. Toda chamada bem-sucedida propaga para três lugares, e os três mais a nota
entram num **único commit**:

**1. MOC do domínio** — `02-wiki/{dominio}/{dominio}-moc.md`.
Ao criar nota nova, insere `- [[{slug}]] — {resumo}` ao final da lista sob `## Notas` e atualiza
`atualizado:` no frontmatter para a data corrente. Ao anexar a nota existente, só o `atualizado:`
é tocado — a entrada já está lá.
Se o MOC não existir, é criado. Isso não é hipotético: `02-wiki/performance/` e `02-wiki/tauri/`
hoje não têm MOC. O MOC criado segue o formato dos existentes: frontmatter `tipo: moc`,
`tags: [{dominio}]`, `criado`, `atualizado`; título `# {Dominio} — Mapa de Conteúdo`; seções
`## Notas` e `## Relacionados`, esta última já linkando `[[../../00-index/index-knowledge|índice de conhecimento]]`.

**2. Índice de conhecimento** — `00-index/index-knowledge.md`.
Só é tocado quando um domínio novo é criado: acrescenta `- [[../02-wiki/{dominio}/{dominio}-moc|{dominio}]] — {resumo do domínio}`
sob `## Domínios` e atualiza `atualizado:`. Domínio já listado não gera escrita.

**3. Nota diária** — `04-daily/{YYYY-MM-DD}.md`.
Acrescenta `- {HH:MM} [[{slug}]] ({tipo}, {projeto})` sob `## Capturas`, no formato já usado em
`04-daily/2026-04-20.md`. `{tipo}` é `pattern`, `gotcha`, `decisão` ou `estado`, derivado das
`tags` quando uma delas casa, e `aprendizado` como padrão. `{projeto}` vem do parâmetro `projeto?`;
ausente, o sufixo entre parênteses traz só o tipo. Se a nota do dia não existir, é criada com
frontmatter `tipo: daily`, `criado: {YYYY-MM-DD}` e a seção `## Capturas` — o formato de
`2026-04-20.md`, não o de `2026-04-17.md`, que é anterior à convenção.

**Atomicidade.** Os arquivos são gravados um a um (cada um atomicamente, via tmp + `rename`), e o
commit acontece **uma vez ao final**, cobrindo o conjunto. Se a gravação de um arquivo de
propagação falhar depois da nota já estar em disco, a operação retorna `warning` descrevendo o que
não propagou e ainda assim commita o que gravou — perder a nota para preservar a coerência de um
MOC seria a troca errada. Nenhum estado fica só na memória do processo.

**Regra de duplicata.** Score BM25 bruto não é comparável entre queries, então o critério é
relativo e conjuntivo — o match precisa satisfazer as duas condições:

1. O melhor chunk tem score de pelo menos **1.8×** o do segundo colocado vindo de outra nota
   (o topo se destaca, em vez de haver empate difuso entre notas).
2. A nota desse chunk compartilha ao menos **uma tag de frontmatter** com as `tags` informadas,
   **ou** `dominio` bate com o diretório dela em `02-wiki/`.

Não satisfeitas as duas, cria nota nova. O viés é deliberado: errar criando nota nova é barato
de consertar, errar anexando polui uma nota curada. O fator `1.8` é ajustado contra as golden
queries da suíte de testes, não chutado em produção.

### Aplicação de template

Os arquivos em `_templates/` usam sintaxe Templater do Obsidian (`<% tp.date.now("YYYY-MM-DD") %>`,
`<% tp.file.title %>`), que só é expandida pelo plugin dentro do Obsidian. Ao aplicar um
template, `write/` **substitui esses tokens** antes de gravar — `tp.date.now(fmt)` pela data
corrente no formato pedido, `tp.file.title` pelo nome do arquivo sem extensão. Nenhum token
`<% %>` pode sobrar no arquivo gravado; sobrar é falha de teste.

### Guarda-corpos

A escrita é irrestrita por decisão do usuário, com estas proteções:

- Caminho resolvido precisa estar dentro de `VAULT_PATH`; `..` e symlinks para fora são rejeitados.
- `99-archive/` e `_templates/` são negados a qualquer escrita.
- Toda escrita bem-sucedida vira um commit git isolado, com mensagem convencional. Reverter
  qualquer operação é `git revert`.

## Tratamento de erro

Princípio: nenhum dado perdido; degradação parcial em vez de crash.

| Situação | Comportamento |
|---|---|
| `VAULT_PATH` ausente ou não é diretório | Falha no boot com mensagem explícita. Único erro fatal |
| Frontmatter malformado | Nota é indexada com frontmatter vazio; registro em diagnostics. Uma nota quebrada não derruba o índice |
| Wiki-link apontando para nada | Ignorado pelo grafo; reportado por `vault_get_note` como sinal de manutenção |
| Git indisponível ou commit falha | Os arquivos já foram gravados; retorna warning de que não commitou. Nunca desfaz a escrita |
| Propagação falha após a nota gravada | Retorna warning nomeando o alvo que não propagou; a nota permanece e o commit cobre o que foi gravado |
| Caminho fora do vault ou em pasta negada | Erro de tool, sem escrita parcial |
| Arquivo aberto no Obsidian durante write | Escrita atômica via tmp + `rename`; nunca deixa meio-arquivo |
| `vault_edit_note` com `old_text` ambíguo ou ausente | Erro de tool descrevendo o problema; nenhuma escrita |
| Busca sem resultado | Retorna explicitamente "sem match" mais até 5 termos do vocabulário do índice a distância de Levenshtein ≤ 2 dos termos da query, não array vazio silencioso |

## Testes

Desenvolvimento por TDD: teste falhando primeiro, verificado falhando pelo motivo certo.

### Fixture

Vault sintético em `test/fixtures/vault/`, contendo: notas em português com termos técnicos
em inglês, wiki-links válidos, ao menos um wiki-link quebrado, uma nota com frontmatter
malformado, uma nota com bloco de código grande, e notas em `01-raw/` e `99-archive/`.

### Unitários

- **Tokenizer** — accent folding colapsa `decisão`/`decisao`; stopwords PT e EN removidas;
  `nestjs` e `multi-stage` sobrevivem intactos.
- **Chunker** — nunca parte bloco de código cercado; `lineStart`/`lineEnd` correspondem às
  linhas reais do arquivo; corpo pré-heading vira chunk próprio.
- **BM25** — ranking conhecido sobre a fixture; peso de campo altera a ordem de forma
  verificável; conteúdo em bloco de código não domina.
- **Grafo** — backlinks corretos nos dois sentidos; wiki-link quebrado não entra na adjacência.

### Integração

- **Golden queries** — cerca de 10 pares pergunta → nota esperada no topo, atravessando o
  retrieval completo (BM25 + expansão + orçamento). É a rede que pega regressão de scoring.
- **Filtros** — `tipo`/`folder` restringem corretamente; `01-raw/` fica fora sem `include_raw`.

### Escrita

Executados contra um repositório git temporário.

- `vault_write_note` grava e produz commit; template correto por `tipo`.
- Path traversal (`../fora.md`) e escrita em `99-archive/` são rejeitados.
- `vault_learn` anexa seção datada quando há duplicata acima do limiar; cria nota nova quando
  não há; retorna diff nos dois casos.
- Falha de git preserva o arquivo gravado e retorna warning.

### Reindexação

Tocar um arquivo reindexa apenas ele; chunks das demais notas mantêm identidade e score.
Remover um arquivo descarta seus chunks.
