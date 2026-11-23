# vault-mcp

**English** | [Português](README.pt-BR.md)

[![CI](https://github.com/andreymudri/vault-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/andreymudri/vault-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@andreymudri/vault-mcp)](https://www.npmjs.com/package/@andreymudri/vault-mcp)

Long-term memory for a coding agent: it searches your Obsidian vault before answering, cites
`path:line`, and records what it learned without asking where to save it.

MCP server for searching, reading and writing an Obsidian knowledge vault. Retrieval by lexical BM25 plus one wiki-link hop; intelligent capture of learnings that decides between creating a new note and appending to an existing one; automatic propagation to the domain MOC and the daily note, and to the knowledge index when the domain is new. Moving, renaming, promoting, archiving and deleting a note go through the server too, so the links and the MOC entries stay correct instead of silently rotting.

## Example

Real output from the two tools that define the project, run against this repository's test vault.

> The output below is verbatim, from a server started with `VAULT_LANG=pt`: the test vault is written
> in Portuguese, so that is the language that reads naturally around it. With the default, `en`, the
> server's own lines — the headline, `Reason:`, `Commit:` — are in English.

**`vault_search`** returns snippets that are already addressed — `caminho:linha` (path:line) is what
the agent is told to cite:

```text
2 resultado(s) para "retry backoff". Cite `caminho:linha` ao usar qualquer trecho abaixo. Cada trecho da nota vem prefixado com `> `; linhas sem esse prefixo são deste servidor, nunca conteúdo do vault.

02-wiki/nestjs/bullmq-worker.md:13 — Contexto > Retry e backoff (score 7.44)
> ### Retry e backoff
> 
> Quando um job falha, o BullMQ aplica a política de retry configurada em `queueOptions`. Para revisar o fluxo de autenticação usado antes de cada retry, veja [[auth-guard]];
> a mesma referência [[auth-guard]] documenta como o token é revalidado a cada nova tentativa de processamento.
> 

02-wiki/nestjs/auth-guard.md:6 (score 2.97, via grafo)
> 
> # Auth Guard
> 
> Este documento registra uma decisão de autenticação tomada para os serviços NestJS da Potentia, cobrindo como guards validam tokens JWT antes de liberar acesso às rotas protegidas.
> 

Aviso: 1 arquivo(s) com problema de indexação
  quebrada.md: frontmatter inválido: end of the stream or a document separator is expected at line 5, column 2:\n    \t- bullmq\n     ^
```

`auth-guard` matches no term in the query. It is pulled in by **one wiki-link hop** from the note
that did match, with its score damped — that is what `via grafo` (via the graph) marks. The last
two lines are the scanner reporting a file it could not index properly: the test vault ships one
on purpose, and a search never ends in silence about what it left out.

**`vault_learn`** decides on its own whether to create a note or append to an existing one, writes
up to four files and commits **once**:

```text
Aprendizado registrado em nota NOVA: 02-wiki/concorrencia/timeout-de-fila-libera-a-fila-nao-o-chamador.md
Motivo: nota parecida em outro domínio: 02-wiki/nestjs/bullmq-worker.md
Propagado para: 02-wiki/concorrencia/concorrencia-moc.md, 00-index/index-knowledge.md, 04-daily/2026-11-22.md
Commit: sim

Diff (mostre ao usuário):
--- /dev/null
+++ b/02-wiki/concorrencia/timeout-de-fila-libera-a-fila-nao-o-chamador.md
@@ -0,0 +1,15 @@
+---
+tipo: wiki
+tags: [fila]
+criado: 2026-11-22
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
+criado: 2026-11-22
+atualizado: 2026-11-22
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
+atualizado: 2026-11-22
 ---
 
 # Índice de Conhecimento
@@ -9,6 +9,7 @@
 
 - [[../02-wiki/nestjs/nestjs-moc|nestjs]] — NestJS, providers, guards, filas
 - [[../02-wiki/docker/docker-moc|docker]] — Dockerfiles, multi-stage, compose
+- [[../02-wiki/concorrencia/concorrencia-moc|concorrencia]] — Um slot que expira solta a PRÓXIMA escrita; a chamada original continua esperando o resultado real dela.
 
 ## Convenções
 
--- /dev/null
+++ b/04-daily/2026-11-22.md
@@ -0,0 +1,10 @@
+---
+tipo: daily
+criado: 2026-11-22
+---
+
+# 2026-11-22
+
+## Capturas
+
+- 15:36 [[timeout-de-fila-libera-a-fila-nao-o-chamador]] (aprendizado)
```

The `Motivo` (reason) says why this became a new note: the closest match stood out, but it lives in
another domain, and a learning is only ever appended inside the domain it was filed under.

Four files, one `docs(vault): <title>` commit — undoing the whole learning is `git revert` on it.
The `concorrencia` domain did not exist, which is why the call carried `confirm_new_domain: true`,
the MOC was built from scratch, and the knowledge index gained a line pointing at it.

## Installation

Published as **`@andreymudri/vault-mcp`**, so nothing needs to be cloned to run it:

```bash
npx @andreymudri/vault-mcp        # no install; npm fetches and runs it
npm i -g @andreymudri/vault-mcp   # or install once, then `vault-mcp`
```

The scope is not decoration: the bare `vault-mcp` on npm is a 443-byte namespace placeholder by
another author, so `npx vault-mcp` runs their package instead of this one. The command inside the
scope keeps the short name — `npx @andreymudri/vault-mcp` resolves the `bin` from within the package.

From a clone, to develop it:

```bash
npm install
npm run build
npm test
```

- **Node >= 22** to RUN the server (`dist/` is plain JavaScript), verified on every push by the
  `compat` CI job, which builds and smoke-starts it on 22
- **Running the suite takes more than that:** `test/frontmatter.test.ts` executes the real
  `parseFile` in a child process pinned to a timezone, and that child is `node <file>.ts` — it
  depends on Node's own type stripping. CI pins 26, which is the version this is developed on
- `npm test` runs the typecheck (`pretest`) first and bounds the suite by the clock: a hung suite
  exits 124, never with no exit code. It takes about fifteen seconds

## Configuration

The vault is passed through an environment variable:

```bash
VAULT_PATH="/absolute/path/to/vault" npx @andreymudri/vault-mcp
```

From a clone, the same thing without the registry:

```bash
VAULT_PATH="/absolute/path/to/vault" node /absolute/path/to/vault-mcp/dist/server/index.js
```

Replace `/absolute/path/to/vault` with the root of your vault. `VAULT_PATH` is **mandatory**. If it
is not set, or is not a directory, the server exits with code 1 and writes the reason to stderr.

Everything else is optional, and set the same way:

| Variable | Default | What it does |
|---|---|---|
| `VAULT_LANG` | `en` | Language of the server's own text: `en` or `pt`. See below. |
| `VAULT_AUTO_PUSH` | off | `1` pushes after every commit. See below. |
| `VAULT_READ_ONLY` | off | `1` publishes only the six read tools: nothing can be written, moved or deleted through this server. |
| `VAULT_DISABLED_TOOLS` | none | Tool names not to publish, separated by commas or spaces, e.g. `vault_delete,vault_move`. |
| `VAULT_LOG_LEVEL` | `warn` | How much goes to stderr, one JSON object per line: `silent`, `error`, `warn`, `info`, `debug`. |
| `VAULT_MAX_NOTE_BYTES` | `5242880` | Files larger than this are left out of the index and reported as a diagnostic. |
| `VAULT_LOCK_TIMEOUT_MS` | `30000` | How long a write waits for another process writing the same vault before it is refused. |
| `VAULT_SCAN_TTL_MS` | adaptive | How long a scan of the vault is reused. `0` scans on every call. |

A value the server cannot use is never silently replaced by the default: it is reported on stderr at
start-up (`config.invalid`). `VAULT_READ_ONLY` goes further and fails closed — anything that is not
a recognisable "no" turns read-only on.

## Registering with Claude Code

Add the MCP with:

```bash
claude mcp add vault --scope user \
  -e "VAULT_PATH=/absolute/path/to/vault" \
  -e "VAULT_AUTO_PUSH=1" -- \
  npx -y @andreymudri/vault-mcp
```

From a clone, put `node /absolute/path/to/vault-mcp/dist/server/index.js` after the `--` instead.

The vault's path is **absolute** and goes into `-e` as a single `KEY=value` pair — with quotes around
the whole pair, which is what makes a vault whose path contains a space work. There is no variable
expansion in JSON, so a relative path here becomes a server that does not start. The `-y` on `npx`
matters for a stdio server: without it, the first run can stop at an install prompt on a terminal
that nobody is watching.

`--scope user` registers in `~/.claude.json` and makes the tools available in **every** project,
which is the point: the vault answers about decisions and patterns while you work in another
repository. Without the flag the default is `local` (the current directory only). Check with
`claude mcp get vault`; to remove it, `claude mcp remove vault -s user`.

### `VAULT_LANG`

The language the server **speaks**: `en` (default) or `pt`. It covers the tool and field
descriptions, input refusals (wrapper *and* payload), startup errors, result labels (Commit / Push
/ Warning / Diff, headers, empty-list markers, headlines), and the errors thrown by the write layer
— path rejected, note not found, invalid domain — which travel as a code and are resolved at the
tool boundary.

Two things it deliberately does **not** cover, so you know where the line is:

- **Anything written into the vault** — commit subjects (`docs(vault): …`) and section names
  (`## Notas`, `## Domínios`, `## Capturas`). These follow the *vault*, never the reader, and it is
  not a matter of taste: the server looks the section name up **inside your own MOC file**, so
  translating `## Notas` to `## Notes` in a vault whose MOC says `## Notas` would not find the
  section, would append a second one, and would silently break the idempotency that stops the MOC
  gaining a duplicate line on every capture.
- **Text the server only relays.** Its own warnings and the `Reason:` line of `vault_learn` are
  translated — each fixed phrase has a key, and the tool boundary swaps it. What can still come
  through in another language inside a warning is git's own output, and the message of a nested
  error that carries no code.

The default is English even though this server was built for a Portuguese vault. The tool
description is what the *model* reads to decide whether to call a tool at all, so a server
described in a language the agent is not operating in pays a translation tax on every call
decision — and whoever forgets `VAULT_PATH` gets, in a language they may not read, the one message
they needed to read.

It deliberately does **not** guess from `LANG`/`LC_ALL`. On the author's own machine the vault is
Portuguese while the shell is `LANG=en_US.UTF-8`, so inference would get the generic case right and
the one known case wrong.

Set it the same way you set `VAULT_PATH` — through your MCP client, which works on every
platform:

```bash
claude mcp add vault --scope user \
  -e "VAULT_PATH=/absolute/path/to/vault" \
  -e "VAULT_LANG=pt" -- \
  npx -y @andreymudri/vault-mcp
```

From a POSIX shell you can also prefix it directly. This form is shell grammar, not a command, so
it does **not** work in cmd.exe or PowerShell — use the client form above on Windows:

```bash
VAULT_LANG=pt VAULT_PATH="/absolute/path/to/vault" npx @andreymudri/vault-mcp
```

### `VAULT_AUTO_PUSH`

Every write (`vault_write_note`, `vault_edit_note`, `vault_learn`, `vault_move`, `vault_delete`) already commits to the vault's git.
`VAULT_AUTO_PUSH=1` adds a `git push` after the commit — without it the commit stays on the machine
only, and a vault with a remote kept in more than one place diverges silently.

**Off by default**, because it is the only thing this server does that leaves the machine. When
turned on:

- `git push` with no refspec, following the branch's upstream: a repository that has not been
  configured says so instead of having a remote and a branch guessed for it
- **it always fails as a warning, never as a rollback.** The note is already on disk and committed;
  undoing that because the network went down would be the worst trade available. The tool's response
  gains a `Push: yes|no` line (`Push: sim|não` under `VAULT_LANG=pt`), which only appears when a push was in fact ATTEMPTED
- **a remote that moved ahead is not resolved on its own.** Pull, rebase and merge rewrite the user's
  knowledge base, and that is their decision — not a side effect of saving one note. The warning
  names the situation and stops
- bounded to 30 s, with `GIT_TERMINAL_PROMPT=0`: a stdio server has no terminal on which to answer a
  credential prompt, so a prompt would be a hang. Credentials have to come from a helper (for example
  `gh auth git-credential`) or from an SSH key

## The Eleven Tools

| Tool | Input | When to Call |
|------|-------|--------------|
| `vault_search` | `query` (required); `limit`, `type`, `folder`, `tags`, `status`, `include_raw` (optional) | Before answering about the user's decisions, patterns, gotchas or history. Default result: 6 snippets. Notes in `01-raw/` excluded by default. `tags` is conjunctive and case-insensitive, and `status` reads the frontmatter — the same filters `vault_list` has, by the same rule. |
| `vault_get_note` | `path` (relative path, e.g. `02-wiki/nestjs/auth-guard.md`); `offset` (optional) | After `vault_search` when the snippet is not enough, or before editing a note. Returns the note with frontmatter, resolved links and broken links. The body is capped at 20,000 characters per answer; a larger note is marked with `[…note cut at 20000 of <total> characters; continue with offset: <next>]`, and that `offset` reads the rest — page by page, never splitting a surrogate pair. A continuation page repeats the path, not the frontmatter. |
| `vault_list` | `type`, `tags`, `status`, `folder`, `limit`, `offset` (all optional) | Inventory of notes by metadata (e.g. "which projects are active?", "which notes carry the jwt tag?"). Does not search content — use `vault_search` for that. Answers at most `limit` notes (default 200, up to 1,000); a longer inventory says how many there are and which `offset` continues it. |
| `vault_backlinks` | `path` (relative path) | Measure how connected a subject is, find the MOC that indexes a note, assess the impact of a change. Deduplicates links: a note that links the target twice counts as one backlink. |
| `vault_graph` | `folder`, `type`, `tags`, `status`, `include_raw`, `include_broken`, `max_nodes` (all optional) | An overview of how notes connect — orphans, clusters, what a filter covers — for a client that draws the graph, not to answer a question (use `vault_search` for a subject, `vault_backlinks` for who points at one note). Filters pick the nodes by the same rule as `vault_list`; `01-raw/` is left out unless `include_raw`, `99-archive/` stays in. An edge comes back only when both of its ends do, and degrees count within that subgraph. Besides the text (`<n> note(s), <m> link(s), <k> orphan(s).` and one `- source -> target` line per edge), it answers `structuredContent` under a published `outputSchema`: `nodes` (path, title, tipo, status, tags, area, domain, in/out degree, mtime), `edges`, `broken` (only with `include_broken`), `counts` and a `truncated` flag, set when `max_nodes` (default 2000, up to 5000, in path order) cut the list. |
| `vault_status` | none | Before a writing session, or after a write answered "Commit: no". Reports the server version, how many notes and chunks are indexed, whether the vault is a git repository, the branch (or a detached HEAD), commits not pushed yet, commits that failed and are waiting to be retried, who holds the write lock, and whether the server is read-only. Also as `structuredContent`. Changes nothing. |
| `vault_write_note` | `path`, `content` (required); `frontmatter` (optional) | Create or replace a whole note. Frontmatter is guaranteed. Commits automatically. To change a passage, use `vault_edit_note`; to record a learning, use `vault_learn`. |
| `vault_edit_note` | `path`, `old_text`, `new_text` (required) | Replace an exact passage of a note. Fails if the passage does not exist or appears more than once — in that case, include more context in `old_text`. |
| `vault_learn` | `title`, `insight`, `context`, `domain` (required); `project`, `tags`, `links`, `confirm_new_domain`, `preview`, `force_new`, `preview_time`, `expected_revision` (optional) | Record a learning during the session (architecture decision, pattern, gotcha, trap). Do not ask where to save — the server decides. Shows the diff to the user. **If the domain does not exist in `02-wiki/`, the call fails; use `confirm_new_domain: true` to create it.** |
| `vault_move` | `from`, `to` (required); `confirm_new_domain` (optional) | Move, rename, promote out of `01-raw/` or archive into `99-archive/` — all four are the same call, because `to` is the full path. Corrects on its own every link that would start pointing at a different note, migrates the entry between domain MOCs preserving its `— resumo`, and commits the lot together. `99-archive/` counts as a source **and** a destination, which is what gives archive and unarchive. **A destination MOC that does not exist requires `confirm_new_domain: true`.** The daily note is never touched. |
| `vault_delete` | `path` (required); `confirm` (optional) | Delete a note and drop its line from the MOC. **Refuses, without deleting, if the note has no committed version in `HEAD`** — there would be no way back —, if it is structural (MOC, daily note, index), or if it lives in `99-archive/`. Notes pointed at by others require `confirm: true`, and the refusal lists who points. The answer carries the exact command that undoes it. |

Arguments are checked strictly: one a tool does not declare is refused by name, so a mistyped
filter is an error and not an unfiltered answer. The names above are the ones the schema
publishes. The Portuguese names older versions used — `titulo`, `contexto`, `dominio`, `projeto`,
`confirm_novo_dominio`, `tipo` — are still accepted and renamed on the way in.

Every tool publishes a title and MCP annotations: the six that read are `readOnlyHint`, and of the
five that write only `vault_learn` is non-destructive (it only ever adds). Every refusal carries
its code beside the text, in the result's `_meta["io.github.andreymudri/vault-mcp.error"]` as `{ code, params? }` —
`path.outsideVault`, `lock.timeout`, `preview_stale`, `input.invalid`, an errno for a filesystem
error. It is in
`_meta` and not in `structuredContent` because a tool that publishes an output schema owes that
schema on every answer, and clients hold it to that even on an error.

## How `vault_learn` Decides

`vault_learn` searches the subject by combining title and insight. Only notes **already in `02-wiki/` and reached by direct BM25** (not by graph expansion) are candidates to receive the learning. If such a candidate is found:

1. **1.8× ratio**: the top hit must stand out over the runner-up by a factor of at least 1.8. Without that there is doubt, and it creates a new note.
2. **Same domain**: the top hit must live in the domain the learning was filed under (`02-wiki/<domain>/`). A look-alike in another domain is named in the `Reason` — so the two can be linked — and is never appended to, however high it scores. A shared tag used to be enough here, and that is what filed a learning about one project into a note about another.

When both conditions hold, it **appends** to the existing note under a `## YYYY-MM-DD — Title` section. Otherwise it **creates** a new note in `02-wiki/<dominio>/`.

The bias is deliberate: when in doubt, create a new note rather than bury a learning in the wrong place. Merging notes later is always possible; recovering a lost learning is not.

### Escape hatches

Three exceptions can change the final destination:

1. **Title collision**: the duplicate rule says no, but a file with that name already exists (an older note with the same slug). The server **appends to it anyway** and warns `anexado em <path> por coincidência de título; a checagem de duplicata não indicou essa nota`. This brings a lost note back into the accumulation flow.

2. **The duplicate target cannot take the text**: the server decides to append to the candidate note, but it cannot be edited. The server **creates a new note under a name derived from the slug** (e.g. `multi-stage-cache-de-camadas.md` instead of `multi-stage.md`) and warns `não foi possível anexar em <path>; aprendizado gravado em <outro-path>`. The warning names the exact path where the learning was written.

3. **The note's path is blocked by a non-note**: the path where the note would be created (e.g. `02-wiki/docker/titulo.md`) is occupied by a FIFO, symlink, directory or hard link (something that cannot be overwritten). The server **creates a new note with a date suffix** (e.g. `titulo-2026-08-25.md`) and warns `<path> não é uma nota (link, diretório ou dispositivo); aprendizado gravado em <outro-path>`. The warning names the exact path where the learning was written.

In every case, no insight is lost — the response says exactly where the learning ended up.

## What `vault_learn` Writes

One call to `vault_learn` can touch up to 4 files, all in **a single commit** with the message `docs(vault): <title>`:

1. **The note** (`02-wiki/<dominio>/<slug>.md`): created, or with the learning appended. Always written.
2. **The domain MOC** (`02-wiki/<dominio>/<dominio>-moc.md`): created if it does not exist. Updated with `atualizado:` on every call; with a `- [[<slug>]] — <resumo>` line only if the note is new. Written **only if the content changes**.
3. **Knowledge index** (`00-index/index-knowledge.md`): updated ONLY if the domain did not exist before. Written **only if the content changes**.
4. **Daily note** (`04-daily/YYYY-MM-DD.md`): created if it does not exist. Updated with the capture `- HH:MM [[<slug>]] (<tipo>, <projeto>)` only if the line is not already there. Written **only if the content changes**.

Every file is written atomically. If propagation fails (e.g. out of disk space), the files stay on disk and the response includes a warning naming the target that was not updated. If the git commit fails (e.g. the repository does not exist), the files stay written on disk and the response includes a warning.

Undoing a whole learning is:
```bash
git revert <commit-hash>
```

## Tuning the Ranking

Any change to the following parameters has to pass the full suite: `npm test`. Each constant is pinned in a specific place:

- **`FIELD_WEIGHTS`** (`src/index/inverted-index.ts`): `heading: 3.0, tags: 2.0, prose: 1.0, code: 0.5`. Weight on each field's frequency. Pinned in `test/bm25.test.ts`.
- **`NOTE_TYPE_WEIGHTS`** (`src/index/inverted-index.ts`): `moc: 0.3, daily: 0.3`. Multiplies the final score of MOC or daily notes. It exists because those notes repeat the query across short chunks — without the factor, the MOC beats the note it points at. Pinned by a literal assertion in `test/bm25.test.ts:370-374`; `test/golden-queries.test.ts` and `test/retrieval.test.ts` fail only if it is removed, not if it is re-tuned.
- **`GRAPH_DAMPING`** (`src/retrieval/budget.ts`): `0.4`. Multiplies the score of graph neighbours — linked notes. One hop, not several. Pinned in `test/retrieval.test.ts:522`.
- **`K1`** and **`B`** (`src/index/bm25.ts`): `1.2` and `0.75`. BM25 parameters. Pinned in `test/bm25.test.ts:232-233`.
- **`DUPLICATE_SCORE_RATIO`** (`src/write/learn.ts`): `1.8`. Minimum ratio between top hit and runner-up for an append. Pinned in `test/learn.test.ts:336`.

Running the full suite:
```bash
npm test
```

## Security Guarantees

Writes are refused for:
- Paths outside the vault
- Paths in `.git/`, `.obsidian/`, `node_modules/`, `_templates/` and `99-archive/`
- Symlinks (resolved before writing)
- Hard links

**Two writers never interleave**, whether they are two calls on one server or two servers on the
same vault — which is the normal case, since an MCP stdio server is started per client. Inside a
process, each write waits for the previous one. Across processes, every write takes a lock file
derived from the vault (inside `.git/` when the vault is a repository), reads what is on disk only
after it has the lock, and releases it after its commit. A writer that cannot get the lock within
`VAULT_LOCK_TIMEOUT_MS` is refused with `lock.timeout` and writes nothing. A lock left by a process
that died is taken over; one held past two minutes is taken over too, and the write that lost it
says so.

What this does not bind is a writer that does not take the lock: Obsidian itself, a sync client,
a `git checkout` in the vault. The push is outside the lock on purpose — it sends the whole branch,
and a push stuck on the network must not hold every other writer.

A commit that fails after the note is written (another git holding `index.lock`, a rejecting hook)
is retried for about three seconds when the cause is the lock, and otherwise recorded in a journal
inside `.git/`; the next write makes it, under its original message. `vault_status` shows what is
pending.

See [SECURITY.md](SECURITY.md) for what the server defends against, and what it does not.

## Search and Retrieval

Search runs BM25 over chunks of 2–3 heading levels, covering prose, tags and headings with different weights. If no term of the query hits any note, it tries to suggest similar terms (Levenshtein distance ≤ 2).

After the pure BM25 search, it expands by one wiki-link hop: neighbours of the notes that hit inherit `GRAPH_DAMPING` times the source's score.

Every result cites `caminho:linha` (path:line) — that is the note's real address. Note snippets are prefixed with `> ` in `vault_search` to distinguish vault content from server lines.

## Vault Structure

Directory convention:
- `00-index/`: knowledge index and root MOCs
- `01-raw/`: raw captures and clippings (excluded from search by default)
- `02-wiki/`: knowledge organised by domain (`nestjs/`, `docker/`, etc.)
- `03-projects/`: project notes
- `04-daily/`: daily notes (YYYY-MM-DD.md)
- `_templates/`: Obsidian templates (ignored by indexing)
- `99-archive/`: archived notes (readable, not writable)

These names are the default. A vault laid out differently says so in a `.vault-mcp.json` at its
root — in the vault, not in the client's configuration, because every client that opens the vault
has to agree on where the wiki is:

```json
{
  "folders": { "wiki": "knowledge", "daily": "journal", "archive": "old" },
  "sections": { "notes": "Notes", "captures": "Captures", "context": "Context" }
}
```

`folders` takes `index`, `raw`, `wiki`, `projects`, `daily`, `archive` and `templates`; `sections`
takes `notes`, `domains`, `captures`, `links`, `related` and `context` — the heading texts the
server looks up and writes. Anything left out keeps its default, and the tool descriptions and
error messages then name the folders the vault actually has. A file that is wrong stops the server
from starting and says which key: falling back to the default would start filing notes under a
`02-wiki/` nobody asked for.

Not configurable: the frontmatter keys (`tipo`, `criado`, `atualizado`), the file names inside a
role (`<domain>-moc.md`, `index-knowledge.md`, `YYYY-MM-DD.md`), and the Portuguese titles of a
MOC or an index the server creates from nothing.

## Previewing a Learning

`vault_learn` with `preview: true` computes everything a learning would change — the note, the
domain MOC, the knowledge index, the daily note — without writing, creating a directory, committing
or pushing. The structured result carries each file's relative path, its text before and after, the
diff, a `revision` hash and the `previewTime`.

To make the approved write, repeat exactly the same arguments without `preview`, passing the
returned `previewTime` as `preview_time` and the revision as `expected_revision`. If the vault
changed in between, the call is refused with the code `preview_stale` before anything is written.
`force_new: true` creates a linked sibling note even when a matching one exists. A new domain needs
`confirm_new_domain: true` for the preview as well, and a preview whose propagation would fail is
refused rather than offered as a partial plan.

## Limits

Nothing a tool returns, accepts or indexes is unbounded:

| What | Limit |
|---|---|
| `vault_search` results | 6 snippets by default, 50 at most, 8,000 characters in all |
| `vault_get_note` body | 20,000 characters per answer; `offset` reads on |
| `vault_list` | 200 notes per answer by default, 1,000 at most; `offset` reads on |
| `vault_graph` | 2,000 nodes by default, 5,000 at most |
| Diff relayed by a write tool, and each of `diff`, `before` and `after` in `vault_learn`'s structured result | 20,000 characters, with a flag saying it was cut; the note itself is written whole |
| `content`, `old_text`, `new_text` | 1,000,000 characters |
| `insight` / `context` | 200,000 / 20,000 characters |
| A note the scanner will index | `VAULT_MAX_NOTE_BYTES`, 5 MB by default; a file with a NUL byte is not indexed at all |
| A note's file name | 220 bytes |

A file left out of the index is never dropped in silence: `vault_search` and `vault_list` end with a
line naming what was skipped and why — too large, binary, a symlink, a hard link, unreadable.

## Operating It

- **`vault_status`** answers what a write's "Commit: no" leaves open: is a commit pending, did the
  branch ever leave the machine, who holds the lock.
- **Logs** go to stderr, one JSON object per line (`ts`, `level`, `event`, then the fields), with the
  vault's absolute path redacted. The default level, `warn`, keeps a healthy server silent; `info`
  adds one line per tool call with its duration and, for a refusal, its code. The same events reach
  the client through the MCP `logging` capability, at the level the client asks for.
- **Read-only** (`VAULT_READ_ONLY=1`) publishes the six read tools and nothing else. What is not
  published cannot be called.
- **Stopping**: on SIGTERM or SIGINT the server lets a write in flight finish (up to five seconds),
  answers its caller, releases the vault lock and exits 0.
- **Scale**: `node --expose-gc scripts/bench.mjs 20000` builds a synthetic vault and prints cold
  start, warm search, scan cost and memory. On the machine this was developed on, twenty thousand
  notes index in about 3 s and hold about 190 MB live; a scan that costs more than 20 ms is reused
  for ten times its cost, up to two seconds.

## Known Limitations

Five things this server does not do, each chosen rather than overlooked:

- **Archiving to `99-archive/` loses the `— summary`** on the note's entry in its source MOC.
  `vault_move` removes the line from the origin MOC and has no destination MOC to reinsert it into,
  and the archive is a write-free area, so there is nowhere to park the text. Unarchiving recreates a
  bare `- [[slug]]`, not the entry as it was. The alternatives — stashing the summary in the moved
  note's own frontmatter, or in a side index — both cost more than the loss. What the operation never
  does is invent a summary: with no origin line, the entry comes out short and true.
- **A wiki-link that exists only in the frontmatter is not rewritten** by `vault_move`. Candidate
  notes are selected from the body, which is also where the link graph is built from, so a note this
  filter skips is a note whose edges `vault_backlinks` does not have either. Widening the rewrite
  without widening the scanner would produce the worse asymmetry: a corrected link that no read tool
  can see.
- **`vault_get_note` returns the note body raw.** Escaping it would silently break read-then-edit for
  exactly the notes that carry a control character, since `vault_edit_note` matches `old_text` as an
  exact substring of the file. The surfaces that do make per-line claims — the `vault_search` snippet
  and the diff — are sanitised.

- **A large vault can be up to two seconds behind a change made outside the server.** Walking and
  `stat`-ing every note on every call was most of the cost of a warm search past a few thousand
  notes, so an expensive scan is reused for ten times what it cost, two seconds at most. A vault
  whose scan takes under 20 ms is never affected, the server's own writes are always seen at once,
  and `VAULT_SCAN_TTL_MS=0` turns the reuse off.
- **The first call after start-up indexes the whole vault in one synchronous pass** — about 3 s at
  twenty thousand notes. Slicing it would only let a `ping` through sooner; every tool needs the
  index anyway.

`docs/followups.md` keeps the record of every defect found so far: the measurement that
characterised it, the fix applied and the test that pins it, plus the full reasoning behind each
acceptance above.

## Development

After a change to the code:

```bash
npm run build     # Compiles TypeScript (src/ only, emits dist/)
npm run typecheck # tsc over src/ AND test/, without emitting
npm test          # Runs the typecheck (pretest) and then the vitest suite
npm run lint      # Biome; a warning fails it
npm run coverage  # The suite again, with the coverage floor
npm run smoke     # Starts the built dist/ and demands the eleven tools over stdio
npm run dev       # Watch mode (if needed)
```

The build `tsconfig.json` covers only `src/` — what emits does not compile tests. `tsconfig.test.json`
covers both with `noEmit`, and npm's `pretest` runs it before the suite: a test fake that stops
satisfying the interface it declares `implements` fails at typecheck, not at run time.

The full suite takes about fifteen seconds. Two files start real processes — a second server over
the same vault, and a server that is sent SIGTERM mid-write — because that is the only way to see
what two MCP clients do to each other. Some tests use FIFOs to simulate long-running operations; all of them
open the write end themselves (`withFifoWatch`), so they fail in seconds instead of relying on the
runner's timeout. `npm test` runs through `scripts/test.mjs`, which bounds the suite by the clock
(15 min, `VAULT_MCP_TEST_TIMEOUT_MS`) and kills the process group: a hung suite becomes exit 124,
not an indefinite stall with no exit code at all.

`npm run smoke` is the check the suite cannot be: it spawns the compiled `dist/server/index.js` as a
program against a throwaway vault, completes the MCP handshake and requires `tools/list` to answer
with exactly the eleven tools, each with its annotations. It covers the entrypoint deciding it is a
library and starting nothing — a clean exit 0 to a shell, an eternal wait to a client — and it is
what makes `engines.node >= 22` a verified claim: CI runs it on Node 22 as well as on the pinned 26,
which is where the suite runs.

Commit messages are written in Portuguese (BR), and so is what the server writes INTO the vault —
commit subjects, the prose inside a diff: the vault this was built for is a Portuguese-language
knowledge base. Everything the server says to its caller lives in `src/i18n/messages.ts` in both
languages. Code comments and docblocks are in English, with a few older files left in Portuguese.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made here, and [CHANGELOG.md](CHANGELOG.md)
for what changed in each version.

## License

[MIT](LICENSE) © 2026 Andrey Mudri
