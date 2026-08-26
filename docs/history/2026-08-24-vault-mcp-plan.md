> **Documento histórico.** Este é o plano de implementação ORIGINAL do vault-mcp, executado e
> encerrado — as caixas `- [ ]` são o texto do plano como foi escrito, não trabalho pendente. O
> estado real do projeto está em [`docs/followups.md`](../followups.md).

# Plano de implementação — vault-mcp

Spec: `docs/specs/2026-08-24-vault-mcp-rag-design.md`

## Global Constraints

- Node >= 20
- TypeScript strict (`strict: true`, `noUncheckedIndexedAccess: true`), ESM (`"type": "module"`)
- Dependências de runtime permitidas, e nenhuma outra: `@modelcontextprotocol/sdk`, `zod`, `gray-matter`
- Dependências de dev permitidas, e nenhuma outra: `typescript`, `vitest`, `@types/node`
- Proibido: qualquer client de LLM, biblioteca de embeddings, banco de dados, dependência nativa
- Identificadores e comentários de código em inglês; documentação e mensagens ao usuário em português (BR)
- Commits: conventional commits, uma linha, em português
- Todo módulo exporta funções puras onde possível; I/O concentrado em `vault/scanner.ts`, `write/` e `server/`
- Testes com vitest; todo teste lê `test/fixtures/vault/`, nunca o vault real
- **Nenhum teste escreve dentro de `test/fixtures/vault/`.** Teste que precisa mutar o vault copia a fixture para um diretório temporário no `beforeEach` e opera na cópia. O vitest roda arquivos de teste em paralelo, então mutação in place faz um teste corromper a leitura de outro de forma intermitente e não reproduzível

## Destination

`npx vault-mcp` sobe um MCP server stdio que responde `vault_search`, `vault_get_note`,
`vault_list`, `vault_backlinks`, `vault_write_note`, `vault_edit_note` e `vault_learn` contra
`$VAULT_PATH`, com a suíte vitest verde e as golden queries retornando a nota esperada no topo.

## Not Yet Specified

- Quando o vault crescer, qual sinal concreto dispara a migração para SQLite/FTS5 — número de notas, tempo de cold start medido, ou consumo de memória?
- Se duas notas empatam na regra de duplicata, faz sentido o servidor devolver as duas e deixar o agente escolher, em vez de criar nota nova?

## Out of Scope

- Embeddings, busca vetorial e reranking neural — o vault tem 76 notas curadas e densamente linkadas; BM25 mais grafo resolve nessa escala e a decisão está registrada no spec
- `vault_delete` — apagar nota é raro e se faz com `rm`, então a tool só adicionaria superfície de escrita destrutiva
- Watcher de filesystem ou daemon de sincronização — revalidação por `mtime` a cada chamada custa milissegundos em 404KB, logo um processo persistente não paga
- Job periódico de consolidação do vault — o usuário escolheu captura em tempo real via `vault_learn`; consolidação em lote é outro produto, com outro spec

---

### Task 1: scaffold do projeto e tipos compartilhados

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`

**Model:** cheap

- [ ] **Step 1:** Criar `package.json` com `"type": "module"`, `"name": "vault-mcp"`, `"bin": { "vault-mcp": "./dist/server/index.js" }`, scripts `build` (`tsc`), `test` (`vitest run`), `dev` (`tsc --watch`). Dependências exatamente `@modelcontextprotocol/sdk`, `zod`, `gray-matter`; devDependencies exatamente `typescript`, `vitest`, `@types/node`. Campo `engines.node` = `">=20"`.

- [ ] **Step 2:** Criar `tsconfig.json` com `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"outDir": "dist"`, `"rootDir": "src"`, `"declaration": true`, e `"include": ["src"]`.

- [ ] **Step 3:** Criar `vitest.config.ts` exportando `defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })`.

- [ ] **Step 4:** Criar `src/types.ts` com todos os tipos compartilhados do sistema. Este arquivo não é modificado por nenhuma outra task; qualquer tipo novo mora no módulo que o usa.

```ts
/** Parsed frontmatter of a note. Unknown keys are preserved. */
export interface Frontmatter {
  tipo?: string;
  tags?: string[];
  status?: string;
  criado?: string;
  [key: string]: unknown;
}

/** A note as read from disk. `path` is always vault-relative, POSIX separators. */
export interface Note {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  /** Body with the frontmatter block stripped. */
  body: string;
  /** Vault-relative paths this note links to, resolved and existing. */
  links: string[];
  /** Raw link targets that resolved to nothing. */
  brokenLinks: string[];
  mtimeMs: number;
}

/** A retrievable unit of a note. */
export interface Chunk {
  /** Stable id: `${path}#${lineStart}`. */
  id: string;
  path: string;
  /** Heading trail, e.g. ['Payload do JWT']. Empty for the pre-heading chunk. */
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  text: string;
  tipo?: string;
  tags: string[];
}

/** One field of a chunk, carrying its BM25 weight. */
export type FieldName = 'heading' | 'tags' | 'prose' | 'code';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  /** True when the chunk entered the result set through graph expansion. */
  viaGraph: boolean;
}

export interface SearchResult {
  results: ScoredChunk[];
  /** Populated only when `results` is empty. */
  suggestions?: string[];
}

export interface Diagnostic {
  path: string;
  message: string;
}
```

---

### Task 2: fixture de vault sintético para testes

**Files:**
- Create: `test/fixtures/vault/CLAUDE.md`
- Create: `test/fixtures/vault/02-wiki/nestjs/auth-guard.md`
- Create: `test/fixtures/vault/02-wiki/nestjs/bullmq-worker.md`
- Create: `test/fixtures/vault/02-wiki/docker/multi-stage.md`
- Create: `test/fixtures/vault/02-wiki/patterns/cache-wrapper.md`
- Create: `test/fixtures/vault/02-wiki/nestjs/nestjs-moc.md`
- Create: `test/fixtures/vault/02-wiki/docker/docker-moc.md`
- Create: `test/fixtures/vault/00-index/index-knowledge.md`
- Create: `test/fixtures/vault/04-daily/2026-08-20.md`
- Create: `test/fixtures/vault/03-projects/potentia/README.md`
- Create: `test/fixtures/vault/01-raw/inbox/rascunho.md`
- Create: `test/fixtures/vault/99-archive/antigo.md`
- Create: `test/fixtures/vault/_templates/wiki.md`
- Create: `test/fixtures/vault/_templates/projeto.md`
- Create: `test/fixtures/vault/quebrada.md`
- Create: `test/fixtures/vault/.obsidian/app.json`

**Model:** cheap

- [ ] **Step 1:** Criar `test/fixtures/vault/_templates/wiki.md` com o mesmo conteúdo do template real do vault, incluindo os tokens Templater intactos:

```markdown
---
tipo: wiki
tags: 
criado: <% tp.date.now("YYYY-MM-DD") %>
---

# <% tp.file.title %>

## Contexto

## Solução

## Exemplo
```

- [ ] **Step 2:** Criar `test/fixtures/vault/_templates/projeto.md` com frontmatter `tipo: projeto`, `status: ativo`, `criado: <% tp.date.now("YYYY-MM-DD") %>`, `stack:`, seguido de `# <% tp.file.title %>` e as seções `## Objetivo`, `## Stack`, `## Links`.

- [ ] **Step 3:** Criar `test/fixtures/vault/02-wiki/nestjs/auth-guard.md` com frontmatter `tipo: wiki`, `tags: [nestjs, auth, jwt]`, `criado: 2026-01-10`, e **um `# Auth Guard` como primeiro heading** — sem ele esta nota vira um segundo alvo de fallback de título ao basename, e a Task 6 perde a asserção de que `01-raw/inbox/rascunho.md` é o único. Corpo com um parágrafo antes do primeiro heading `##` mencionando "decisão de autenticação", depois `## Contexto` e `## Solução`. Em `## Solução`, incluir um wiki-link `[[bullmq-worker]]` e um wiki-link quebrado `[[nota-que-nao-existe]]`.

- [ ] **Step 4:** Criar `test/fixtures/vault/02-wiki/nestjs/bullmq-worker.md` com frontmatter `tipo: wiki`, `tags: [nestjs, bullmq, filas]`, `criado: 2026-01-12`. Incluir `## Contexto`, um `### Retry e backoff` aninhado sob ele, e `## Exemplo`.

  **Vocabulário obrigatório na prosa**, porque o tokenizador não faz stemming e a golden query `worker de fila` da Task 9 aponta para esta nota: o corpo precisa conter as formas **singulares** `fila` e `worker` em prosa corrida — por exemplo "cada `worker` consome uma `fila` gerenciada pelo BullMQ, separada do processo da API". `filas` dentro de `tags:` não satisfaz isto: `filas` e `fila` são termos distintos, e sem a forma singular a nota pontua zero no termo de maior IDF da query e a golden query falha.

  Sob `## Exemplo`, um bloco de código TypeScript cercado com pelo menos 25 linhas repetindo `queue`, `worker`, `process` — massa suficiente para exercitar a normalização por comprimento do BM25 num chunk real (o peso do campo `code` em si é testado direto no mecanismo, na Task 7, porque ranking emergente sobre esta fixture não discrimina). Dentro da cerca, incluir a linha `## nao e um heading` e um `[[link-dentro-de-codigo]]`: são os alvos de fixture das asserções da Task 5 (heading cercado não abre chunk) e da Task 3 (link dentro de cerca é ignorado).

  **Nível dois, não um.** O chunker só reconhece `##` e `###`, então uma linha `# ...` dentro da cerca nunca abriria chunk de qualquer jeito, e a asserção passaria com o rastreio de cerca inteiramente removido — teste vácuo. Com `##`, remover o `inFence` do chunker quebra o teste, que é a única forma de ele valer alguma coisa. A cerca também **não pode terminar no fim do arquivo**: precisa haver prosa depois dela, senão a diferença entre rastrear e não rastrear cerca não se manifesta em nenhum chunk.

  Em `### Retry e backoff`, linkar `[[auth-guard]]` **duas vezes** no mesmo parágrafo — alvo da asserção da Task 3 de que alvo repetido aparece uma vez só.

- [ ] **Step 5:** Criar `test/fixtures/vault/02-wiki/docker/multi-stage.md` com frontmatter `tipo: wiki`, `tags: [docker, build]`, `criado: 2026-02-01`, com `## Contexto` e `## Solução`.

  **O token literal `multi-stage` precisa aparecer na prosa do corpo**, não só no `# ` do título, e o corpo precisa falar de `cache` e `camadas`. As golden queries `build multi-stage` e `cache de camadas docker` apontam para esta nota; escrever o conceito apenas como `multi-estágio` e `estágios` produz termos distintos aos olhos do tokenizador, e a nota perde a query para a linha do `docker-moc.md` que o próprio plano manda conter `build multi-stage e cache de camadas`.

- [ ] **Step 6:** Criar `test/fixtures/vault/02-wiki/patterns/cache-wrapper.md` com frontmatter `tipo: wiki`, `tags: [patterns, redis, cache]`, `criado: 2026-02-05`, contendo um wiki-link `[[auth-guard]]` para dar ao grafo um backlink verificável.

- [ ] **Step 7:** Criar `test/fixtures/vault/03-projects/potentia/README.md` com frontmatter `tipo: projeto`, `status: ativo`, `stack: [nestjs, mongoose, redis]`, `criado: 2026-01-05`, com wiki-links para `[[cache-wrapper]]` e `[[auth-guard]]`.

- [ ] **Step 8:** Criar `test/fixtures/vault/01-raw/inbox/rascunho.md` sem frontmatter **e sem nenhum heading `# `**, com o termo distintivo `rascunhoexclusivo` no corpo. Duas asserções dependem dele: o termo prova que `01-raw/` foi excluído ou incluído na busca, e a ausência de H1 é o único alvo de fixture para o fallback de título ao basename da Task 6.

- [ ] **Step 9:** Criar `test/fixtures/vault/99-archive/antigo.md` com frontmatter `tipo: wiki`, `criado: 2025-06-01`, corpo curto.

- [ ] **Step 10:** Criar `test/fixtures/vault/quebrada.md` com um bloco de frontmatter YAML sintaticamente inválido (chave sem valor e indentação corrompida), seguido de corpo em markdown válido contendo o termo `frontmatterpodre`.

- [ ] **Step 11:** Criar `test/fixtures/vault/02-wiki/nestjs/nestjs-moc.md` no formato dos MOCs reais: frontmatter `tipo: moc`, `tags: [nestjs]`, `criado: 2026-01-08`, `atualizado: 2026-01-12`; título `# NestJS — Mapa de Conteúdo`; seção `## Notas` com `- [[auth-guard]] — guard de autenticação JWT` e `- [[bullmq-worker]] — worker de fila separado do API`; seção `## Relacionados` com `- [[../../00-index/index-knowledge|índice de conhecimento]]`.

- [ ] **Step 12:** Criar `test/fixtures/vault/02-wiki/docker/docker-moc.md` no mesmo formato, `tags: [docker]`, `criado: 2026-02-01`, `atualizado: 2026-02-01`, com `## Notas` contendo `- [[multi-stage]] — build multi-stage e cache de camadas`.

  **`02-wiki/patterns/` fica deliberadamente sem MOC.** É o caso que prova que a propagação cria o MOC ausente — situação real, já que `02-wiki/performance/` e `02-wiki/tauri/` no vault do usuário também não têm.

- [ ] **Step 13:** Criar `test/fixtures/vault/00-index/index-knowledge.md` com frontmatter `tipo: moc`, `atualizado: 2026-02-01`; título `# Índice de Conhecimento`; seção `## Domínios` com `- [[../02-wiki/nestjs/nestjs-moc|nestjs]] — NestJS, providers, guards, filas` e `- [[../02-wiki/docker/docker-moc|docker]] — Dockerfiles, multi-stage, compose`. `patterns` fica de fora do índice de propósito, mas **não** é o alvo do teste de domínio novo: `02-wiki/patterns/` existe no disco, então `domainIsNew` é falso para ele. O alvo daquele teste é um domínio genuinamente ausente, como `rust`. O que a omissão de `patterns` cobre é o caso oposto — MOC ausente num domínio que existe (Task 14).

- [ ] **Step 14:** Criar `test/fixtures/vault/04-daily/2026-08-20.md` no formato de `04-daily/2026-04-20.md` do vault real: frontmatter `tipo: daily`, `criado: 2026-08-20`; título `# 2026-08-20`; seção `## Capturas` com uma linha existente `- 09:14 [[multi-stage]] (pattern, potentia)`.

- [ ] **Step 15:** Criar `test/fixtures/vault/.obsidian/app.json` com um JSON mínimo (`{"theme":"obsidian"}`). Sem ele, a asserção da Task 6 de que `.obsidian/` é ignorado não tem alvo: ela passa num diretório que não existe, e passaria igual se o scanner não ignorasse nada.

- [ ] **Step 16:** Em `00-index/index-knowledge.md`, acrescentar uma seção `## Convenções` **depois** de `## Domínios`, e em `04-daily/2026-08-20.md` uma seção `## Próximo` **depois** de `## Capturas`. As duas asserções de `insertUnderSection` da Task 14 exigem inserção após o último item da seção; com a seção terminando no fim do arquivo, uma implementação que simplesmente concatena no fim do arquivo passa nos dois testes sem nunca localizar seção nenhuma.

- [ ] **Step 17:** Criar `test/fixtures/vault/CLAUDE.md` com uma nota curta de navegação — existe para garantir que arquivos `.md` na raiz do vault sejam indexados normalmente.

---

### Task 3: parser de frontmatter e extração de wiki-links

**Files:**
- Create: `src/vault/frontmatter.ts`
- Create: `src/vault/links.ts`
- Test: `test/frontmatter.test.ts`
- Test: `test/links.test.ts`

**Depends:** T1, T2

- [ ] **Step 1:** Escrever `test/frontmatter.test.ts` com testes falhando: frontmatter válido devolve `tipo`, `tags` e `criado`, e `criado` é a **string** `'2026-01-10'`, não um `Date`; `atualizado` de `nestjs-moc.md` idem. Este teste roda sob `TZ=America/Sao_Paulo` (UTC−3) e sob `TZ=UTC`, e deve dar o mesmo resultado nos dois — é a asserção que pega a confusão entre data de YAML e instante de relógio; `tags` escrito como string única (`tags: nestjs`) é normalizado para array; arquivo sem frontmatter devolve objeto vazio e corpo intacto; `test/fixtures/vault/quebrada.md` devolve frontmatter vazio, corpo preservado e um diagnostic, sem lançar exceção; e **parsear o mesmo conteúdo duas vezes seguidas produz o mesmo diagnostic nas duas** — sem `matter(raw, {})` o `gray-matter` memoiza, a segunda chamada não lança, o diagnostic some e o bloco de frontmatter cru vaza para o corpo indexado.

- [ ] **Step 2:** Implementar `src/vault/frontmatter.ts`:

```ts
import matter from 'gray-matter';
import type { Frontmatter, Diagnostic } from '../types.js';

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
  diagnostic?: Diagnostic;
}

/** Never throws. A malformed frontmatter block yields empty frontmatter plus a diagnostic. */
export function parseFile(path: string, raw: string): ParsedFile {
  try {
    // `matter(raw)` memoises by content: a malformed block throws on the FIRST call of the
  // process and afterwards returns `{data:{}, content: <raw, frontmatter not stripped>}`.
  // Incremental reindex re-parses the same file repeatedly, so the cached path would silently
  // index the raw frontmatter as body text. The options object bypasses the cache.
  const parsed = matter(raw, {});
    return { frontmatter: normalize(parsed.data), body: parsed.content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      frontmatter: {},
      body: stripFrontmatterBlock(raw),
      diagnostic: { path, message: `frontmatter inválido: ${message}` },
    };
  }
}

function normalize(data: Record<string, unknown>): Frontmatter {
  const fm: Frontmatter = { ...data };
  const tags = data['tags'];
  if (typeof tags === 'string') fm.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  else if (Array.isArray(tags)) fm.tags = tags.map((t) => String(t));
  else fm.tags = [];
  // YAML resolves an unquoted `2026-01-10` to a Date. Every note in the vault writes dates that
  // way, and the rest of the system compares and serializes them as text, so convert back here
  // rather than letting a Date leak into `atualizado:` rewriting or a daily-note filename.
  for (const key of ['criado', 'atualizado'] as const) {
    const value = data[key];
    if (value instanceof Date) fm[key] = yamlDateToIsoDay(value);
  }
  return fm;
}

/**
 * YYYY-MM-DD in UTC. js-yaml builds a frontmatter date as UTC midnight, carrying no time zone
 * of its own, so local getters would read `2026-01-10` back as `2026-01-09` anywhere west of
 * Greenwich. This function is ONLY for dates that came out of YAML.
 */
function yamlDateToIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Drops a leading `---` block so a broken header never leaks into the indexed body. */
function stripFrontmatterBlock(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw : raw.slice(raw.indexOf('\n', end + 1) + 1);
}
```

- [ ] **Step 3:** Escrever `test/links.test.ts` com testes falhando: `[[bullmq-worker]]` no fixture resolve para `02-wiki/nestjs/bullmq-worker.md`; `[[nota-que-nao-existe]]` cai em `brokenLinks`; a forma com alias resolve pelo alvo antes do `|`, verificada contra os aliases que existem de fato na fixture — `[[../02-wiki/nestjs/nestjs-moc|nestjs]]` em `00-index/index-knowledge.md` e o alias de `nestjs-moc.md` para o índice; link dentro de bloco de código cercado é ignorado; o mesmo alvo repetido duas vezes aparece uma vez só.

- [ ] **Step 4:** Implementar `src/vault/links.ts` exportando `extractLinkTargets(body: string): string[]` e `resolveLinks(targets: string[], fromPath: string, byBasename: Map<string, string[]>, allPaths: Set<string>): { links: string[]; brokenLinks: string[] }`. `extractLinkTargets` remove blocos de código cercados antes de casar `/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g`, e desduplica preservando ordem. `resolveLinks` tenta, nesta ordem: caminho relativo a `fromPath` com sufixo `.md`, caminho vault-relativo com `.md`, e por fim lookup por basename em `byBasename` — ambiguidade de basename (mais de um candidato) resolve pelo candidato de menor profundidade de diretório, e empate nisso conta como quebrado.

---

### Task 4: tokenizador PT/EN

**Files:**
- Create: `src/index/tokenizer.ts`
- Create: `src/index/stopwords.ts`
- Test: `test/tokenizer.test.ts`

**Depends:** T1

- [ ] **Step 1:** Escrever `test/tokenizer.test.ts` com testes falhando: `fold('decisão')` e `fold('decisao')` produzem a mesma string; `tokenize('A decisão de autenticação')` não contém `a` nem `de`; `tokenize('NestJS e BullMQ')` contém `nestjs` e `bullmq` inteiros; `tokenize('build multi-stage v6')` contém `multi-stage` e `v6`; `tokenize('the queue is running')` não contém `the` nem `is`; token de um caractere é descartado; hífen no início ou fim é aparado (`-worker-` vira `worker`).

- [ ] **Step 2:** Criar `src/index/stopwords.ts` exportando `STOPWORDS_PT` e `STOPWORDS_EN` como `ReadonlySet<string>`, já em forma dobrada (sem acento, minúscula). `STOPWORDS_PT` cobre artigos, preposições, contrações e verbos auxiliares comuns: `a, o, as, os, um, uma, uns, umas, de, do, da, dos, das, em, no, na, nos, nas, por, pelo, pela, para, pra, com, sem, sob, sobre, entre, ate, apos, e, ou, mas, que, se, como, quando, onde, qual, quais, quem, cujo, ao, aos, a, e, este, esta, isso, isto, esse, essa, aquele, aquela, seu, sua, seus, suas, meu, minha, ser, e, sao, foi, era, ter, tem, ha, haver, fazer, faz, pode, deve, muito, mais, menos, tambem, nao, sim, ja, so, entao`. `STOPWORDS_EN` cobre `the, a, an, and, or, but, if, of, to, in, on, at, by, for, with, from, as, is, are, was, were, be, been, being, it, its, this, that, these, those, there, here, we, you, they, he, she, do, does, did, can, could, should, would, will, not, no, yes, so, than, then, when, where, which, who, what, how`.

- [ ] **Step 3:** Implementar `src/index/tokenizer.ts`:

```ts
import { STOPWORDS_EN, STOPWORDS_PT } from './stopwords.js';

/** Lowercase + accent folding, so `decisão` and `decisao` collapse to one term. */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Splits on anything that is not a letter, digit or hyphen, then trims edge hyphens.
 * No stemming: technical vocabulary (`nestjs`, `bullmq`) must survive intact.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const raw of fold(input).split(/[^a-z0-9-]+/)) {
    const term = raw.replace(/^-+/, '').replace(/-+$/, '');
    if (term.length < 2) continue;
    if (STOPWORDS_PT.has(term) || STOPWORDS_EN.has(term)) continue;
    out.push(term);
  }
  return out;
}
```

---

### Task 5: chunker consciente de markdown

**Files:**
- Create: `src/index/chunker.ts`
- Test: `test/chunker.test.ts`

**Depends:** T1, T2

- [ ] **Step 1:** Escrever `test/chunker.test.ts` com testes falhando, rodando sobre `test/fixtures/vault/02-wiki/nestjs/bullmq-worker.md`: nenhum chunk começa ou termina dentro do bloco de código cercado; `lineStart`/`lineEnd` de todo chunk correspondem às linhas reais do arquivo original (verificado refatiando o arquivo por essas linhas e comparando com `chunk.text`); o corpo anterior ao primeiro heading vira um chunk com `headingPath` vazio; um heading `###` aninhado sob um `##` produz `headingPath` de dois elementos; `id` tem a forma `${path}#${lineStart}`; um heading cercado dentro de bloco de código (`## nao e um heading`) não abre chunk novo — e este teste deve **falhar** se o rastreio de `inFence` for removido do chunker, o que o autor do teste precisa verificar comentando a linha uma vez.

- [ ] **Step 2:** Implementar `src/index/chunker.ts` exportando `chunkNote(path: string, body: string, tipo: string | undefined, tags: string[], bodyStartLine: number): Chunk[]`. `bodyStartLine` é a linha (1-based) do arquivo original onde o corpo começa, para que `lineStart` aponte para o arquivo e não para o corpo. O algoritmo varre linha a linha mantendo uma flag `inFence` alternada por linhas que casam `/^\s*(```|~~~)/`; headings só são reconhecidos com `inFence === false` e regex `/^(#{2,3})\s+(.*)$/`. Ao encontrar heading, fecha o chunk corrente (se tiver conteúdo não-vazio) e abre um novo. `headingPath` é mantido como pilha: `##` substitui o nível 1 e limpa o nível 2; `###` empilha no nível 2. Chunks cujo `text` seja só espaço em branco são descartados.

- [ ] **Step 3:** No mesmo arquivo, exportar `splitFields(text: string): { prose: string; code: string }` que separa o texto de um chunk em prosa e código: linhas dentro de blocos cercados vão para `code`, o resto para `prose`. `heading` e `tags` são preenchidos por quem chama, a partir de `headingPath` e `tags` do chunk. Esta função existe para que o scoring de BM25 aplique pesos diferentes sem re-tokenizar o chunk inteiro duas vezes.

---

### Task 6: scanner do vault com revalidação por mtime

**Files:**
- Create: `src/vault/scanner.ts`
- Test: `test/scanner.test.ts`

**Depends:** T1, T2, T3

- [ ] **Step 1:** Escrever `test/scanner.test.ts` com testes falhando: `scanVault` sobre a fixture encontra todos os `.md` inclusive na raiz e em `99-archive/`; caminhos retornados são vault-relativos com separador `/`; **`_templates/` é ignorado**, verificado pela saída: removendo essa entrada do ignore set, `_templates/projeto.md` e `_templates/wiki.md` aparecem na lista de caminhos. **`.obsidian/` e `.git/` são verificados de outro jeito — pela não-descida, não pela saída.** O scanner só coleta `.md`, e `.obsidian/` contém apenas JSON, então asserir que nenhum caminho `.obsidian/` saiu passa igualmente com a guarda deletada: medido, os 13 caminhos saem byte a byte idênticos com e sem ela. A asserção correta observa o `readdir`: `VaultScanner` recebe as operações de filesystem por injeção, e o teste conta em quais diretórios elas foram chamadas, exigindo que `.obsidian/` e `.git/` **nunca sejam abertos**.

  Duas condições sem as quais essa asserção também é vácua. **Primeira: o walker desce um diretório por vez.** `FsOps.readdir` é chamado uma vez por diretório visitado — nada de `{ recursive: true }`, nada de `fs.glob`. Um `readdir(root, { recursive: true })` faz uma única chamada com a raiz e o Node percorre `.obsidian/` e `.git/` inteiros por baixo: os mesmos 13 caminhos saem, a asserção passa verde com a lógica de ignore deletada, e no vault real do usuário — que é repositório git — o scanner varre todo o object store a cada `refresh()`. O teste fixa isso exigindo também que `readdir` **tenha sido** chamado para cada diretório não-ignorado, para o contador não poder ficar trivialmente vazio. **Segunda: o `.git/` precisa existir.** Não há `.git/` dentro de `test/fixtures/vault/`, e git não versiona diretório vazio, então essa metade nunca teria estado em que falhar; o teste cria `<tmp>/.git/objects` com um arquivo dentro na cópia temporária antes de asserir; `quebrada.md` aparece com `frontmatter` vazio e gera um diagnostic; `note.title` vem do primeiro `# ` do corpo, caindo para o basename sem extensão quando não houver; um segundo `refresh()` sem alteração no disco não re-parseia nada (verificado por um contador de leituras injetado); tocar um arquivo faz apenas ele ser re-parseado; remover um arquivo o retira do mapa.

- [ ] **Step 2:** Implementar `src/vault/scanner.ts` exportando a classe `VaultScanner`, construída com `{ vaultRoot: string }`. Estado interno: `notes: Map<string, Note>`, `mtimes: Map<string, number>`, `diagnostics: Diagnostic[]`. O construtor aceita também `{ fs?: FsOps }`, um objeto com `readdir`, `stat` e `readFile`, com implementação real como padrão. É por essa injeção que os testes contam leituras e diretórios abertos — tanto o de reindexação incremental quanto o de não-descida em `.obsidian/` e `.git/`.

  Método `refresh(): { changed: string[]; removed: string[] }` percorre o diretório recursivamente ignorando `.git`, `.obsidian`, `node_modules`, **`_templates`** e qualquer entrada iniciada por `.`; para cada `.md`, compara `stat.mtimeMs` com o mapa e só relê os alterados; ao final, remove do mapa os caminhos que sumiram do disco. Depois de ler todos os arquivos, uma segunda passada resolve wiki-links via `resolveLinks`, porque a resolução por basename precisa do conjunto completo de caminhos. `diagnostics` é reconstruído a cada `refresh` para não acumular entradas de arquivos já corrigidos.

- [ ] **Step 3:** Expor também `getNote(path: string): Note | undefined` e `allNotes(): Note[]`, e uma propriedade `readonly root: string`. Nenhum consumidor lê o filesystem diretamente — todo acesso a notas passa por aqui.

---

### Task 7: índice invertido e scoring BM25

**Files:**
- Create: `src/index/bm25.ts`
- Create: `src/index/inverted-index.ts`
- Test: `test/bm25.test.ts`

**Depends:** T1, T2, T4, T5

- [ ] **Step 1:** Escrever `test/bm25.test.ts` com testes falhando, construindo o índice a partir dos chunks da fixture: buscar `bullmq` devolve apenas chunks de `bullmq-worker.md` (formulação de topo-1: `auth-guard.md` referencia o alvo só como `[[bullmq-worker]]`, que o tokenizador preserva como o termo único `bullmq-worker`, então ela não pontua em `bullmq` e não há posição a comparar); buscar `jwt` traz `auth-guard.md` no topo; **Pesos de campo testados no mecanismo, não no ranking.** Ranking emergente sobre a fixture não discrimina: os reviewers mostraram que a asserção de heading passa mesmo com `FIELD_WEIGHTS.heading` rebaixado a 1.0, e que nenhuma query da fixture toca o bloco de código com força suficiente para que um `code` de 6.0 mude a ordem. Testar direto, então: `addChunk` de um chunk com o termo `alpha` só no heading produz frequência ponderada 3.0 para `alpha`; só nas tags, 2.0; só na prosa, 1.0; só dentro de cerca, 0.5. Cada asserção falha se o peso correspondente mudar — é isso que um teste de peso precisa fazer. Somar as quatro dá o `chunkLength` registrado, o que fixa a definição de comprimento ponderado do spec.

  Manter **uma** verificação de ranking, como sanidade de integração e não como teste de peso: uma query pelos termos do `## Contexto` de `bullmq-worker.md` devolve esse chunk acima do `## Exemplo`; termo inexistente devolve lista vazia; `vocabulary()` devolve os termos indexados.

  Peso por tipo de nota: uma query cujos termos casam tanto a linha `- [[bullmq-worker]] — worker de fila separado do API` de `nestjs-moc.md` quanto o corpo de `bullmq-worker.md` devolve `bullmq-worker.md` no topo; sem o fator o MOC vence, e o teste deve falhar se `NOTE_TYPE_WEIGHTS` for removido.

- [ ] **Step 2:** Implementar `src/index/inverted-index.ts` exportando a classe `InvertedIndex`. Estrutura: `postings: Map<string, Map<string, number>>` (termo → chunkId → frequência já ponderada por campo), `chunkLengths: Map<string, number>`, `chunks: Map<string, Chunk>`, `totalLength: number`. Métodos: `addChunk(chunk: Chunk): void`, `removeByPath(path: string): void`, `has(path: string): boolean`, `vocabulary(): IterableIterator<string>`, `size(): number`, `avgLength(): number`.

  `addChunk` tokeniza cada campo separadamente e acumula frequências ponderadas com os pesos do spec:

```ts
export const FIELD_WEIGHTS: Record<FieldName, number> = {
  heading: 3.0,
  tags: 2.0,
  prose: 1.0,
  code: 0.5,
};

/**
 * Applied to the final chunk score, not to term frequencies. A MOC line restates a note in the
 * query's own words inside a chunk far shorter than average, so BM25 length normalisation ranks
 * the pointer above the thing it points at. Same shape for a daily capture line. These notes are
 * navigation and log, not knowledge.
 */
export const NOTE_TYPE_WEIGHTS: Record<string, number> = { moc: 0.3, daily: 0.3 };

export function noteTypeWeight(tipo: string | undefined): number {
  return (tipo && NOTE_TYPE_WEIGHTS[tipo]) ?? 1.0;
}
```

  O comprimento do chunk usado no BM25 é a soma das frequências ponderadas, não a contagem crua de tokens — assim um chunk inflado por código não é penalizado como se fosse todo prosa.

- [ ] **Step 3:** Implementar `src/index/bm25.ts` exportando `search(index: InvertedIndex, query: string, limit: number): ScoredChunk[]`:

```ts
export const K1 = 1.2;
export const B = 0.75;

export function idf(totalDocs: number, docsWithTerm: number): number {
  return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

export function search(
  index: InvertedIndex,
  query: string,
  limit: number,
  keep?: (chunk: Chunk) => boolean,
): ScoredChunk[] {
  const terms = tokenize(query);
  const N = index.size();
  const avgdl = index.avgLength();
  const scores = new Map<string, number>();

  for (const term of terms) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    const termIdf = idf(N, postings.size);
    for (const [chunkId, freq] of postings) {
      const dl = index.chunkLengths.get(chunkId) ?? 0;
      const denom = freq + K1 * (1 - B + (B * dl) / avgdl);
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + (termIdf * freq * (K1 + 1)) / denom);
    }
  }

  // Note-type weighting is applied once, to the accumulated score, so it scales the chunk's
  // whole relevance rather than distorting per-term saturation.
  for (const [chunkId, score] of scores) {
    scores.set(chunkId, score * noteTypeWeight(index.chunks.get(chunkId)?.tipo));
  }

  // Filter before slicing: a restrictive filter applied after the cut would return
  // nothing whenever the top `limit` candidates all fail it.
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score]) => ({ chunk: index.chunks.get(chunkId)!, score, viaGraph: false }))
    .filter((sc) => (keep ? keep(sc.chunk) : true))
    .slice(0, limit);
}
```

- [ ] **Step 4:** No mesmo arquivo, exportar `suggestTerms(index: InvertedIndex, query: string, max: number): string[]`, que devolve até `max` termos do vocabulário a distância de Levenshtein ≤ 2 de algum termo da query, ordenados por distância crescente e depois alfabeticamente. Implementar Levenshtein com early-exit quando a distância mínima da linha corrente já passar de 2, para não varrer o vocabulário inteiro com custo quadrático cheio.

---

### Task 8: grafo de wiki-links

**Files:**
- Create: `src/graph/graph.ts`
- Test: `test/graph.test.ts`

**Depends:** T1, T2, T3, T6

- [ ] **Step 1:** Escrever `test/graph.test.ts` com testes falhando: `backlinks('02-wiki/nestjs/auth-guard.md')` inclui `02-wiki/patterns/cache-wrapper.md` e `03-projects/potentia/README.md`; `neighbors` de `auth-guard.md` une links de saída e backlinks sem duplicar; o wiki-link quebrado de `auth-guard.md` não aparece em lugar nenhum da adjacência; uma nota sem links tem `neighbors` vazio; o grafo é reconstruído corretamente após uma nota mudar seus links.

- [ ] **Step 2:** Implementar `src/graph/graph.ts` exportando a classe `LinkGraph`, construída a partir de `Note[]`. Estado: `outgoing: Map<string, Set<string>>` e `incoming: Map<string, Set<string>>`, ambos populados em `build(notes: Note[]): void` a partir de `note.links` — `brokenLinks` é deliberadamente ignorado. Métodos: `backlinks(path: string): string[]`, `outLinks(path: string): string[]`, `neighbors(path: string): string[]` (união dos dois, sem o próprio caminho). `build` limpa o estado anterior antes de repopular, então reconstrução total após um refresh é a operação normal — o grafo é barato o bastante para não justificar atualização incremental.

---

### Task 9: orquestração do retrieval

**Files:**
- Create: `src/retrieval/retrieval.ts`
- Create: `src/retrieval/budget.ts`
- Test: `test/retrieval.test.ts`
- Test: `test/golden-queries.test.ts`

**Depends:** T1, T2, T6, T7, T8

- [ ] **Step 1:** Criar `src/retrieval/budget.ts` com as constantes do spec e o cortador de orçamento:

```ts
export const BM25_TOP_K = 8;
/** Multiplies the SOURCE chunk's score, never the neighbour's own BM25 score. */
export const GRAPH_DAMPING = 0.4;
export const DEFAULT_LIMIT = 6;
export const DEFAULT_CHAR_BUDGET = 8000;

/** Cuts at whichever limit is reached first: chunk count or total characters. */
export function applyBudget(
  scored: ScoredChunk[],
  limit: number,
  charBudget: number,
): ScoredChunk[] {
  const out: ScoredChunk[] = [];
  let chars = 0;
  for (const item of scored) {
    if (out.length >= limit) break;
    if (out.length > 0 && chars + item.chunk.text.length > charBudget) break;
    out.push(item);
    chars += item.chunk.text.length;
  }
  return out;
}
```

  A guarda `out.length > 0` garante que um único chunk maior que o orçamento inteiro ainda seja retornado, em vez de a busca devolver vazio por tecnicismo.

- [ ] **Step 2:** Escrever `test/retrieval.test.ts` com testes falhando: a query `jwt` — que casa `auth-guard.md` e `nestjs-moc.md` **e nenhum termo de `cache-wrapper.md`**. Não usar `autenticacao jwt`: `cache-wrapper.md` contém "autenticação" no corpo, o que a torna acerto direto e destrói o teste. Essa query ainda assim traz chunk de `cache-wrapper.md` marcado `viaGraph: true`, com score exatamente `0.4 ×` o do chunk de origem — é o teste que prova que a expansão alcança vocabulário que o BM25 não alcança. **Passar `limit: 12` explicitamente**: os 4 vizinhos de `auth-guard.md` contribuem 15 chunks, todos empatados no score herdado, e com o `DEFAULT_LIMIT` de 6 o orçamento se esgota antes de alcançar `cache-wrapper.md`. Um segundo teste fixa o desempate de forma discriminante: constrói **dois índices com ordens de inserção de chunk diferentes** (um na ordem do scanner, outro invertida), roda a mesma query nos dois e exige saída idêntica. Rodar a mesma query duas vezes no mesmo índice é vácuo — dá igual mesmo sem desempate nenhum; expansão é de um salto só (uma nota a dois saltos do resultado direto nunca aparece); dedupe mantém o maior score quando um chunk chega pelas duas vias; `01-raw/inbox/rascunho.md` não aparece na busca por `rascunhoexclusivo` sem `include_raw`, e aparece com ele; filtro `tipo: 'projeto'` devolve só `03-projects/potentia/README.md` — inclusive os chunks que a expansão traria, já que o README linka `auth-guard` e `cache-wrapper`; filtro `folder: '02-wiki/docker'` restringe corretamente, inclusive contra `04-daily/2026-08-20.md`, que linka `[[multi-stage]]` e entraria pela expansão; query sem match devolve `results: []` e `suggestions` não-vazio contendo `bullmq` para a query `bulmq`.

- [ ] **Step 3:** Implementar `src/retrieval/retrieval.ts` exportando a classe `Retriever`, construída com `{ scanner: VaultScanner }`. Ela é dona do `InvertedIndex` e do `LinkGraph`. Método privado `sync()`: chama `scanner.refresh()`, remove do índice os chunks dos caminhos em `changed` e `removed`, re-chunka e re-adiciona os de `changed`, e reconstrói o `LinkGraph` se `changed` ou `removed` não estiverem vazios.

- [ ] **Step 4:** Implementar o método público `search(opts: { query: string; limit?: number; tipo?: string; folder?: string; includeRaw?: boolean }): SearchResult`. Ordem: `sync()`; roda `bm25.search(index, query, BM25_TOP_K, keep)`, onde `keep` traduz `tipo`/`folder`/`includeRaw` num predicado sobre o chunk — a filtragem acontece dentro de `search`, antes do corte em `BM25_TOP_K`, senão um filtro restritivo devolve vazio porque os 8 primeiros foram todos descartados; coleta as notas de origem; para cada nota vizinha no grafo, atribui a **todos** os seus chunks o score `GRAPH_DAMPING × score do chunk de origem que a alcançou` (o maior, se mais de um a alcançar), marcando `viaGraph: true`; merge por `chunk.id` mantendo o maior score; **reaplica `keep` sobre o conjunto mergeado**; reordena por score decrescente e, **em empate, por `chunk.id` ascendente**.

  A refiltragem depois do merge não é redundante com a de dentro do `search`: a expansão adiciona vizinhos que nunca passaram por `keep`, então sem ela `{ query: 'potentia', tipo: 'projeto' }` devolve chunks de `auth-guard.md` e `cache-wrapper.md`, alcançados pelos links do README. Um filtro que o usuário pediu tem de valer sobre o que é devolvido, não sobre um estágio intermediário. O desempate explícito não é cosmético: a expansão atribui o mesmo score herdado a todos os chunks de todos os vizinhos, então empate é o caso comum e não a exceção, e sem ele o corte do orçamento devolveria conjuntos diferentes conforme a ordem de inserção no `Map`; aplica `applyBudget(scored, limit ?? DEFAULT_LIMIT, DEFAULT_CHAR_BUDGET)`. Se o resultado final for vazio, popula `suggestions` com `suggestTerms(index, query, 5)`.

- [ ] **Step 5:** Escrever `test/golden-queries.test.ts` com uma tabela de 10 pares `{ query, expectedTopPath }` cobrindo a fixture, cada um asserindo que `search({ query }).results[0].chunk.path === expectedTopPath`. Queries a incluir, com o alvo entre parênteses: `worker de fila` (bullmq-worker), `bullmq` (bullmq-worker), `autenticacao jwt` (auth-guard), `guard de autenticação` (auth-guard), `build multi-stage` (multi-stage), `cache de camadas docker` (multi-stage), `wrapper de cache redis` (cache-wrapper), `redis` (cache-wrapper), `potentia` (potentia/README), `projeto multi-tenant restaurantes` (potentia/README). Este arquivo é a rede de regressão do scoring: mexer em peso de campo, amortecimento ou `k1`/`b` sem rodá-lo é como mexer às cegas.

---

### Task 10: guarda-corpos de caminho

**Files:**
- Create: `src/write/paths.ts`
- Test: `test/paths.test.ts`

**Depends:** T1

- [ ] **Step 1:** Escrever `test/paths.test.ts` com testes falhando: `02-wiki/nestjs/nova.md` é aceito; `../fora.md` é rejeitado; **`/etc/passwd.md` é rejeitado por ser absoluto** — o caminho de teste precisa terminar em `.md`, senão ele morre na checagem de sufixo e a rejeição de caminho absoluto nunca é exercitada; `02-wiki/*.md` e `02-wiki/nota[1].md` são rejeitados por conterem metacaractere de glob; `02-wiki/../../fora.md` é rejeitado; `99-archive/x.md` é rejeitado com mensagem citando a pasta; `_templates/x.md` é rejeitado; um caminho que não termina em `.md` é rejeitado; o retorno em caso de sucesso é o caminho absoluto normalizado dentro do vault.

- [ ] **Step 2:** Implementar `src/write/paths.ts`:

```ts
import { resolve, relative, sep } from 'node:path';

export const DENIED_PREFIXES = ['99-archive', '_templates'] as const;

export class PathGuardError extends Error {}

/**
 * Resolves a vault-relative path to an absolute one, refusing anything that escapes
 * the vault or lands in a read-only area. Returns the absolute path.
 */
export function resolveWritePath(vaultRoot: string, relPath: string): string {
  if (!relPath.endsWith('.md')) {
    throw new PathGuardError(`caminho deve terminar em .md: ${relPath}`);
  }
  // git interpreta pathspec como glob. `*.md` passa em qualquer checagem de contenção e de
  // sufixo, mas chega ao `git add` como curinga e arrasta arquivos que a tool nunca tocou.
  if (/[*?\[\]]/.test(relPath)) {
    throw new PathGuardError(`caminho não pode conter metacaractere de glob: ${relPath}`);
  }
  const root = resolve(vaultRoot);
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== abs) {
    throw new PathGuardError(`caminho fora do vault: ${relPath}`);
  }
  const head = rel.split(sep)[0];
  if (head !== undefined && (DENIED_PREFIXES as readonly string[]).includes(head)) {
    throw new PathGuardError(`escrita negada em ${head}/ (somente leitura)`);
  }
  return abs;
}
```

- [ ] **Step 3:** No mesmo arquivo, exportar `assertNoSymlinkEscape(vaultRoot: string, abs: string): Promise<void>`, que sobe de `abs` até a raiz do vault chamando `fs.promises.realpath` no diretório existente mais próximo e confirma que o caminho real continua dentro de `realpath(vaultRoot)`. `resolveWritePath` é puramente sintático; esta função cobre o caso do symlink apontando para fora, e é chamada por `write/writer.ts` antes de qualquer gravação.

---

### Task 11: aplicação de templates com substituição de tokens Templater

**Files:**
- Create: `src/write/template.ts`
- Test: `test/template.test.ts`

**Depends:** T1, T2

- [ ] **Step 1:** Escrever `test/template.test.ts` com testes falhando: aplicar `_templates/wiki.md` com título `Cache Wrapper` e data `2026-08-24` produz um arquivo sem nenhuma ocorrência de `<%`; `<% tp.file.title %>` vira `Cache Wrapper`; `<% tp.date.now("YYYY-MM-DD") %>` vira `2026-08-24`; `<% tp.date.now("DD/MM/YYYY") %>` vira `24/08/2026`; espaçamento variável dentro dos delimitadores (`<%tp.file.title%>`) também é substituído; **e um teste com `now` às 22:30 de 2026-08-24 em `America/Sao_Paulo` produz `2026-08-24 22:30`, não `2026-08-25 01:30`** — é a única asserção que detecta alguém trocando os getters locais por UTC neste módulo, e sem ela o erro só apareceria como captura gravada na nota diária errada; um token Templater desconhecido lança erro em vez de ser gravado literalmente.

- [ ] **Step 2:** Implementar `src/write/template.ts` exportando `applyTemplate(templateText: string, ctx: { title: string; now: Date }): string`. A função substitui via `/<%\s*(.+?)\s*%>/g`, despachando por expressão: `tp.file.title` devolve `ctx.title`; `tp.date.now("FMT")` formata `ctx.now` com **getters locais** (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`), suportando os tokens `YYYY`, `MM`, `DD`, `HH`, `mm`; qualquer outra expressão lança `TemplateError` citando a expressão encontrada. Falhar alto é intencional — token não substituído gravado no vault é exatamente o bug que este módulo existe para impedir.

  **Local, deliberadamente, e é o oposto do que `vault/frontmatter.ts` faz.** `ctx.now` é um instante real de relógio de parede, não uma data sintética de YAML: formatá-lo em UTC faria um `vault_learn` às 22h de Brasília gravar a captura na nota diária do **dia seguinte**, carregando um `HH:MM` de 22:00 dentro dela. As duas conversões de data do sistema são assimétricas pela natureza da entrada — YAML é UTC por construção, `now` é local por significado — e cada uma vive no seu módulo com um comentário dizendo por quê. Exportar também `formatLocal(d: Date, fmt: string): string`, para que `write/propagate.ts` e `write/learn.ts` usem esta implementação em vez de reescrevê-la.

- [ ] **Step 3:** No mesmo arquivo, exportar `ensureFrontmatter(content: string, required: Frontmatter): string`, que garante que o conteúdo comece com um bloco `---` contendo ao menos `tipo`, `tags` e `criado`. Se já houver frontmatter, faz merge preservando as chaves existentes e preenchendo só as ausentes; se não houver, prefixa um bloco novo. `tags` é serializado em fluxo (`tags: [nestjs, auth]`) para bater com o estilo já usado no vault.

---

### Task 12: wrapper de git

**Files:**
- Create: `src/write/git.ts`
- Test: `test/git.test.ts`

**Depends:** T1

- [ ] **Step 1:** Escrever `test/git.test.ts` com testes falhando, operando sobre um repositório git temporário criado em `os.tmpdir()` e removido no teardown: `commitFiles` com um arquivo adiciona e commita, e `git log` mostra a mensagem; `commitFiles` com três arquivos produz **um** commit contendo os três; commitar num diretório que não é repositório git devolve `{ committed: false, warning }` sem lançar; commitar arquivos sem alteração real devolve `{ committed: false }` com aviso de "nada a commitar", não erro; a mensagem passada é usada literalmente.

- [ ] **Step 2:** Implementar `src/write/git.ts` exportando `commitFiles(repoRoot: string, absPaths: string[], message: string): Promise<{ committed: boolean; warning?: string }>`. Usa `execFile` de `node:child_process` promisificado, nunca `exec` com string montada — os caminhos vêm de entrada de tool e não podem passar por shell. **Lista vazia é no-op**: com `absPaths` vazio a função devolve `{ committed: false, warning }` sem invocar git. Sem essa guarda, `git commit -m <msg> --` sem pathspec commita **todo o índice** — verificado — e varreria trabalho não relacionado do usuário para dentro de um commit com a mensagem da tool.

  Sequência: `git -C <repoRoot> --literal-pathspecs add -- <absPaths...>`, depois `git -C <repoRoot> --literal-pathspecs commit -m <message> -- <absPaths...>`. `--literal-pathspecs` porque `--` interrompe opções mas **não** desliga glob: um caminho contendo `*` chegaria ao git como curinga. É defesa em profundidade junto com a rejeição de glob na Task 10. Um commit por operação de tool, cobrindo todos os arquivos que ela tocou. Qualquer falha é capturada e devolvida como `warning`; a função nunca lança. Isto implementa a regra do spec de que os arquivos já foram gravados e uma falha de git não pode desfazer nem mascarar a escrita.

---

### Task 13: escrita de notas

**Files:**
- Create: `src/write/writer.ts`
- Create: `src/write/atomic.ts`
- Create: `src/write/diff.ts`
- Test: `test/writer.test.ts`

**Depends:** T1, T2, T10, T11, T12

- [ ] **Step 1:** Escrever `test/writer.test.ts` com testes falhando, contra uma cópia da fixture num repositório git temporário: `writeNote` cria a nota, o arquivo em disco não contém `<%`, e há um commit novo; `writeNote` com `tipo: 'projeto'` aplica `_templates/projeto.md`; escrever em `99-archive/x.md` lança `PathGuardError` e não cria arquivo; escrever em `../fora.md` idem; `editNote` substitui o trecho e commita; `editNote` com `deferCommit` grava sem commitar; `editNote` com `old_text` ausente lança e não altera o arquivo; `editNote` com `old_text` ocorrendo duas vezes lança citando ambiguidade e não altera o arquivo; se o git falhar, o arquivo permanece gravado e a resposta traz `warning`.

- [ ] **Step 2:** Implementar `src/write/writer.ts` exportando `writeNote(opts: { vaultRoot: string; path: string; content: string; frontmatter?: Frontmatter; tipo?: string; deferCommit?: boolean }): Promise<WriteResult>`. Fluxo: `resolveWritePath` → `assertNoSymlinkEscape` → se `tipo` for `wiki` ou `projeto` e o arquivo não existir, lê o template correspondente de `_templates/` e aplica `applyTemplate` como esqueleto, inserindo `content` na seção de corpo → `ensureFrontmatter` → gravação atômica → `commitFiles([absPath])`, **salvo** se `deferCommit` for `true`, caso em que a gravação acontece e o commit não.

```ts
export interface WriteResult {
  path: string;
  absPath: string;
  created: boolean;
  committed: boolean;
  warning?: string;
  diff: string;
}
```

  `deferCommit` existe para `vault_learn`: ela toca até quatro arquivos e precisa de **um** commit cobrindo o conjunto, não quatro commits parciais. `absPath` é devolvido para que o chamador possa montar essa lista.

- [ ] **Step 3:** Implementar `src/write/atomic.ts` exportando `atomicWrite(absPath: string, text: string): Promise<void>`: cria o diretório pai se faltar, grava em `${absPath}.${process.pid}.tmp` no mesmo diretório, faz `fsync` no handle, fecha e faz `rename`. Rename no mesmo filesystem é atômico, então o Obsidian nunca observa meio-arquivo. Fica em módulo próprio porque `write/propagate.ts` também grava, e nenhum dos dois deve reimplementar isto.

- [ ] **Step 4:** Implementar `editNote(opts: { vaultRoot: string; path: string; oldText: string; newText: string; deferCommit?: boolean }): Promise<WriteResult>`. Lê o arquivo, conta ocorrências de `oldText`; zero lança `EditError` com a mensagem `trecho não encontrado em <path>`; duas ou mais lança `EditError` com `trecho ambíguo em <path>: N ocorrências`; exatamente uma substitui, grava atomicamente e commita. Nenhuma escrita ocorre nos casos de erro.

- [ ] **Step 5:** Implementar `src/write/diff.ts` exportando `unifiedDiff(before: string, after: string, path: string): string`, produzindo um diff unificado simples com 3 linhas de contexto, sem dependência externa. É o valor do campo `diff` de `WriteResult`, e é o que torna visível ao agente e ao usuário o que a escrita realmente fez. Módulo próprio pelo mesmo motivo que `atomic.ts`: `propagate.ts` também precisa dele.

---

### Task 14: propagação automática — MOC, índice de conhecimento e nota diária

**Files:**
- Create: `src/write/propagate.ts`
- Test: `test/propagate.test.ts`

**Depends:** T1, T2, T11, T13

**Model:** capable

- [ ] **Step 1:** Escrever `test/propagate.test.ts` com testes falhando, contra cópia da fixture: criar nota nova em `nestjs` insere `- [[nova-nota]] — {resumo}` ao final de `## Notas` do `nestjs-moc.md` sem tocar nas entradas existentes, e move `atualizado:` para a data corrente; anexar a nota existente **não** insere linha no MOC mas ainda move `atualizado:`; criar nota em `patterns` (domínio sem MOC na fixture) **cria** `02-wiki/patterns/patterns-moc.md` no formato correto; domínio novo acrescenta linha em `00-index/index-knowledge.md` sob `## Domínios`; domínio já listado não altera o índice em byte nenhum; a captura diária acrescenta `- HH:MM [[slug]] (tipo, projeto)` sob `## Capturas` preservando a linha pré-existente de `2026-08-20.md`; sem nota do dia, o arquivo é criado com `tipo: daily` e `## Capturas`; sem `projeto`, o sufixo traz só o tipo (`(gotcha)`); `classifyTipo` mapeia as tags conforme a tabela; falha ao gravar um alvo devolve `warning` nomeando-o e não impede os demais.

- [ ] **Step 2:** Implementar em `src/write/propagate.ts` as duas funções puras que carregam as decisões, testáveis sem tocar em disco:

```ts
/** Maps frontmatter tags to the daily-capture kind, defaulting to a generic learning. */
export function classifyTipo(tags: string[]): string {
  const folded = tags.map((t) => t.toLowerCase());
  if (folded.some((t) => t === 'gotcha')) return 'gotcha';
  if (folded.some((t) => t === 'pattern' || t === 'padrao' || t === 'padrão')) return 'pattern';
  if (folded.some((t) => t === 'decisao' || t === 'decisão' || t === 'adr')) return 'decisão';
  if (folded.some((t) => t === 'estado' || t === 'status')) return 'estado';
  return 'aprendizado';
}

/**
 * Rewrites the `atualizado:` frontmatter field, inserting it after `criado:` when absent.
 * Returns the content unchanged when there is no frontmatter block to write into.
 */
export function bumpAtualizado(content: string, date: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const head = content.slice(0, end);
  const rest = content.slice(end);
  if (/^atualizado:/m.test(head)) {
    return head.replace(/^atualizado:.*$/m, `atualizado: ${date}`) + rest;
  }
  if (/^criado:.*$/m.test(head)) {
    return head.replace(/^(criado:.*)$/m, `$1\natualizado: ${date}`) + rest;
  }
  return `${head}\natualizado: ${date}${rest}`;
}
```

- [ ] **Step 3:** Implementar `insertUnderSection(content: string, heading: string, line: string): string`, também pura. Localiza a linha de heading exata (`## Notas`, `## Domínios`, `## Capturas`), avança até o último item de lista contíguo daquela seção e insere `line` logo após ele; se a seção existir mas estiver vazia, insere como primeiro item; se a seção não existir, acrescenta a seção ao final do arquivo com o item dentro. Nunca insere duas vezes: se `line` já estiver presente literalmente na seção, devolve o conteúdo inalterado. Essa idempotência é o que impede o MOC de acumular entradas repetidas quando a mesma nota for aprendida duas vezes.

- [ ] **Step 4:** Implementar `buildMoc(dominio: string, date: string): string`, que devolve um MOC novo no formato dos existentes:

```markdown
---
tipo: moc
tags: [{dominio}]
criado: {date}
atualizado: {date}
---

# {Dominio} — Mapa de Conteúdo

## Notas

## Relacionados

- [[../../00-index/index-knowledge|índice de conhecimento]]
```

  `{Dominio}` é o domínio com a inicial maiúscula. A seção `## Notas` nasce vazia e `insertUnderSection` a preenche no mesmo fluxo.

- [ ] **Step 5:** Implementar `buildDaily(date: string): string`, devolvendo frontmatter `tipo: daily` e `criado: {date}`, título `# {date}` e a seção `## Capturas` vazia — o formato de `04-daily/2026-04-20.md`, não o de `2026-04-17.md`, que é anterior à convenção.

- [ ] **Step 6:** Implementar a função de I/O `propagate(opts): Promise<PropagateResult>`, que amarra as anteriores:

```ts
export interface PropagateOptions {
  vaultRoot: string;
  dominio: string;
  slug: string;
  resumo: string;
  tags: string[];
  projeto?: string;
  /** true when a new note was created, false when an insight was appended to an existing one. */
  created: boolean;
  /** true when `02-wiki/<dominio>/` did not exist before this operation. */
  domainIsNew: boolean;
  now: Date;
}

export interface PropagateResult {
  /** Absolute paths actually written, for the caller's single batched commit. */
  written: string[];
  diffs: string[];
  warnings: string[];
}
```

  Ordem: MOC do domínio → índice de conhecimento (só se `domainIsNew`) → nota diária. Cada alvo é lido, transformado pelas funções puras, e gravado com `atomicWrite` **apenas se o conteúdo mudou**; o diff vem de `unifiedDiff`. Cada alvo é envolvido no seu próprio try/catch: uma falha entra em `warnings` nomeando o alvo e a execução segue para o próximo. `propagate` nunca lança e nunca commita — commitar é responsabilidade de quem chama, que precisa de um commit único cobrindo nota e propagação.

- [ ] **Step 7:** A linha de captura diária é montada como `- ${HH}:${mm} [[${slug}]] (${tipo}${projeto ? `, ${projeto}` : ''})`, com data e `HH:mm` extraídos de `opts.now` via `formatLocal` de `write/template.ts` — horário local, nunca UTC, pelo motivo documentado lá. `tipo` vem de `classifyTipo(tags)`. A linha do MOC é `- [[${slug}]] — ${resumo}`, e só é montada quando `created` é `true`.

---

### Task 15: `vault_learn` — regra de duplicata, propagação e roteamento

**Files:**
- Create: `src/write/learn.ts`
- Test: `test/learn.test.ts`

**Depends:** T1, T2, T9, T13, T14

**Model:** capable

- [ ] **Step 1:** Escrever `test/learn.test.ts` com testes falhando, contra cópia da fixture em repositório git temporário: um insight fortemente sobreposto a `bullmq-worker.md`, com `tags: ['bullmq']`, anexa uma seção `## <data> — <titulo>` naquela nota e devolve `action: 'appended'`; um insight sobre assunto ausente do vault cria nota nova em `02-wiki/<dominio>/` e devolve `action: 'created'`; um insight com bom match de score mas **sem** overlap de tag nem de domínio cria nota nova, provando que a regra é conjuntiva; **um caso em que a razão fica abaixo de 1.8 e o overlap existe** cria nota nova, provando que a razão é discriminante — sem ele o `DUPLICATE_SCORE_RATIO` pode ser trocado por qualquer valor ≤ 2.5 e a suíte continua verde, porque a expansão do grafo fixa a razão em exatamente 2.50 nos cenários óbvios. Escolher a query pela margem medida, não pelo que parece plausível. Alvo medido nesta fixture: insight `Wrapper de cache redis wrapper de cache com TTL configuravel` com `tags: ['redis','cache']` e `dominio: 'patterns'` dá topo `cache-wrapper.md` contra `03-projects/potentia/README.md` — acerto direto, não amortecido pelo grafo — com razão **1.618**, abaixo do limiar, e com overlap de tag presente. Junto com o caso do bullmq, que dá 2.500, o par prende a constante no intervalo **aberto** (1.618, 2.500). Aberto no topo de propósito: o segundo colocado do caso bullmq chega pelo grafo, a `0.4 ×` o topo, e `x / (0.4 × x)` em IEEE754 dá `2.4999999999999996`, não `2.5`. Como `decideDuplicate` testa `ratio < DUPLICATE_SCORE_RATIO`, fixar a constante em exatamente `2.5` classificaria o caso bullmq como `created` em vez de `appended`. O valor real, `1.8`, está folgadamente dentro; a nota existe para quem for retunar depois; `dominio: 'rust'` (inexistente em `02-wiki/`) sem `confirm_novo_dominio` lança erro listando os domínios válidos, e com a flag cria o diretório; ambos os caminhos retornam `diff` não-vazio.

  Testes de propagação e commit, que são o que o uso diário exercita: uma criação em `nestjs` produz **um único commit** contendo a nota, `nestjs-moc.md` e o daily do dia — `git show --name-only` lista os três e `git log --oneline` cresce em exatamente uma linha; uma criação em `rust` com `confirm_novo_dominio` produz um commit com quatro arquivos, incluindo `00-index/index-knowledge.md`; uma anexação produz commit com a nota, o MOC (só `atualizado:`) e o daily; a mesma chamada repetida duas vezes não duplica a linha no MOC nem no daily; se o git falhar, todos os arquivos permanecem gravados em disco e a resposta traz `warning`; se a propagação do daily falhar, a nota e o MOC ainda são commitados e `warning` nomeia o daily.

- [ ] **Step 2:** Implementar `src/write/learn.ts` com a regra de duplicata do spec, isolada em função pura e testável:

```ts
export const DUPLICATE_SCORE_RATIO = 1.8;

export interface DuplicateDecision {
  isDuplicate: boolean;
  targetPath?: string;
  reason: string;
}

/**
 * Conjunctive rule: the top hit must both stand out from the runner-up in another
 * note, and share a tag or the domain. Raw BM25 scores are not comparable across
 * queries, so the score test is relative, never absolute.
 */
export function decideDuplicate(
  results: ScoredChunk[],
  tags: string[],
  dominio: string,
  noteTags: (path: string) => string[],
): DuplicateDecision {
  const top = results[0];
  if (!top) return { isDuplicate: false, reason: 'nenhum match' };

  const runnerUp = results.find((r) => r.chunk.path !== top.chunk.path);
  const ratio = runnerUp ? top.score / runnerUp.score : Infinity;
  if (ratio < DUPLICATE_SCORE_RATIO) {
    return { isDuplicate: false, reason: `topo não se destaca (razão ${ratio.toFixed(2)})` };
  }

  const shared = noteTags(top.chunk.path).some((t) => tags.includes(t));
  const sameDomain = top.chunk.path.startsWith(`02-wiki/${dominio}/`);
  if (!shared && !sameDomain) {
    return { isDuplicate: false, reason: 'sem overlap de tag nem de domínio' };
  }

  return { isDuplicate: true, targetPath: top.chunk.path, reason: `duplicata de ${top.chunk.path}` };
}
```

- [ ] **Step 3:** Implementar `learn(opts: LearnOptions): Promise<LearnResult>` com a assinatura:

```ts
export interface LearnOptions {
  vaultRoot: string;
  retriever: Retriever;
  titulo: string;
  insight: string;
  contexto: string;
  dominio: string;
  projeto?: string;
  tags?: string[];
  links?: string[];
  confirmNovoDominio?: boolean;
  now: Date;
}

export interface LearnResult {
  action: 'appended' | 'created';
  path: string;
  reason: string;
  /** Concatenated diff of every file touched: the note plus each propagation target. */
  diff: string;
  /** Vault-relative paths of the propagation targets actually written. */
  propagated: string[];
  committed: boolean;
  warning?: string;
}
```

  Fluxo: valida `dominio` contra os diretórios existentes em `02-wiki/` (rejeitando com a lista de válidos quando não existe e `confirmNovoDominio` não foi passado, e registrando `domainIsNew` quando passou); roda `retriever.search({ query: `${titulo} ${insight}` })`; chama `decideDuplicate`; se duplicata, monta a seção `## ${YYYY-MM-DD} — ${titulo}` com `insight` e `contexto` e usa `editNote` com `deferCommit: true` para anexá-la ao fim da nota alvo; se não, monta o corpo e chama `writeNote` com `deferCommit: true` em `02-wiki/${dominio}/${slug(titulo)}.md` com `tipo: 'wiki'`.

- [ ] **Step 4:** Após a escrita da nota, chamar `propagate` com `created` refletindo a ação tomada, `resumo` derivado da primeira frase de `insight` truncada em 120 caracteres — **truncando por ponto de código, nunca por unidade UTF-16**. Cortar em índice fixo no meio de um par surrogate (emoji, que aparece em conteúdo clipado) deixa um surrogate desemparelhado, e o js-yaml recusa o documento inteiro com "the stream contains non-printable characters": a nota perde todo o frontmatter, e a passada seguinte do `ensureFrontmatter` prefixa um segundo bloco em vez de corrigir. Usar `Array.from(texto).slice(0, 120).join('')` ou equivalente, e `domainIsNew` da validação do Step 3. Concatenar `written` da propagação com o `absPath` da nota e passar a lista inteira a `commitFiles`, produzindo **um** commit com mensagem `docs(vault): {titulo}`. Concatenar os diffs na mesma ordem para o campo `diff`, e juntar os `warnings` da propagação com o eventual `warning` do git numa única string.

  A ordem é deliberada: gravar tudo primeiro, commitar uma vez ao final. Commitar por arquivo produziria histórico ilegível e, pior, deixaria o vault num estado commitado onde a nota existe e o MOC não a lista.

- [ ] **Step 5:** Implementar `slug(titulo: string): string` no mesmo arquivo: dobra acentos, minúscula, troca não-alfanuméricos por hífen, colapsa hífens repetidos e apara as bordas. Bate com a convenção de nomes de arquivo do vault (`auth-service-singleton.md`).

- [ ] **Step 6:** Renderizar os `links?` como wiki-links `[[nome]]` numa seção `## Links` ao final do corpo, tanto no caminho de criação quanto no de anexação. É o que mantém o grafo denso conforme o vault cresce — nota nova sem link não é alcançável por expansão.

---

### Task 16: servidor MCP e definição das tools

**Files:**
- Create: `src/server/tools.ts`
- Create: `src/server/index.ts`
- Test: `test/tools.test.ts`

**Depends:** T1, T9, T13, T15

**Model:** capable

- [ ] **Step 1:** Escrever `test/tools.test.ts` com testes falhando, chamando os handlers diretamente sem subir transporte: schema de `vault_search` rejeita `query` vazia; `vault_search` devolve texto contendo `caminho:linha` para cada resultado; `vault_get_note` de caminho inexistente devolve erro de tool legível, não exceção não tratada; `vault_get_note` de `auth-guard.md` lista o link quebrado; `vault_list` com `tipo: 'projeto'` devolve só `03-projects/potentia/README.md` — `_templates/projeto.md` também declara `tipo: projeto`, e é a exclusão de `_templates/` no scanner (Task 6) que o mantém fora; `vault_backlinks` de `auth-guard.md` traz **quatro** notas — `bullmq-worker.md`, `nestjs-moc.md`, `cache-wrapper.md` e `potentia/README.md`. A entrada do MOC é um backlink como qualquer outro, e `bullmq-worker.md` entra porque a Task 2 manda ele linkar `[[auth-guard]]` duas vezes: dedupe colapsa as duas ocorrências em **um** link, não em nenhum; `vault_learn` com `dominio` inválido devolve erro citando os domínios válidos; busca sem resultado devolve texto de "sem match" com as sugestões.

- [ ] **Step 2:** Implementar `src/server/tools.ts` exportando `createTools(deps: { retriever: Retriever; scanner: VaultScanner; vaultRoot: string })`, devolvendo um array de definições `{ name, description, inputSchema, handler }`. Todo `inputSchema` é um schema zod. As sete tools, com as entradas exatas do spec:

```ts
vault_search:      { query: string; limit?: number; tipo?: string; folder?: string; include_raw?: boolean }
vault_get_note:    { path: string }
vault_list:        { tipo?: string; tags?: string[]; status?: string; folder?: string }
vault_backlinks:   { path: string }
vault_write_note:  { path: string; content: string; frontmatter?: Record<string, unknown> }
vault_edit_note:   { path: string; old_text: string; new_text: string }
vault_learn:       { titulo: string; insight: string; contexto: string; dominio: string;
                     projeto?: string; tags?: string[]; links?: string[];
                     confirm_novo_dominio?: boolean }
```

  As `description` são escritas para o agente decidir sozinho quando chamar. A de `vault_learn` diz explicitamente: usar quando aprender algo não óbvio e reutilizável durante a sessão — uma decisão de arquitetura, um pattern, um gotcha —, que o servidor decide sozinho entre anexar a nota existente e criar nova, que ele **propaga sozinho** para o MOC do domínio, o índice de conhecimento e a nota diária, e que o diff retornado deve ser mostrado ao usuário. `projeto` é descrito como o nome do projeto em `03-projects/` a que o aprendizado pertence, usado na linha de captura diária.

- [ ] **Step 3:** Formatar a saída de `vault_search` como texto: por resultado, uma linha `caminho:lineStart — headingPath.join(' > ') (score X.XX, via grafo)` seguida do trecho. Citar o caminho é regra do `CLAUDE.md` do vault, então a formatação carrega essa obrigação em vez de deixá-la para o agente lembrar.

- [ ] **Step 4:** Implementar `src/server/index.ts` como entrypoint: lê `process.env.VAULT_PATH`, e se estiver ausente ou não for diretório escreve mensagem em `stderr` e sai com código 1 — é o único erro fatal do sistema. Instancia `VaultScanner` e `Retriever`, registra as tools num `Server` do `@modelcontextprotocol/sdk`, conecta um `StdioServerTransport`. Todo handler é envolvido num try/catch que converte exceção em conteúdo de erro de tool, para que uma nota malformada nunca derrube o processo.

- [ ] **Step 5:** Adicionar `#!/usr/bin/env node` como primeira linha de `src/server/index.ts` e garantir que `tsc` a preserve, já que `package.json` aponta `bin` para o arquivo compilado.

---

### Task 17: README e registro no Claude Code

**Files:**
- Create: `README.md`

**Depends:** T16

**Model:** cheap

- [ ] **Step 1:** Escrever `README.md` em português cobrindo: o que o projeto faz em um parágrafo, o `VAULT_PATH` obrigatório, e os comandos `npm install`, `npm run build`, `npm test`.

- [ ] **Step 2:** Documentar o registro no Claude Code com o comando exato e o bloco de configuração equivalente:

```
claude mcp add vault --env VAULT_PATH="$HOME/Work/Knowledge Vault" -- node /caminho/absoluto/do/vault-mcp/dist/server/index.js
```

- [ ] **Step 3:** Documentar as sete tools numa tabela com nome, entrada e quando o agente deve chamá-las, e incluir uma seção "Como o `vault_learn` decide" explicando a regra conjuntiva (razão de 1.8× sobre o segundo colocado de outra nota, mais overlap de tag ou domínio) e o viés deliberado a favor de criar nota nova.

- [ ] **Step 4:** Incluir uma seção "O que o `vault_learn` escreve" listando os até quatro arquivos de uma chamada — a nota, `02-wiki/{dominio}/{dominio}-moc.md`, `00-index/index-knowledge.md` (só em domínio novo) e `04-daily/{hoje}.md` — deixando explícito que tudo entra num único commit `docs(vault): {titulo}`, e que reverter um aprendizado inteiro é `git revert` desse commit.

- [ ] **Step 5:** Incluir uma seção "Ajustando o ranking" apontando que `test/golden-queries.test.ts` é a rede de regressão e que qualquer mudança em `FIELD_WEIGHTS`, `NOTE_TYPE_WEIGHTS`, `GRAPH_DAMPING`, `K1`, `B` ou `DUPLICATE_SCORE_RATIO` precisa ser validada por ela. Documentar por que `NOTE_TYPE_WEIGHTS` existe: MOC e daily repetem a query em chunks curtos e, sem o fator, o ponteiro supera a nota apontada.

### Task 18: citação de linha real nos resultados de busca

**Files:**
- Modify: `src/types.ts`
- Modify: `src/vault/scanner.ts`
- Modify: `src/retrieval/retrieval.ts`
- Modify: `test/scanner.test.ts`
- Modify: `test/retrieval.test.ts`

**Depends:** T6, T9

**Model:** capable

`chunkNote` já recebe `bodyStartLine` e documenta o contrato: `lineStart`/`lineEnd` devem apontar para o arquivo original, não para o início de `body`. `test/chunker.test.ts` calcula o valor certo (`closeIndex + 2`) e prova o contrato reslicando o texto do chunk a partir do arquivo bruto. Mas `Note` não carrega esse deslocamento e o `VaultScanner` não expõe o arquivo cru, então o único chamador de produção passa a constante `BODY_START_LINE = 1`. Medido na fixture: 11 das 13 notas indexadas saem com `lineStart` de 4 a 7 linhas adiantado — só as duas sem frontmatter acertam. A Task 16 imprime `caminho:lineStart`, então praticamente todo resultado entrega ao usuário uma citação que aponta para a linha errada.

- [ ] **Step 1:** Adicionar a `Note` (`src/types.ts`) o campo `bodyStartLine: number`, documentado como a linha 1-based do arquivo original onde `body` começa — 1 para uma nota sem frontmatter.

- [ ] **Step 2:** Preencher o campo em `src/vault/scanner.ts`, onde o arquivo cru já está em mãos no momento do parse. Uma nota sem bloco de frontmatter tem `bodyStartLine` 1. Uma nota com frontmatter tem a linha seguinte ao fechamento `---`, contada no arquivo original, com CRLF tratado igual a LF.

- [ ] **Step 3:** Em `src/retrieval/retrieval.ts`, remover a constante `BODY_START_LINE` e passar `note.bodyStartLine` para `chunkNote`.

- [ ] **Step 4:** Cobrir com teste. Em `test/scanner.test.ts`, fixar `bodyStartLine` para: nota sem frontmatter, nota com frontmatter, nota com frontmatter CRLF, e nota cujo corpo abre com linha em branco. Em `test/retrieval.test.ts`, provar o contrato do jeito que `chunker.test.ts` já prova: pegar um resultado de busca, abrir o arquivo bruto da fixture, e afirmar que a linha `lineStart` contém de fato o início do texto do chunk. Um teste que só compare ids entre si não vale — ids deslocam uniformemente e o defeito passa.

- [ ] **Step 5:** Verificar por mutação que a cobertura discrimina: trocar `note.bodyStartLine` de volta pela constante `1` tem que quebrar o teste do Step 4.

### Task 19: guard de caminho compartilhado e correções da propagação

**Files:**
- Modify: `src/write/paths.ts`
- Modify: `src/write/writer.ts`
- Modify: `src/write/propagate.ts`
- Modify: `src/write/learn.ts`
- Modify: `test/paths.test.ts`
- Modify: `test/writer.test.ts`
- Modify: `test/propagate.test.ts`
- Modify: `test/learn.test.ts`

**Depends:** T13, T14, T15

**Model:** capable

A fase 4 fechou uma escrita dentro de `.git/` acrescentando a `propagate.ts` uma cópia local de `DENIED_SEGMENTS`, `normalizeSegment` e `pathSegments`, porque `paths.ts` e `writer.ts` estavam fora do conjunto de arquivos daquela task. A revisão confirmou que as duas cópias são equivalentes hoje — o risco é divergirem amanhã, e é a fronteira de segurança do projeto. Esta task consolida e fecha os defeitos restantes da propagação.

- [ ] **Step 1:** Mover `DENIED_SEGMENTS`, `normalizeSegment` e `pathSegments` para `src/write/paths.ts`, ao lado de `DENIED_PREFIXES`, e exportar um único `guardedPath`. Apagar **as duas** cópias, a de `writer.ts` (linhas 78, 139, 161, 209) e a de `propagate.ts` (linhas 395, 407, 422, 465), e fazer ambas chamarem a compartilhada. A mesma classe de caracteres hoje tem dois nomes — `CONTROL_CHARS` em `writer.ts:121` e `INVISIBLE_CHARS` em `propagate.ts:94`, com o literal idêntico caractere a caractere; unificar em um só nome exportado. O docblock em `propagate.ts:385-392` já registra essa dívida e prescreve exatamente este movimento: apagá-lo junto. Nenhum comportamento pode afrouxar: os testes de escape existentes continuam passando sem edição.

- [ ] **Step 2:** Fechar as lacunas de regressão do guard, hoje ancoradas só em `.git` minúsculo. Cobrir cada entrada de `DENIED_SEGMENTS` (`.git`, `.obsidian`, `node_modules`, `_templates`) e cada variante que `normalizeSegment` existe para pegar (`.GIT`, `.Git`, `.git.`, `.git ` com espaço final), inclusive pela via do symlink. Hoje remover `.obsidian` do conjunto, ou remover o `.toLowerCase()`, deixa a suíte inteira verde.

- [ ] **Step 3:** Cobrir as quatro cláusulas de `dominioProblem` que hoje podem ser deletadas uma a uma com a suíte verde: domínio vazio, acima de 64 caracteres, começando com ponto, e com metacaractere de filesystem. O caso do metacaractere é o pior: a entrada do índice é escrita apontando para um MOC que foi recusado e nunca existiu.

- [ ] **Step 4:** Corrigir `fencedLines`: hoje ignora o comprimento e o tipo do marcador, então uma cerca aninhada (o ` ````md ` que envolve um bloco ``` ) volta o estado para "fora da cerca". Um `## Notas` citado dentro do exemplo vira o heading alvo e a entrada é enfiada dentro do bloco de código, com a seção real intacta — reportado como escrita bem-sucedida, com diff e sem aviso. Cobrir também a cerca `~~~` dentro de uma ``` .

- [ ] **Step 5:** Corrigir `bumpAtualizado` para frontmatter vazio (`---\r\n---\r\n`, que o Obsidian produz quando todas as propriedades são removidas): `head` é só `'---\r'`, o teste de CRLF dá falso, e a linha `atualizado:` entra com LF puro num arquivo CRLF.

- [ ] **Step 6:** Serializar o frontmatter do MOC em vez de interpolar: `buildMoc` monta `tags: [${dominio}]` na mão, e `dominioProblem` aceita `#`, `%`, `@`, `!`, aspas e crase — `dominio='#dev'` gera frontmatter que o js-yaml recusa, e o MOC novo nasce sem `tipo: moc`, indexado como nota comum. Passar por `ensureFrontmatter`, como `writer.ts` já faz.

- [ ] **Step 7:** Fechar as lacunas de teste restantes de `propagate.ts`, cada uma verificada por mutação: o rethrow de erro não-ENOENT (hoje deletá-lo mantém a suíte verde enquanto um MOC ilegível é substituído em silêncio por um vazio — perda de dados sem diagnóstico); o `eolSuffix` de CRLF em `insertUnderSection`, que o docstring do próprio módulo diz que precisa concordar com `bumpAtualizado` e só o segundo está coberto; `buildIndex`, que nenhum teste executa; e as faixas de `INVISIBLE_CHARS` que hoje podem ser removidas uma a uma sem quebrar nada, incluindo as de largura zero e as bidi.

### Task 20: trim linear no tokenizador

**Files:**
- Modify: `src/index/tokenizer.ts`
- Modify: `src/index/bm25.ts`
- Modify: `test/tokenizer.test.ts`
- Modify: `test/bm25.test.ts`

**Depends:** T4, T7, T9

**Model:** capable

`tokenize` corta hífens de borda com `raw.replace(/^-+/, '').replace(/-+$/, '')` (`src/index/tokenizer.ts:15`). O segundo `replace` backtracka quadraticamente num token da forma `[alnum][corrida de hífens][alnum]`: o `-+` guloso é retentado a partir de cada posição e o `$` falha em todas. Medido nesta árvore, só o `tokenize`: 10.000 hífens 73,9 ms; 20.000 284,2 ms; 40.000 1.165,0 ms; 80.000 4.514,1 ms — 4× por duplicação, quadrático limpo.

O caminho da query é o menos grave, e a fase 5 já o fecha limitando os bytes em `boundedQuery`. O que **não** dá para fechar de lá é `src/index/inverted-index.ts:89`, que chama `tokenize` sobre o **corpo das notas** na indexação: uma nota do vault com uma corrida longa de hífens — um clipping em `01-raw/`, uma linha de separador colada, um blob com hífens — trava toda varredura, em toda busca, para sempre, sem ninguém precisar mandar query nenhuma. O defeito é do tokenizador, e é lá que se conserta.

- [ ] **Step 1:** Trocar os dois `replace` por uma varredura linear de índices (avançar enquanto `charCodeAt` for 45 nas duas pontas, e fatiar), ou por qualquer forma que não backtracke. O resultado tem que ser idêntico ao atual para toda entrada — o corte de hífens de borda é comportamento observado pelos testes existentes e pelas golden queries.

- [ ] **Step 2:** Aplicar um teto de comprimento por token, alinhado com `MAX_TERM_LENGTH = 64` de `src/index/bm25.ts:69`. Hoje `MAX_TERM_LENGTH` só protege o par de Levenshtein (`bm25.ts:79`); nada limita o token que entra no índice, então um token de 20 MB vira uma chave de posting list. Descartar ou truncar — decidir e justificar no relatório, lembrando que truncar funde termos distintos que compartilham prefixo.

- [ ] **Step 3:** Cobrir com teste de desempenho **determinístico**, nunca com asserção de relógio: um token de 200.000 hífens tem que produzir exatamente o mesmo resultado que o token equivalente curto, e a suíte inteira tem que rodar no tempo de sempre. Uma asserção de wall-clock é flaky em máquina carregada e já foi descartada duas vezes nesta run por ser vacuosa.

- [ ] **Step 4:** Cobrir a via da indexação, não só a da query: indexar uma nota cujo corpo contém a corrida longa de hífens e afirmar que a varredura completa sem estourar o tempo normal da suíte e que a nota fica pesquisável pelos seus termos reais.

- [ ] **Step 5:** Verificar por mutação: restaurar o `replace(/-+$/, '')` original tem que quebrar o teste do Step 3 ou do Step 4.

- [ ] **Step 6:** Fechar o custo do caminho de sugestão em `src/index/bm25.ts`. `MAX_CANDIDATE_PAIRS = 750_000` (`bm25.ts:122`) limita a CONTAGEM de pares assumindo que cada par é O(1) por causa de `MAX_TERM_LENGTH = 64` (`bm25.ts:69`, usado só em `bm25.ts:79`). A suposição é falsa: termos de 64 caracteres, todos do mesmo comprimento e compartilhando prefixo, derrotam as saídas antecipadas do `levenshtein` e rodam a matriz 64×64 inteira, então o teto permite da ordem de 3e9 células. Medido com um vocabulário de 50.000 termos naturais mais um clipping em `01-raw/` de tokens tipo hash com prefixo comum, uma única query de 1 KB: 500 termos envenenados 277 ms, 2.000 939 ms, 8.000 4.948 ms, e 31.357 ms quando todo o vocabulário tem essa forma — contra 94–124 ms num vocabulário aleatório natural. A precondição é conteúdo do vault, e `01-raw/` é captura da web indexada, que é exatamente o modelo de ameaça que o próprio `bm25.ts` declara. Limitar o custo de verdade: orçar por CÉLULAS e não por pares, ou passar a `suggestTerms` só um punhado de termos da query em vez dos 64 — correção ortográfica não precisa de mais que isso. Cobrir com teste determinístico, nunca com relógio.

- [ ] **Step 8:** Fechar a classe do FIFO no `learn()` inteiro. A fase 6 fechou o travamento no caminho DA NOTA — `pathState` responde `foreign` e nada é aberto — mas três caminhos nunca consultam `pathState`. Reproduzido no tip da T15, cada um deixando a promise PENDENTE por ~6000 ms e exigindo SIGKILL: `mkfifo <vault>/_templates/wiki.md` trava em `learn.ts:476` (um `fs.readFile` sem guarda); `mkfifo <vault>/02-wiki/<dom>/<dom>-moc.md` e `mkfifo <vault>/04-daily/<data>.md` travam em `propagate.ts:567`. No servidor stdio de thread única isso trava toda chamada seguinte e só se recupera matando o processo. Rodar a mesma classificação por `lstat` antes da leitura do template e antes das leituras de alvo do `propagate`, ou abrir com `O_NONBLOCK|O_NOFOLLOW`. **Corrigir também o docblock em `learn.ts:336-338`**, que afirma que "`foreign` existe para que nenhum caminho abra um" — hoje isso é falso para o `learn()` como um todo. Cobrir com teste, sempre com leitura limitada: um teste que trava é pior que um que falha, porque o vitest imprime a falha e nunca sai.

- [ ] **Step 9:** Fechar as pontas soltas da fase 6 em `learn.ts`, cada uma verificada por mutação. (a) `learn.ts:361` — um placeholder só de espaços com mais de 1 MiB classifica como `note`, então o `editNote` roda e a nota nasce com frontmatter `{}` e sem `# H1`, reportada como `appended` com um aviso de colisão de título nomeando uma nota que nunca existiu; o teto em si está certo e a direção `note` tem teste (`test/learn.test.ts:1646`), a direção em branco não. (b) `learn.ts:388` — o `finally { await handle.close(); }` divide o `try` com o `catch` que responde `'note'`, então um `close` que rejeita escapa do `pathState`; os dois pontos de chamada não têm proteção, e um EIO cru perde o insight (reportado como NÃO verificado por execução — precisa de injeção de falha). (c) `learn.ts:603` — `lstat` não distingue um HARD link, então `fs.link(<segredo fora do vault>, <vault>/.../<slug>.md)` classifica como `note` e o texto do segredo vai para a nota, para o commit e para o `result.diff` devolvido ao chamador; mitigado por `fs.protected_hardlinks` e exige acesso de escrita ao vault, e o original sobrevive porque o `rename` do `atomicWrite` quebra o link — é cópia e vazamento, não corrupção. (d) `test/learn.test.ts:1362` — o teste de rota cruzada do `criado` amostra o relógio DEPOIS das duas chamadas, então uma execução que cruza a meia-noite local falha numa nota correta.

- [ ] **Step 10:** Aplicar em `test/writer.test.ts` o mesmo endurecimento de teardown que a T15 aplicou em `test/learn.test.ts`. O gate da fase — não a máquina de um teammate — falhou uma vez com `ENOTEMPTY: rmdir '.../vault/.git'`: o teardown correndo com o `gc --auto` que o git dispara em segundo plano e que sobrevive ao commit já aguardado. `test/writer.test.ts:287` e `:752` criam repositórios descartáveis e os removem com `fs.rm` puro, sem `gc.auto 0` e sem `maxRetries`. Um gate que trava ou falha por acaso não serve como evidência, que é a única coisa que um gate faz. (`test/git.test.ts:28,293` tem a mesma forma e pertence à T12, já integrada — fica como follow-up, não é desta task.)
