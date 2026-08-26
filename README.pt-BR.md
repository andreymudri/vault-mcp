# vault-mcp

**Português** | [English](README.md)

[![CI](https://github.com/andreymudri/vault-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/andreymudri/vault-mcp/actions/workflows/ci.yml)

Memória de longo prazo para um agente de código: ele busca no seu vault Obsidian antes de
responder, cita `caminho:linha`, e registra o que aprendeu sem perguntar onde salvar.

Servidor MCP para busca, leitura e escrita em um vault de conhecimento Obsidian. Recuperação por BM25 lexical mais um salto de wiki-links; registro inteligente de aprendizados que decide entre criar nota nova ou anexar ao existente; propagação automática para o MOC do domínio e a nota diária, e para o índice de conhecimento quando o domínio é novo.

## Exemplo

Saída real das duas tools que definem o projeto, rodadas contra o vault de teste deste repositório.

**`vault_search`** devolve trechos já endereçados — `caminho:linha` é o que o agente deve citar:

```text
2 resultado(s) para "retry backoff". Cite `caminho:linha` ao usar qualquer trecho abaixo. Cada trecho da nota vem prefixado com `> `; linhas sem esse prefixo são deste servidor, nunca conteúdo do vault.

02-wiki/nestjs/bullmq-worker.md:13 — Contexto > Retry e backoff (score 7.94)
> ### Retry e backoff
>
> Quando um job falha, o BullMQ aplica a política de retry configurada em `queueOptions`. Para revisar o fluxo de autenticação usado antes de cada retry, veja [[auth-guard]];
> a mesma referência [[auth-guard]] documenta como o token é revalidado a cada nova tentativa de processamento.

02-wiki/nestjs/auth-guard.md:11 — Contexto (score 3.18, via grafo)
> ## Contexto
>
> A API precisava de um mecanismo central de autenticação e autorização, aplicado de forma consistente em todos os módulos, sem repetir lógica de validação de JWT em cada controller.
```

`auth-guard` não casa termo nenhum da query. Ela entra por **um salto de wiki-link** a partir da nota que casou, com o score amortecido — é isso que `via grafo` marca.

**`vault_learn`** decide sozinho se cria nota ou anexa, escreve os até quatro arquivos e commita **uma vez**:

```text
Aprendizado registrado em nota NOVA: 02-wiki/concorrencia/timeout-de-fila-libera-a-fila-nao-o-chamador.md
Motivo: sem overlap de tag nem de domínio
Propagado para: 02-wiki/concorrencia/concorrencia-moc.md, 00-index/index-knowledge.md, 04-daily/2026-08-26.md
Commit: sim

Diff (mostre ao usuário):
--- /dev/null
+++ b/02-wiki/concorrencia/timeout-de-fila-libera-a-fila-nao-o-chamador.md
@@ -0,0 +1,15 @@
+---
+tipo: wiki
+tags: [fila]
+criado: 2026-08-26
+---
+
+# Timeout de fila libera a fila, não o chamador
+
+Um slot que expira solta a PRÓXIMA escrita; a chamada original continua esperando o resultado real dela. Resolver a promessa do chamador no timeout reportaria um desfecho que ninguém observou.
+
+**Contexto:** Serializando as tools de escrita do vault-mcp contra si mesmas.
+
+## Solução
+
+## Exemplo
--- /dev/null
+++ b/02-wiki/concorrencia/concorrencia-moc.md
@@ -0,0 +1,16 @@
+---
+tipo: moc
+tags: [concorrencia]
+criado: 2026-08-26
+atualizado: 2026-08-26
+---
+
+# Concorrencia — Mapa de Conteúdo
+
+## Notas
+
+- [[timeout-de-fila-libera-a-fila-nao-o-chamador]] — Um slot que expira solta a PRÓXIMA escrita; a chamada original continua esperando o resultado real dela.
+
+## Relacionados
+
+- [[../../00-index/index-knowledge|índice de conhecimento]]
--- a/00-index/index-knowledge.md
+++ b/00-index/index-knowledge.md
@@ -1,6 +1,6 @@
 ---
 tipo: moc
-atualizado: 2026-02-01
+atualizado: 2026-08-26
 ---
 
 # Índice de Conhecimento
@@ -9,6 +9,7 @@
 
 - [[../02-wiki/nestjs/nestjs-moc|nestjs]] — NestJS, providers, guards, filas
 - [[../02-wiki/docker/docker-moc|docker]] — Dockerfiles, multi-stage, compose
+- [[../02-wiki/concorrencia/concorrencia-moc|concorrencia]] — Um slot que expira solta a PRÓXIMA escrita; a chamada original continua esperando o resultado real dela.
 
 ## Convenções
 
--- /dev/null
+++ b/04-daily/2026-08-26.md
@@ -0,0 +1,10 @@
+---
+tipo: daily
+criado: 2026-08-26
+---
+
+# 2026-08-26
+
+## Capturas
+
+- 11:12 [[timeout-de-fila-libera-a-fila-nao-o-chamador]] (aprendizado)
```

Quatro arquivos, um commit `docs(vault): {titulo}` — desfazer o aprendizado inteiro é `git revert` desse commit. O domínio `concorrencia` não existia: por isso a nota entrou com `confirm_novo_dominio: true`, o MOC foi criado do zero e o índice de conhecimento ganhou a linha dele.

## Instalação

```bash
npm install
npm run build
npm test
```

- **Node >= 20** para RODAR o servidor (`dist/` é JavaScript comum)
- **Para rodar a suíte é preciso mais:** `test/frontmatter.test.ts` executa o `parseFile` real num
  processo filho fixado num fuso, e esse filho é `node <arquivo>.ts` — depende do type stripping do
  próprio Node. O CI fixa a 26, que é a versão em que isto é desenvolvido
- A suíte tem 17 arquivos com 1.039 testes e leva ~40 s. `npm test` roda o typecheck
  (`pretest`) antes e limita a suíte por relógio: uma suíte travada sai com 124, nunca sem exit code

## Configuração

O vault é passado por variável de ambiente, e o servidor é executado via node diretamente:

```bash
VAULT_PATH="/caminho/absoluto/do/vault" node /caminho/absoluto/do/vault-mcp/dist/server/index.js
```

Substitua `/caminho/absoluto/do/vault` pela raiz do seu vault e `/caminho/absoluto/do/vault-mcp` pelo caminho ao diretório do projeto. `VAULT_PATH` é **obrigatório**. Se não for definido ou não for um diretório, o servidor sai com código 1 e escreve o motivo em stderr.

**Nota:** não use `npx vault-mcp` — existe uma colisão com outro pacote no npm e o comando resolveria para o pacote errado quando executado de fora do diretório do projeto.

## Registro no Claude Code

Adicione o MCP com:

```bash
claude mcp add vault --scope user \
  -e "VAULT_PATH=/caminho/absoluto/do/vault" \
  -e "VAULT_AUTO_PUSH=1" -- \
  node /caminho/absoluto/do/vault-mcp/dist/server/index.js
```

Os dois caminhos são **absolutos**, e o do vault entra em `-e` como um par `CHAVE=valor` único — com
aspas em volta do par inteiro, que é o que faz um vault cujo caminho tem espaço funcionar. Não há
expansão de variável em JSON, então um caminho relativo aqui vira um servidor que não sobe.

`--scope user` registra em `~/.claude.json` e deixa as tools disponíveis em **todo** projeto, que é o
ponto: o vault responde sobre decisões e patterns enquanto você trabalha em outro repositório. Sem a
flag o padrão é `local` (só o diretório atual). Confira com `claude mcp get vault`; para remover,
`claude mcp remove vault -s user`.

### `VAULT_AUTO_PUSH`

Toda escrita (`vault_write_note`, `vault_edit_note`, `vault_learn`) já commita no git do vault.
`VAULT_AUTO_PUSH=1` acrescenta um `git push` depois do commit — sem isso o commit fica só na máquina,
e um vault com remote guardado em mais de um lugar diverge em silêncio.

**Desligado por padrão**, porque é a única coisa que este servidor faz que sai da máquina. Quando
ligado:

- `git push` sem refspec, seguindo o upstream do branch: um repositório que não foi configurado diz
  isso em vez de ter remote e branch adivinhados
- **falha sempre como aviso, nunca como rollback.** A nota já está em disco e commitada; desfazer
  isso porque a rede caiu seria o pior negócio disponível. A resposta da tool ganha uma linha
  `Push: sim|não`, que só aparece quando um push foi de fato TENTADO
- **um remote que andou na frente não é resolvido sozinho.** Pull, rebase e merge reescrevem a base
  de conhecimento do usuário, e isso é decisão dele — não efeito colateral de gravar uma nota. O
  aviso nomeia a situação e para
- limitado a 30 s, com `GIT_TERMINAL_PROMPT=0`: um servidor stdio não tem terminal para responder um
  prompt de credencial, então um prompt seria um travamento. As credenciais precisam vir de um
  helper (por exemplo `gh auth git-credential`) ou de uma chave SSH

## As Sete Tools

| Tool | Entrada | Quando Chamar |
|------|---------|---------------|
| `vault_search` | `query` (obrigatório); `limit`, `tipo`, `folder`, `include_raw` (opcionais) | Antes de responder sobre decisões, padrões, gotchas ou histórico do usuário. Resultado padrão: 6 trechos. Notas em `01-raw/` excluídas por padrão. |
| `vault_get_note` | `path` (caminho relativo, ex.: `02-wiki/nestjs/auth-guard.md`) | Após `vault_search` quando o trecho não bastar, ou antes de editar uma nota. Retorna a nota com frontmatter, links resolvidos e links quebrados. O corpo é limitado a 20.000 caracteres; notas maiores são marcadas com `[…nota cortada em 20000 caracteres]`. |
| `vault_list` | `tipo`, `tags`, `status`, `folder` (todos opcionais) | Inventário de notas por metadado (ex.: "quais projetos ativos?", "quais notas têm a tag jwt?"). Não busca por conteúdo — use `vault_search` para isso. |
| `vault_backlinks` | `path` (caminho relativo) | Medir conectividade de um assunto, achar o MOC que indexa uma nota, avaliar impacto de mudança. Deduplica links: uma nota que linka o alvo duas vezes conta como um backlink. |
| `vault_write_note` | `path`, `content` (obrigatórios); `frontmatter` (opcional) | Criar ou substituir uma nota inteira. Frontmatter é garantido. Commita automaticamente. Para mudar um trecho, use `vault_edit_note`; para registrar aprendizado, use `vault_learn`. |
| `vault_edit_note` | `path`, `old_text`, `new_text` (obrigatórios) | Substituir um trecho exato de uma nota. Falha se o trecho não existir ou aparecer mais de uma vez — nesse caso, inclua mais contexto em `old_text`. |
| `vault_learn` | `titulo`, `insight`, `contexto`, `dominio` (obrigatórios); `projeto`, `tags`, `links`, `confirm_novo_dominio` (opcionais) | Registrar aprendizado durante a sessão (decisão de arquitetura, pattern, gotcha, armadilha). Não pergunte onde salvar — o servidor decide. Mostra o diff ao usuário. **Se o domínio não existe em `02-wiki/`, a chamada falha; use `confirm_novo_dominio: true` para criar.** |

## Como o `vault_learn` Decide

`vault_learn` busca o assunto combinando título e insight. Apenas notas **já em `02-wiki/` e atingidas por BM25 direto** (não pela expansão de grafo) são candidatas a receber o aprendizado. Se encontrar tal candidata:

1. **Razão de 1,8×**: o topo deve se destacar sobre o segundo colocado por fator de pelo menos 1,8. Sem isso, há dúvida e cria nota nova.
2. **Overlap conjuntivo**: o topo deve compartilhar uma tag COM A ENTRADA, OU estar no mesmo domínio (`02-wiki/<dominio>/`). Sem overlap, cria nota nova mesmo que o score seja alto.

Quando ambas as condições são atendidas, **anexa** à nota existente numa seção `## YYYY-MM-DD — Título`. Caso contrário, **cria** nota nova em `02-wiki/<dominio>/`.

O viés é deliberado: quando há dúvida, cria nota nova em vez de enterrar aprendizado num lugar errado. É sempre possível mesclar notas depois; é impossível recuperar aprendizado perdido.

### Escape hatches

Três exceções podem mudar o destino final:

1. **Colisão de título**: a regra de duplicata recusa, mas um arquivo com aquele nome já existe (nota antiga com o mesmo slug). O servidor **anexa nela mesmo assim** e avisa `anexado em <path> por coincidência de título; a checagem de duplicata não indicou essa nota`. Isso traz uma nota perdida de volta para o fluxo de acúmulo.

2. **Alvo da duplicata não recebe o texto**: o servidor decide anexar à nota candidata, mas ela não pode ser editada. O servidor **cria nota nova com um nome baseado no slug** (ex.: `multi-stage-cache-de-camadas.md` em vez de `multi-stage.md`) e avisa `não foi possível anexar em <path>; aprendizado gravado em <outro-path>`. O aviso nomeia o caminho exato onde o aprendizado foi gravado.

3. **Caminho da nota bloqueado por não-nota**: o caminho onde a nota seria criada (ex.: `02-wiki/docker/titulo.md`) está ocupado por um FIFO, symlink, diretório ou hard link (algo que não pode ser sobrescrito). O servidor **cria nota nova com sufixo de data** (ex.: `titulo-2026-08-25.md`) e avisa `<path> não é uma nota (link, diretório ou dispositivo); aprendizado gravado em <outro-path>`. O aviso nomeia o caminho exato onde o aprendizado foi gravado.

Em todos os casos, nenhum insight é perdido — a resposta diz exatamente onde o aprendizado foi a parar.

## O Que `vault_learn` Escreve

Uma chamada a `vault_learn` pode tocar até 4 arquivos, todos em **um único commit** com mensagem `docs(vault): {titulo}`:

1. **A nota** (`02-wiki/<dominio>/<slug>.md`): criada ou com aprendizado anexado. Sempre escrita.
2. **O MOC do domínio** (`02-wiki/<dominio>/<dominio>-moc.md`): criado se não existir. Atualizado com `atualizado:` em toda chamada; com uma linha `- [[<slug>]] — <resumo>` apenas se a nota for nova. Escrito **apenas se o conteúdo mudar**.
3. **Índice de conhecimento** (`00-index/index-knowledge.md`): atualizado APENAS se o domínio não existia antes. Escrito **apenas se o conteúdo mudar**.
4. **Nota diária** (`04-daily/YYYY-MM-DD.md`): criada se não existir. Atualizada com captura `- HH:MM [[<slug>]] (<tipo>, <projeto>)` apenas se a linha não existir. Escrito **apenas se o conteúdo mudar**.

Todos os arquivos são gravados atomicamente. Se a propagação falhar (ex.: sem espaço em disco), os arquivos permanecem em disco e a resposta inclui aviso nomeando o alvo que não foi atualizado. Se o commit git falhar (ex.: repositório não existe), os arquivos permanecem gravados em disco e a resposta inclui aviso.

Reverter um aprendizado inteiro é:
```bash
git revert <commit-hash>
```

## Ajustando o Ranking

Qualquer mudança nos seguintes parâmetros precisa passar na suíte completa: `npm test`. Cada constante é pinada em um local específico:

- **`FIELD_WEIGHTS`** (`src/index/inverted-index.ts`): `heading: 3.0, tags: 2.0, prose: 1.0, code: 0.5`. Peso na frequência de cada campo. Pinado em `test/bm25.test.ts`.
- **`NOTE_TYPE_WEIGHTS`** (`src/index/inverted-index.ts`): `moc: 0.3, daily: 0.3`. Multiplica o score final de notas do tipo MOC ou daily. Existe porque essas notas repetem a query em chunks curtos — sem o fator, o MOC supera a nota apontada. Pinado em asserção literal em `test/bm25.test.ts:370-374`; `test/golden-queries.test.ts` e `test/retrieval.test.ts` falham apenas se removido, não se reajustado.
- **`GRAPH_DAMPING`** (`src/retrieval/budget.ts`): `0.4`. Multiplica o score de vizinhos do grafo — notas linkadas. Um salto, não múltiplos. Pinado em `test/retrieval.test.ts:522`.
- **`K1`** e **`B`** (`src/index/bm25.ts`): `1.2` e `0.75`. Parâmetros do BM25. Pinado em `test/bm25.test.ts:232-233`.
- **`DUPLICATE_SCORE_RATIO`** (`src/write/learn.ts`): `1.8`. Razão mínima entre topo e segundo colocado para anexar. Pinado em `test/learn.test.ts:336`.

Rodar a suíte completa:
```bash
npm test
```

## Garantias de Segurança

Escritas são recusadas para:
- Caminhos fora do vault
- Caminhos em `.git/`, `.obsidian/`, `node_modules/`, `_templates/` e `99-archive/`
- Symlinks (resolvidos antes de escrever)
- Hard links

**Dentro de uma única instância do servidor**, dois `vault_learn` ou `vault_write_note` concorrentes não interleave inicialmente: cada escrita espera a anterior terminar. Se uma escrita ficar pendurada (ex.: git bloqueado), o timeout de 60 segundos **libera a fila para a próxima escrita**, não o chamador — a chamada anterior continua aguardando seu resultado real. Quando a próxima escrita inicia, ambas podem estar rodando — a chamada ganha um aviso dizendo que a exclusividade não foi garantida. Isto NÃO protege contra escritas simultâneas do Obsidian, de uma segunda instância do servidor, ou de um `git checkout` no vault.

## Busca e Recuperação

A busca roda BM25 sobre chunks de 2–3 níveis de heading, incluindo prosa, tags e cabeçalho com pesos diferentes. Se nenhum termo da query bater em nenhuma nota, tenta sugerir termos parecidos (distância de Levenshtein ≤ 2).

Depois da busca BM25 pura, expande por um salto de wiki-links: vizinhos das notas que batiram herdam `GRAPH_DAMPING` vezes o score da fonte.

Cada resultado cita `caminho:linha` — esse é o endereço real da nota. Trechos de notas são prefixados com `> ` em `vault_search` para distinguir conteúdo do vault de linhas do servidor.

## Estrutura do Vault

Convenção de diretórios:
- `00-index/`: índice de conhecimento e MOCs raiz
- `01-raw/`: capturas cruas e clippings (excluídas de busca por padrão)
- `02-wiki/`: conhecimento organizado por domínio (`nestjs/`, `docker/`, etc.)
- `03-projects/`: notas de projeto
- `04-daily/`: notas diárias (YYYY-MM-DD.md)
- `_templates/`: templates do Obsidian (ignoradas na indexação)
- `99-archive/`: notas arquivadas (legíveis, não graváveis)

## Limitações Conhecidas

Os nove follow-ups levantados na construção foram corrigidos — inclusive o frontmatter com alias que
travava o event loop por ~5 s, o hard link indexado no caminho de leitura e a corrida de escrita
entre processos. `docs/followups.md` guarda o histórico: cada item com a medição que o caracterizava,
a correção aplicada e o teste que a fixa, mais o que continua **aceito deliberadamente**.

## Desenvolvimento

Depois de uma mudança no código:

```bash
npm run build     # Compila TypeScript (só src/, emite dist/)
npm run typecheck # tsc sobre src/ E test/, sem emitir
npm test          # Roda o typecheck (pretest) e depois os testes vitest
npm run dev       # Watch mode (se necessário)
```

O `tsconfig.json` de build cobre só `src/` — quem emite não compila teste. `tsconfig.test.json`
cobre os dois com `noEmit`, e o `pretest` do npm o roda antes da suíte: um fake de teste que deixa de
satisfazer a interface que declara `implements` falha no typecheck, e não em execução.

A suíte completa leva ~40 s. Alguns testes usam FIFO para simular operações de longa
duração; todos eles abrem a ponta de escrita por conta própria (`withFifoWatch`), então falham em
segundos em vez de dependerem do timeout do runner. `npm test` roda por `scripts/test.mjs`, que
limita a suíte por relógio (15 min, `VAULT_MCP_TEST_TIMEOUT_MS`) e mata o grupo de processos: uma
suíte travada vira exit 124, e não uma parada indefinida sem exit code nenhum.

## Licença

[MIT](LICENSE) © 2026 Andrey Mudri
