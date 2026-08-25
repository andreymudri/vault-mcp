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

O vault é passado por variável de ambiente:

```bash
VAULT_PATH="$HOME/Path/To/Your/Vault" npx vault-mcp
```

`VAULT_PATH` é **obrigatório**. Se não for definido ou não for um diretório, o servidor sai com código 1 e escreve o motivo em stderr.

## Registro no Claude Code

Adicione o MCP com:

```bash
claude mcp add vault --env VAULT_PATH="$HOME/Path/To/Your/Vault" -- \
  node /path/to/vault-mcp/dist/server/index.js
```

Troque `/path/to/vault-mcp` pelo caminho absoluto ao diretório do projeto e `$HOME/Path/To/Your/Vault` pela raiz do seu vault.

No arquivo `claude_desktop_config.json`, a entrada equivalente é:

```json
{
  "mcpServers": {
    "vault": {
      "command": "node",
      "args": ["/path/to/vault-mcp/dist/server/index.js"],
      "env": {
        "VAULT_PATH": "$HOME/Path/To/Your/Vault"
      }
    }
  }
}
```

## As Sete Tools

| Tool | Entrada | Quando Chamar |
|------|---------|---------------|
| `vault_search` | `query` (obrigatório); `limit`, `tipo`, `folder`, `include_raw` (opcionais) | Antes de responder sobre decisões, padrões, gotchas ou histórico do usuário. Resultado padrão: 6 trechos. Notas em `01-raw/` excluídas por padrão. |
| `vault_get_note` | `path` (caminho relativo, ex.: `02-wiki/nestjs/auth-guard.md`) | Após `vault_search` quando o trecho não bastar, ou antes de editar uma nota. Retorna a nota inteira com frontmatter, links resolvidos e links quebrados. |
| `vault_list` | `tipo`, `tags`, `status`, `folder` (todos opcionais) | Inventário de notas por metadado (ex.: "quais projetos ativos?", "quais notas têm a tag jwt?"). Não busca por conteúdo — use `vault_search` para isso. |
| `vault_backlinks` | `path` (caminho relativo) | Medir conectividade de um assunto, achar o MOC que indexa uma nota, avaliar impacto de mudança. Deduplica links: uma nota que linka o alvo duas vezes conta como um backlink. |
| `vault_write_note` | `path`, `content` (obrigatórios); `frontmatter` (opcional) | Criar ou substituir uma nota inteira. Frontmatter é garantido. Commita automaticamente. Para mudar um trecho, use `vault_edit_note`; para registrar aprendizado, use `vault_learn`. |
| `vault_edit_note` | `path`, `old_text`, `new_text` (obrigatórios) | Substituir um trecho exato de uma nota. Falha se o trecho não existir ou aparecer mais de uma vez — nesse caso, inclua mais contexto em `old_text`. |
| `vault_learn` | `titulo`, `insight`, `contexto`, `dominio` (obrigatórios); `projeto`, `tags`, `links`, `confirm_novo_dominio` (opcionais) | Registrar aprendizado durante a sessão (decisão de arquitetura, pattern, gotcha, armadilha). Não pergunte onde salvar — o servidor decide. Mostra o diff ao usuário. |

## Como o `vault_learn` Decide

`vault_learn` busca o assunto combinando título e insight. Se encontrar um match forte:

1. **Razão de 1,8×**: o topo de resulta precisa se destacar sobre o segundo colocado por fator de pelo menos 1,8. Sem isso, há dúvida e cria nota nova.
2. **Overlap conjuntivo**: o top deve compartilhar uma tag COM A ENTRADA, OU estar no mesmo domínio (`02-wiki/<dominio>/`). Sem overlap, cria nota nova mesmo que o score seja alto.

Quando ambas as condições são atendidas, **anexa** à nota existente numa seção `## YYYY-MM-DD — Título`. Caso contrário, **cria** nota nova em `02-wiki/<dominio>/`.

O viés é deliberado: quando há dúvida, cria nota nova em vez de enterrar aprendizado num lugar errado. É sempre possível mesclar notas depois; é impossível recuperar aprendizado perdido.

## O Que `vault_learn` Escreve

Uma chamada a `vault_learn` pode tocar até 4 arquivos, todos em **um único commit** com mensagem `docs(vault): {titulo}`:

1. **A nota** (`02-wiki/<dominio>/<slug>.md`): criada ou com aprendizado anexado. Obrigatória.
2. **O MOC do domínio** (`02-wiki/<dominio>/<dominio>-moc.md`): criado se não existir; atualizado com uma linha `- [[<slug>]] — <resumo>` se a nota for nova. Obrigatório.
3. **Índice de conhecimento** (`00-index/index-knowledge.md`): atualizado com entrada do novo domínio APENAS se o domínio não existia antes. Obrigatório quando `domainIsNew`.
4. **Nota diária** (`04-daily/YYYY-MM-DD.md`): criada ou atualizada com captura `- HH:MM [[<slug>]] (<tipo>, <projeto>)`. Obrigatória.

Todos os arquivos são gravados atomicamente. Se qualquer um falhar (ex.: git timeout), os arquivos permanecem em disco e a resposta inclui aviso nomeando o arquivo que não foi commitado.

Reverter um aprendizado inteiro é:
```bash
git revert <commit-hash>
```

## Ajustando o Ranking

`test/golden-queries.test.ts` é a rede de regressão do scoring. Qualquer mudança nos seguintes parâmetros precisa passar nesse teste:

- **`FIELD_WEIGHTS`** (`src/index/inverted-index.ts`): `heading: 3.0, tags: 2.0, prose: 1.0, code: 0.5`. Peso na frequência de cada campo.
- **`NOTE_TYPE_WEIGHTS`** (`src/index/inverted-index.ts`): `moc: 0.3, daily: 0.3`. Multiplica o score final de notas do tipo MOC ou daily. Existe porque essas notas repetem a query em chunks curtos — sem o fator, o MOC supera a nota apontada.
- **`GRAPH_DAMPING`** (`src/retrieval/budget.ts`): `0.4`. Multiplica o score de vizinhos do grafo — notas linkadas. Um salto, não múltiplos.
- **`K1`** e **`B`** (`src/index/bm25.ts`): `1.2` e `0.75`. Parâmetros do BM25.
- **`DUPLICATE_SCORE_RATIO`** (`src/write/learn.ts`): `1.8`. Razão mínima entre topo e segundo colocado para anexar.

Rodar os testes:
```bash
npm test
```

## Garantias de Segurança

Escritas são recusadas para:
- Caminhos fora do vault
- Caminhos em `.git/`, `.obsidian/`, `node_modules/`, `_templates/` e `99-archive/`
- Symlinks (resolvidos antes de escrever)
- Hard links

Dois `vault_learn` ou `vault_write_note` concorrentes não interleave: cada escrita espera a anterior terminar, com timeout de 60 segundos.

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
