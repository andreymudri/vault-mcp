# vault-mcp

Servidor MCP para busca, leitura e escrita em um vault de conhecimento Obsidian. Recuperação por BM25 lexical mais um salto de wiki-links; registro inteligente de aprendizados que decide entre criar nota nova ou anexar ao existente; propagação automática para MOC, índice de conhecimento e nota diária.

## Instalação

```bash
npm install
npm run build
npm test
```

- **Node >= 20** é obrigatório
- A suíte de testes contém 16 arquivos com 913 testes e deve levar menos de um minuto

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
claude mcp add vault --env VAULT_PATH="/home/user/Knowledge/Vault" -- \
  node /home/user/projetos/vault-mcp/dist/server/index.js
```

Substitua `/home/user/Knowledge/Vault` pelo caminho **absoluto** da raiz do seu vault e `/home/user/projetos/vault-mcp` pelo caminho absoluto do diretório do projeto. Note que a variável `VAULT_PATH` é expandida pelo shell no comando acima, mas não seria em arquivos de configuração JSON (não há expansão de variáveis no JSON — sempre use caminhos absolutos).

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

3. **Caminho da nota bloqueado por não-nota**: o caminho onde a nota seria criada (ex.: `02-wiki/docker/titulo.md`) está ocupado por um FIFO, symlink, diretório ou hard link (algo que não pode ser sobrescrito). O servidor **cria nota nova com sufixo de data** (ex.: `titulo-2026-08-25.md`) e avisa `não foi possível anexar em <path>; aprendizado gravado em <outro-path>`. O aviso nomeia o caminho exato onde o aprendizado foi gravado.

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

## Desenvolvimento

Depois de uma mudança no código:

```bash
npm run build    # Compila TypeScript
npm test         # Roda testes vitest
npm run dev      # Watch mode (se necessário)
```

A suíte completa leva ~60 segundos. Alguns testes usam FIFO para simular operações de longa duração; timeouts naturais devem ser respeitados.
