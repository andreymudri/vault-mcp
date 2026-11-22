import type { Lang } from './lang.js';
import { PHRASES } from './phrases.js';

/**
 * O catálogo de tudo que o servidor DIZ. O que ele ESCREVE no vault não está aqui, e a razão
 * está em `lang.ts` — em resumo: nome de seção é procurado dentro do arquivo do usuário, e
 * traduzi-lo anexa uma seção duplicada em silêncio.
 *
 * O português é a FONTE DA FORMA: `Messages` é `typeof PT`, então o catálogo inglês não compila
 * enquanto não tiver exatamente as mesmas chaves. Uma chave nova adicionada de um lado só é um
 * erro de tipo, não uma string faltando descoberta por um usuário.
 */
const PT = {
  instructions:
    'Servidor do vault de conhecimento. Busque antes de responder sobre decisões, padrões ou ' +
    'histórico do usuário, cite sempre `caminho:linha`, e registre aprendizados com vault_learn.',

  // The fixed text of the write layer's warnings and reasons. The Portuguese table IS the one the
  // code builds its sentences from (`phrases.ts`), so in Portuguese nothing is translated at all.
  phrases: PHRASES,

  startup: {
    vaultPathMissing:
      'VAULT_PATH não definida: aponte-a para a pasta raiz do vault, ex.: ' +
      'VAULT_PATH="/caminho/absoluto/do/vault" npx @andreymudri/vault-mcp ' +
      '(de um clone: node /caminho/absoluto/do/vault-mcp/dist/server/index.js)',
    vaultPathUnreadable: 'VAULT_PATH não pôde ser lida',
    vaultPathNotDirectory: 'VAULT_PATH não é um diretório',
    startFailed: 'vault-mcp falhou ao iniciar',
  },

  results: {
    viaGraph: 'via grafo',
    snippetTruncated: 'trecho truncado',
    citePreambleTail: 'nunca conteúdo do vault.',
    similarTerms: 'Sugestões de termos parecidos no vault',
    noteTruncated:
      'nota cortada em {max} de {total} caracteres; continue com offset: {next}',
    noteSliceFrom: 'trecho a partir do caractere {offset} de {total}',
    diagnosticsHeader: '{count} arquivo(s) com problema de indexação',
    diagnosticsMore: '… e mais {count}',
    notesCount: 'nota(s)',
    notesPointTo: 'nota(s) apontam para',
    propagatedTo: 'Propagado para',
    tagsScalarOnly: 'frontmatter.tags só aceita textos ou números; remova listas e objetos',
    yes: 'sim',
    no: 'não',
    commit: 'Commit',
    push: 'Push',
    warning: 'Aviso',
    diff: 'Diff',
    diffShowUser: 'Diff (mostre ao usuário)',
    noContentChange: '(sem alteração de conteúdo)',
    empty: '(vazio)',
    nothing: '(nada)',
    none: '(nenhum)',
    linksFixedIn: 'Links corrigidos em',
    mocIndexUpdated: 'MOC/índice atualizados',
    undoFromVault: 'Desfazer, de dentro do vault',
    noResultsFor: 'Nenhum resultado para',
    resultsFor: 'resultado(s) para',
    citePreamble:
      'Cite `caminho:linha` ao usar qualquer trecho abaixo. ' +
      'Cada trecho da nota vem prefixado com `> `; linhas sem esse prefixo são deste servidor, ',
    frontmatter: 'Frontmatter',
    links: 'Links',
    brokenLinks: 'Links quebrados',
    noNotesMatchingFilters: 'Nenhuma nota com os filtros informados.',
    noNotesPointTo: 'Nenhuma nota aponta para',
    graphSummary: '{notes} nota(s), {edges} link(s), {orphans} órfã(s).',
    noteCreated: 'Nota criada',
    noteReplaced: 'Nota substituída',
    noteEdited: 'Nota editada',
    noteMoved: 'Nota movida',
    noteDeleted: 'Nota apagada',
    learnedNewNote: 'Aprendizado registrado em nota NOVA',
    learnedAppended: 'Aprendizado ANEXADO à nota existente',
    reason: 'Motivo',
    recoveredCommits: 'Commits pendentes refeitos',
    diffTruncated: 'diff cortado em {max} de {total} caracteres; o que foi escrito está inteiro no vault',
    listPage: 'notas {from}–{to} de {total}; continue com offset: {next}',
    listLastPage: 'notas {from}–{to} de {total}',
    droppedCommits: 'Commits pendentes abandonados',
  },

  status: {
    vault: 'Vault: {notes} nota(s), {chunks} chunk(s) indexados, {diagnostics} arquivo(s) com problema de indexação',
    repositoryBranch: 'Repositório: sim, branch {branch}',
    repositoryDetached: 'Repositório: sim, HEAD solto (commits novos não ficam em branch nenhum)',
    repositoryNone: 'Repositório: não (as notas são salvas sem versionamento)',
    upstream: 'Upstream: {ahead} à frente, {behind} atrás',
    upstreamNone: 'Upstream: (nenhum)',
    pending: 'Commits pendentes: {count}',
    pendingItem: '{at} (tentativa {attempts}): {message}',
    lockFree: 'Lock do vault: livre',
    lockHeld: 'Lock do vault: pid {pid} em {host}, desde {at}',
    autoPushOn: 'Push automático: ligado',
    autoPushOff: 'Push automático: desligado',
    modeReadOnly: 'Modo: somente leitura (nenhuma tool de escrita publicada)',
    modeReadWrite: 'Modo: leitura e escrita',
  },

  errorCodes: {
    'tags.scalarOnly': 'frontmatter.tags só aceita textos ou números; remova listas e objetos',
    'hint.hardLinks': 'o arquivo tem {nlink} hard links apontando para o mesmo inode (uma cópia `cp -al` ou um snapshot de backup faz isso), então escrever nele mudaria todas as cópias de uma vez',
    'domain.empty': 'domínio vazio',
    'domain.tooLong': 'domínio longo demais',
    'domain.controlChar': 'domínio com caractere de controle',
    'domain.hasSpace': 'domínio não pode conter espaço',
    'domain.hasSeparator': 'domínio não pode conter separador de caminho',
    'domain.startsWithDot': 'domínio não pode começar com ponto',
    'domain.badChar': 'domínio com caractere não permitido',
    'note.notFound': 'nota não encontrada: {path}',
    'diag.frontmatterInvalid': 'frontmatter inválido: {detail}',
    'diag.hardLink':
      'fora do índice: é um hard link (nlink > 1), e o conteúdo pode viver fora do vault. '
      + 'Substitua por uma cópia real (`cp --reflink=never`) para indexar.',
    'diag.statFailed': 'fora do índice: não foi possível ler metadados: {detail}',
    'diag.readFailed': 'fora do índice: não foi possível ler o arquivo: {detail}',
    'diag.readdirFailed': 'não foi possível listar o diretório: {detail}',
    'diag.tooLarge': 'fora do índice: {size} bytes, acima do teto de {max} (VAULT_MAX_NOTE_BYTES)',
    'diag.binary': 'fora do índice: o arquivo tem byte NUL, não é texto',
    'diag.symlink': 'fora do índice: é um symlink, e o destino pode viver fora do vault',
    'note.offsetPastEnd': 'offset {offset} além do fim de {path}: a nota tem {total} caracteres',
    'atomic.tmpOutsideDir': 'arquivo temporário fora do diretório do destino: {tmpPath}',
    'atomic.tmpCreateFailed': 'não foi possível criar um arquivo temporário em {dir}',
    'learn.noFreeName': 'não há nome livre para a nota em {prefix}{dominio}/: 100 variações já existem',
    'learn.badTitle': 'título inválido: não gera um nome de arquivo (use letras ou números)',
    'learn.insightStartsWithDelimiter': 'insight não pode começar com o delimitador de frontmatter `---`: ele viraria o frontmatter da nota. Escreva ao menos uma linha de texto antes do bloco.',
    'learn.badDomain': 'domínio inválido: {problem}',
    'learn.unknownDomain': "domínio '{dominio}' não existe em 02-wiki/. Domínios válidos: {validos}. Repita com confirm_new_domain para criar o domínio.",
    'path.mustEndMd': 'caminho deve terminar em .md: {relPath}',
    'path.mustBeRelative': 'caminho deve ser relativo ao vault: {relPath}',
    'path.noGlob': 'caminho não pode conter metacaractere de glob: {relPath}',
    'path.outsideVault': 'caminho fora do vault: {relPath}',
    'path.readOnlyArea': 'escrita negada em {head}/ (somente leitura)',
    'path.rootMissing': 'raiz do vault inexistente ou inacessível: {root} ({detail})',
    'path.symlinkEscapes': 'symlink apontaria para fora do vault: {abs}',
    'path.noControlChar': 'caminho não pode conter caractere de controle: {relPath}',
    'path.internalArea': 'escrita negada em {segment}/ (área interna, não é conteúdo)',
    'path.notARegularFile': 'alvo não é um arquivo comum (link, diretório ou dispositivo)',
    'path.notANote': 'caminho não é uma nota (link, diretório ou dispositivo): {relPath}',
    'path.nameTooLong': 'nome longo demais: {bytes} bytes em "{name}", máximo {max}',
    'relocate.samePath': 'origem e destino são o mesmo caminho: {fromRel}',
    'relocate.sourceNotANote': 'origem não é uma nota: {fromRel}',
    'relocate.destExists': 'destino já existe: {toRel}',
    'relocate.newDomainNeedsConfirm': '{toDomain} ainda não tem MOC em 02-wiki/; passe confirm_new_domain para criá-lo',
    'relocate.raceOnMove': '{toRel} passou a existir enquanto a nota era movida; nada foi sobrescrito',
    'relocate.noteNotFound': 'nota não encontrada: {relPath}',
    'relocate.structuralNote': '{relPath} é uma nota estrutural ({tipo}) e não é apagada por aqui',
    'relocate.noHeadVersion': '{relPath} não tem versão commitada no HEAD, então apagá-la é irreversível; commite a nota antes, ou apague fora do MCP{detail}',
    'relocate.hasBacklinks': '{count} nota(s) apontam para {relPath} e os links ficarão quebrados: {list}; passe confirm para apagar mesmo assim',
    'template.unresolvedToken': 'token Templater não resolvido (forma não suportada, possivelmente multi-linha): {fragment}{ellipsis}',
    'template.unsupportedExpr': 'expressão Templater não suportada: <% {expr} %>',
    'write.raceOnCreate': '{relPath} passou a existir enquanto a nota era escrita; nada foi sobrescrito',
    'edit.emptySnippet': 'trecho vazio para edição em {path}',
    'edit.ambiguous': 'trecho ambíguo em {path}: {occurrences} ocorrências',
    'edit.notFound': 'trecho não encontrado em {path}',
    'lock.timeout': 'outro processo está escrevendo no vault há mais de {ms} ms (pid {pid}); nada foi escrito',
    'lock.failed': 'não foi possível criar o lock do vault: {detail}',
    'list.offsetPastEnd': 'offset {offset} além do fim: há {total} nota(s) com esses filtros',
    'layout.invalid': '.vault-mcp.json inválido: {detail}',
  },

  errors: {
    invalidInput: 'entrada inválida para',
    toolFailed: 'falhou',
    unknownTool: 'tool desconhecida, ou não publicada por este servidor',
    outputInvalid: 'a resposta não obedece ao schema de saída publicado; nada foi devolvido',
  },

  validation: {
    requiredField: 'campo obrigatório',
    wrongType: 'esperado {expected}, recebido {received}',
    queryEmpty: 'query não pode ser vazia',
    pathEmpty: 'caminho não pode ser vazio',
    oldTextEmpty: 'old_text não pode ser vazio',
    tooLong: 'no máximo {max} caracteres',
    unknownArgument: 'argumento desconhecido: {keys}',
    aliasConflict: '`{legacy}` e `{canonical}` vieram com valores diferentes; use só `{canonical}`',
    titleEmpty: 'título não pode ser vazio',
    insightEmpty: 'insight não pode ser vazio',
    contextEmpty: 'contexto não pode ser vazio',
    fromEmpty: 'caminho de origem não pode ser vazio',
    toEmpty: 'caminho de destino não pode ser vazio',
    domainEmpty: 'domínio não pode ser vazio',
  },

  tools: {
    vault_search: {
      displayName: 'Buscar no vault',
      description:
        'Busca semântica-lexical no vault (BM25 + um salto de wiki-links). Chame antes de responder ' +
        'qualquer pergunta sobre decisões, padrões, gotchas ou histórico do usuário, e antes de gravar ' +
        'um aprendizado novo. Devolve trechos já citados como `caminho:linha` — repita essa citação na ' +
        'resposta ao usuário. Notas de `01-raw/` ficam de fora salvo include_raw.',
      query: 'Termos de busca em linguagem natural.',
      limit: 'Máximo de trechos devolvidos (padrão 6).',
      type: 'Filtra pelo `tipo` do frontmatter: wiki, moc, projeto, daily.',
      folder: 'Restringe a uma pasta do vault, ex.: `02-wiki/nestjs`.',
      tags: 'Filtra por tags do frontmatter. A nota tem de ter TODAS; a caixa não importa.',
      status: 'Filtra por `status` do frontmatter, ex.: `ativo`.',
      include_raw: 'Inclui `01-raw/` (captura crua), fora dos resultados por padrão.',
    },
    vault_get_note: {
      displayName: 'Ler uma nota',
      description:
        'Lê uma nota inteira pelo caminho relativo ao vault (ex.: `02-wiki/nestjs/auth-guard.md`), com ' +
        'frontmatter, links resolvidos e links quebrados. Use depois de vault_search quando o trecho ' +
        'não bastar, ou antes de editar a nota.',
      path: 'Caminho relativo ao vault, com `.md`.',
      offset:
        'Primeiro caractere do CORPO a devolver, para ler uma nota que não coube numa resposta ' +
        'só. Omita na primeira chamada; depois use o offset que a marca de corte anuncia.',
    },
    vault_list: {
      displayName: 'Listar notas',
      description:
        'Lista notas por metadado — tipo, tags, status, pasta — sem olhar o conteúdo. Use para ' +
        'inventário ("quais projetos ativos existem?", "quais notas têm a tag jwt?"), não para buscar ' +
        'assunto: para assunto use vault_search.',
      type: '`tipo` do frontmatter: wiki, moc, projeto, daily.',
      tags: 'Todas estas tags precisam estar na nota.',
      status: '`status` do frontmatter, ex.: ativo, pausado.',
      folder: 'Pasta do vault, casada em fronteira de segmento.',
      limit: 'Máximo de notas devolvidas (padrão 200, até 1000). A resposta diz o total e de onde continuar.',
      offset: 'Quantas notas pular, em ordem de caminho. Use o valor que a resposta anterior anunciou.',
    },
    vault_backlinks: {
      displayName: 'Notas que apontam para uma nota',
      description:
        'Lista as notas que apontam para a nota informada. Use para medir o quanto um assunto está ' +
        'conectado, achar o MOC que indexa a nota, ou avaliar o impacto de mudar/renomear uma nota.',
      path: 'Caminho relativo ao vault, com `.md`.',
    },
    vault_graph: {
      displayName: 'Grafo de links',
      description:
        'Devolve o grafo de wiki-links do vault: as notas como nós (caminho, título, tipo, status, ' +
        'tags, área, domínio, graus) e os links entre elas como arestas, também como dado estruturado ' +
        'para um cliente que desenha o grafo. Use para uma visão geral de como as notas se conectam ' +
        '(órfãs, aglomerados, o que um filtro abrange), não para responder pergunta: para assunto use ' +
        'vault_search, e para quem aponta para UMA nota use vault_backlinks. Os filtros escolhem os ' +
        'nós, e uma aresta só vem quando as duas pontas vêm.',
      folder: 'Pasta do vault, casada em fronteira de segmento, como em vault_list.',
      type: '`tipo` do frontmatter: wiki, moc, projeto, daily.',
      tags: 'Todas estas tags precisam estar na nota; a caixa não importa.',
      status: '`status` do frontmatter, ex.: ativo, pausado.',
      include_raw: 'Inclui `01-raw/` (captura crua), fora do grafo por padrão.',
      include_broken: 'Inclui a lista de links quebrados (alvo cru) das notas devolvidas.',
      max_nodes:
        'Máximo de notas devolvidas, em ordem de caminho (padrão 2000, até 5000); ' +
        'acima disso a resposta vem marcada como truncada.',
    },
    vault_status: {
      displayName: 'Estado do servidor e do vault',
      description:
        'Diz o estado do servidor e do vault: versão, quantas notas e chunks estão indexados, se o ' +
        'vault é um repositório git, o branch, os commits ainda não enviados, os commits que ' +
        'falharam e serão refeitos, e quem segura o lock de escrita. Use antes de uma sessão de ' +
        'escrita, ou depois de uma escrita responder "Commit: não", para saber se algo ficou para ' +
        'trás. Não muda nada.',
    },
    vault_write_note: {
      displayName: 'Escrever uma nota',
      description:
        'Cria ou substitui uma nota inteira, com frontmatter garantido, e commita no git do vault. ' +
        'Substitui o arquivo inteiro: para mudar um trecho use vault_edit_note, e para registrar um ' +
        'aprendizado use vault_learn, que decide o destino e propaga sozinho.',
      path: 'Caminho relativo ao vault, com `.md`.',
      content: 'Conteúdo markdown da nota, sem o bloco de frontmatter.',
      frontmatter: 'Campos do frontmatter, ex.: `{ "tipo": "wiki", "tags": ["jwt"] }`.',
    },
    vault_edit_note: {
      displayName: 'Editar um trecho de uma nota',
      description:
        'Substitui UM trecho exato de uma nota existente e commita. Falha, sem escrever, se o trecho ' +
        'não aparecer ou aparecer mais de uma vez — nesse caso mande mais contexto em old_text.',
      path: 'Caminho relativo ao vault, com `.md`.',
      old_text: 'Trecho exato a substituir; precisa ser único na nota.',
      new_text: 'Texto que entra no lugar.',
    },
    vault_learn: {
      displayName: 'Registrar um aprendizado',
      description:
        'Registra um aprendizado no vault. Chame sempre que, durante a sessão, aparecer algo não óbvio ' +
        'e reutilizável — uma decisão de arquitetura, um pattern, um gotcha, uma armadilha de ' +
        'configuração —, sem perguntar antes onde salvar: o servidor decide sozinho entre anexar à nota ' +
        'existente que já cobre o assunto e criar uma nota nova (o viés é criar), e propaga sozinho para ' +
        'o MOC do domínio e para a nota diária (e para o índice de conhecimento quando o domínio é ' +
        'novo), tudo em um único commit. ' +
        'Mostre ao usuário o diff devolvido.',
      title: 'Título curto do aprendizado; vira o nome do arquivo.',
      insight: 'O aprendizado em si, em markdown.',
      context: 'Onde e por que isso apareceu.',
      domain:
        'Domínio em `02-wiki/`, ex.: nestjs, docker, patterns. Um domínio novo exige confirm_new_domain.',
      project:
        'Nome do projeto em `03-projects/` a que o aprendizado pertence; entra na linha de captura da nota diária.',
      tags: 'Tags do frontmatter da nota.',
      links: 'Wiki-links relacionados, sem os colchetes.',
      confirm_new_domain: 'Confirma a criação de um domínio que ainda não existe em `02-wiki/`.',
    },
    vault_move: {
      displayName: 'Mover ou renomear uma nota',
      description:
        'Move, renomeia, promove ou arquiva uma nota, corrigindo sozinho todo link que passaria a ' +
        'apontar para outro lugar, migrando a entrada dela entre os MOCs de domínio e commitando tudo ' +
        'de uma vez. `to` é o caminho completo com `.md`, então as quatro operações são a mesma: ' +
        '`01-raw/inbox/rascunho.md` → `02-wiki/nestjs/auth-guard.md` promove, renomeia e troca de ' +
        'domínio junto. `99-archive/` vale como origem E destino, o que dá arquivar e desarquivar. ' +
        'Um domínio de destino sem MOC exige confirm_new_domain. Mostre ao usuário o diff devolvido.',
      from: 'Caminho atual da nota, relativo ao vault, com `.md`.',
      to: 'Caminho completo de destino, relativo ao vault, com `.md`. Mover, renomear e promover são a mesma operação.',
      confirm_new_domain: 'Confirma a criação do MOC de um domínio de destino que ainda não tem um.',
    },
    vault_delete: {
      displayName: 'Apagar uma nota',
      description:
        'Apaga uma nota e commita, tirando a linha dela do MOC do domínio. Recusa, sem apagar, se a ' +
        'nota não tiver versão commitada no HEAD (aí não haveria como desfazer), se ela for estrutural ' +
        '(MOC, nota diária, índice) ou se ela estiver em `99-archive/`. Notas apontadas por outras ' +
        'exigem confirm, e a recusa lista quem aponta — os links delas ficarão quebrados. A resposta ' +
        'traz o comando exato que desfaz.',
      path: 'Caminho relativo ao vault, com `.md`.',
      confirm: 'Confirma apagar mesmo com outras notas apontando para esta; os links delas ficam quebrados.',
    },
  },
} as const;

/** A forma do catálogo, ditada pelo português. Ver o comentário de `PT`. */
export type Messages = {
  -readonly [K in keyof typeof PT]: typeof PT[K] extends string
    ? string
    : { -readonly [K2 in keyof typeof PT[K]]: typeof PT[K][K2] extends string
        ? string
        : { -readonly [K3 in keyof typeof PT[K][K2]]: string } };
};

const EN: Messages = {
  instructions:
    'Knowledge vault server. Search before answering anything about the user\'s decisions, ' +
    'patterns or history, always cite `path:line`, and record learnings with vault_learn.',

  phrases: {
    gitAddFailed: 'failed to add files to git: ',
    gitNothingChanged: 'nothing to commit: the files are unchanged',
    gitNothingGiven: 'nothing to commit: no file was given',
    gitDiffFailed: 'failed to check for changes in git: ',
    gitCommitFailed: 'commit failed: ',
    gitPending: 'the commit is pending and will be retried on the next write',
    gitNotARepo: 'the vault is not a git repository: the note was saved, but not versioned',
    gitMissing: 'git was not found on PATH: the note was saved, but not versioned',
    pushFailed: 'committed, but the push failed: ',
    pushFailedAdvice:
      '. The note is saved and committed locally; nothing was undone and no rebase was attempted. ' +
      'If the remote moved ahead, resolve it with a pull in the vault before the next push.',
    pushTimedOutHead: 'the push went past ',
    pushTimedOutTail: ' ms and was stopped',
    writeOverranHead: 'an earlier write went past ',
    writeOverranTail:
      ' ms and may still be running; this call had no guaranteed exclusion against it',
    lockLost:
      'the vault lock was taken over by another process during this write; ' +
      'exclusion against it was not guaranteed',
    noMatch: 'no match',
    topOutside: 'the top hit is outside ',
    topViaGraph: 'the top hit came in through graph expansion, not a direct match',
    topNotStandingOut: 'the top hit does not stand out (ratio ',
    similarElsewhere: 'a similar note exists in another domain: ',
    duplicateOf: 'duplicate of ',
    noteExistsAt: '; a note already exists at ',
    appendedToIt: ', appended to it',
    appendedAt: 'appended to ',
    appendedByTitle: ' because the title matched; the duplicate check did not point at this note (',
    appendedByTitleAdvice: ') — check that the subject is the same',
    cannotAppend: 'could not append to ',
    recordedIn: '; learning recorded in ',
    insightTruncatedHead: 'insight truncated at ',
    insightTruncatedTail: ' characters for the duplicate check',
    templateIgnored: 'template ignored: ',
    templateIgnoredTail: ' is not a regular file',
    templateNotFound: 'template not found: ',
    frontmatterUnfilled: 'frontmatter not filled in (the YAML block cannot be edited safely): ',
    diffUnavailable: 'the diff could not be generated (',
    propagateDomainFailed: 'failed to propagate domain ',
    propagateFailed: 'failed to propagate to ',
    rewriteFailed: 'failed to rewrite ',
    updateFailed: 'failed to update ',
    uncommittedEdits:
      ' has uncommitted edits; restoring brings back the committed version, not what is on disk now',
    indexMissing: ' does not exist; the new domain was not indexed',
    linkPointedTo: ' pointed to ',
    linkNotRewritten: ' and could not be rewritten to ',
  },

  startup: {
    vaultPathMissing:
      'VAULT_PATH is not set: point it at the vault\'s root folder, e.g. ' +
      'VAULT_PATH="/absolute/path/to/vault" npx @andreymudri/vault-mcp ' +
      '(from a clone: node /absolute/path/to/vault-mcp/dist/server/index.js)',
    vaultPathUnreadable: 'VAULT_PATH could not be read',
    vaultPathNotDirectory: 'VAULT_PATH is not a directory',
    startFailed: 'vault-mcp failed to start',
  },

  results: {
    viaGraph: 'via graph',
    snippetTruncated: 'snippet truncated',
    citePreambleTail: 'never vault content.',
    similarTerms: 'Similar terms found in the vault',
    noteTruncated: 'note cut at {max} of {total} characters; continue with offset: {next}',
    noteSliceFrom: 'slice starting at character {offset} of {total}',
    diagnosticsHeader: '{count} file(s) with an indexing problem',
    diagnosticsMore: '… and {count} more',
    notesCount: 'note(s)',
    notesPointTo: 'note(s) point to',
    propagatedTo: 'Propagated to',
    tagsScalarOnly: 'frontmatter.tags only accepts text or numbers; remove lists and objects',
    yes: 'yes',
    no: 'no',
    commit: 'Commit',
    push: 'Push',
    warning: 'Warning',
    diff: 'Diff',
    diffShowUser: 'Diff (show this to the user)',
    noContentChange: '(no content change)',
    empty: '(empty)',
    nothing: '(nothing)',
    none: '(none)',
    linksFixedIn: 'Links fixed in',
    mocIndexUpdated: 'MOC/index updated',
    undoFromVault: 'To undo, from inside the vault',
    noResultsFor: 'No results for',
    resultsFor: 'result(s) for',
    citePreamble:
      'Cite `path:line` when using any snippet below. ' +
      'Each snippet from a note is prefixed with `> `; lines without that prefix come from this server, ',
    frontmatter: 'Frontmatter',
    links: 'Links',
    brokenLinks: 'Broken links',
    noNotesMatchingFilters: 'No notes match those filters.',
    noNotesPointTo: 'No notes point to',
    graphSummary: '{notes} note(s), {edges} link(s), {orphans} orphan(s).',
    noteCreated: 'Note created',
    noteReplaced: 'Note replaced',
    noteEdited: 'Note edited',
    noteMoved: 'Note moved',
    noteDeleted: 'Note deleted',
    learnedNewNote: 'Learning recorded in a NEW note',
    learnedAppended: 'Learning APPENDED to the existing note',
    reason: 'Reason',
    recoveredCommits: 'Pending commits recovered',
    diffTruncated: 'diff cut at {max} of {total} characters; what was written is whole in the vault',
    listPage: 'notes {from}–{to} of {total}; continue with offset: {next}',
    listLastPage: 'notes {from}–{to} of {total}',
    droppedCommits: 'Pending commits given up on',
  },

  status: {
    vault: 'Vault: {notes} note(s), {chunks} chunk(s) indexed, {diagnostics} file(s) with an indexing problem',
    repositoryBranch: 'Repository: yes, branch {branch}',
    repositoryDetached: 'Repository: yes, detached HEAD (new commits land on no branch)',
    repositoryNone: 'Repository: no (notes are saved without version control)',
    upstream: 'Upstream: {ahead} ahead, {behind} behind',
    upstreamNone: 'Upstream: (none)',
    pending: 'Pending commits: {count}',
    pendingItem: '{at} (attempt {attempts}): {message}',
    lockFree: 'Vault lock: free',
    lockHeld: 'Vault lock: pid {pid} on {host}, since {at}',
    autoPushOn: 'Auto-push: on',
    autoPushOff: 'Auto-push: off',
    modeReadOnly: 'Mode: read-only (no write tool is published)',
    modeReadWrite: 'Mode: read and write',
  },

  errorCodes: {
    'tags.scalarOnly': 'frontmatter.tags only accepts text or numbers; remove lists and objects',
    'hint.hardLinks': 'the file has {nlink} hard links pointing at the same inode (a `cp -al` copy or a backup snapshot does that), so writing to it would change every copy at once',
    'domain.empty': 'empty domain',
    'domain.tooLong': 'domain too long',
    'domain.controlChar': 'domain contains a control character',
    'domain.hasSpace': 'domain cannot contain a space',
    'domain.hasSeparator': 'domain cannot contain a path separator',
    'domain.startsWithDot': 'domain cannot start with a dot',
    'domain.badChar': 'domain contains a disallowed character',
    'note.notFound': 'note not found: {path}',
    'diag.frontmatterInvalid': 'invalid frontmatter: {detail}',
    'diag.hardLink':
      'left out of the index: it is a hard link (nlink > 1), so its content may live outside '
      + 'the vault. Replace it with a real copy (`cp --reflink=never`) to index it.',
    'diag.statFailed': 'left out of the index: could not read its metadata: {detail}',
    'diag.readFailed': 'left out of the index: could not read the file: {detail}',
    'diag.readdirFailed': 'could not list the directory: {detail}',
    'diag.tooLarge': 'left out of the index: {size} bytes, above the limit of {max} (VAULT_MAX_NOTE_BYTES)',
    'diag.binary': 'left out of the index: the file has a NUL byte, it is not text',
    'diag.symlink': 'left out of the index: it is a symlink, and its target may live outside the vault',
    'note.offsetPastEnd': 'offset {offset} past the end of {path}: the note has {total} characters',
    'atomic.tmpOutsideDir': 'temporary file outside the destination directory: {tmpPath}',
    'atomic.tmpCreateFailed': 'could not create a temporary file in {dir}',
    'learn.noFreeName': 'no free name for the note in {prefix}{dominio}/: 100 variants already exist',
    'learn.badTitle': 'invalid title: it does not produce a filename (use letters or digits)',
    'learn.insightStartsWithDelimiter': 'insight cannot start with the frontmatter delimiter `---`: it would become the note\u2019s frontmatter. Write at least one line of text before the block.',
    'learn.badDomain': 'invalid domain: {problem}',
    'learn.unknownDomain': "domain '{dominio}' does not exist under 02-wiki/. Valid domains: {validos}. Retry with confirm_new_domain to create it.",
    'path.mustEndMd': 'path must end in .md: {relPath}',
    'path.mustBeRelative': 'path must be relative to the vault: {relPath}',
    'path.noGlob': 'path cannot contain a glob metacharacter: {relPath}',
    'path.outsideVault': 'path is outside the vault: {relPath}',
    'path.readOnlyArea': 'write denied in {head}/ (read-only)',
    'path.rootMissing': 'vault root missing or unreadable: {root} ({detail})',
    'path.symlinkEscapes': 'symlink would point outside the vault: {abs}',
    'path.noControlChar': 'path cannot contain a control character: {relPath}',
    'path.internalArea': 'write denied in {segment}/ (internal area, not content)',
    'path.notARegularFile': 'target is not a regular file (link, directory or device)',
    'path.notANote': 'path is not a note (link, directory or device): {relPath}',
    'path.nameTooLong': 'name too long: {bytes} bytes in "{name}", at most {max}',
    'relocate.samePath': 'source and destination are the same path: {fromRel}',
    'relocate.sourceNotANote': 'source is not a note: {fromRel}',
    'relocate.destExists': 'destination already exists: {toRel}',
    'relocate.newDomainNeedsConfirm': '{toDomain} has no MOC under 02-wiki/ yet; pass confirm_new_domain to create it',
    'relocate.raceOnMove': '{toRel} came into existence while the note was being moved; nothing was overwritten',
    'relocate.noteNotFound': 'note not found: {relPath}',
    'relocate.structuralNote': '{relPath} is a structural note ({tipo}) and is not deleted through here',
    'relocate.noHeadVersion': '{relPath} has no committed version in HEAD, so deleting it is irreversible; commit the note first, or delete it outside the MCP{detail}',
    'relocate.hasBacklinks': '{count} note(s) point at {relPath} and their links will break: {list}; pass confirm to delete anyway',
    'template.unresolvedToken': 'unresolved Templater token (unsupported shape, possibly multi-line): {fragment}{ellipsis}',
    'template.unsupportedExpr': 'unsupported Templater expression: <% {expr} %>',
    'write.raceOnCreate': '{relPath} came into existence while the note was being written; nothing was overwritten',
    'edit.emptySnippet': 'empty snippet for editing in {path}',
    'edit.ambiguous': 'ambiguous snippet in {path}: {occurrences} occurrences',
    'edit.notFound': 'snippet not found in {path}',
    'lock.timeout': 'another process has been writing to the vault for more than {ms} ms (pid {pid}); nothing was written',
    'lock.failed': 'could not create the vault lock: {detail}',
    'list.offsetPastEnd': 'offset {offset} is past the end: {total} note(s) match these filters',
    'layout.invalid': '.vault-mcp.json is invalid: {detail}',
  },

  errors: {
    invalidInput: 'invalid input for',
    toolFailed: 'failed',
    unknownTool: 'unknown tool, or one this server does not publish',
    outputInvalid: 'the answer does not match the published output schema; nothing was returned',
  },

  validation: {
    requiredField: 'required field',
    wrongType: 'expected {expected}, received {received}',
    queryEmpty: 'query cannot be empty',
    pathEmpty: 'path cannot be empty',
    oldTextEmpty: 'old_text cannot be empty',
    tooLong: 'at most {max} characters',
    unknownArgument: 'unknown argument: {keys}',
    aliasConflict: '`{legacy}` and `{canonical}` were sent with different values; use only `{canonical}`',
    titleEmpty: 'title cannot be empty',
    insightEmpty: 'insight cannot be empty',
    contextEmpty: 'context cannot be empty',
    fromEmpty: 'source path cannot be empty',
    toEmpty: 'destination path cannot be empty',
    domainEmpty: 'domain cannot be empty',
  },

  tools: {
    vault_search: {
      displayName: 'Search the vault',
      description:
        'Lexical-semantic search over the vault (BM25 plus one wiki-link hop). Call it before ' +
        'answering any question about the user\'s decisions, patterns, gotchas or history, and before ' +
        'recording a new learning. Returns snippets already cited as `path:line` — repeat that ' +
        'citation in your answer. Notes under `01-raw/` are excluded unless include_raw.',
      query: 'Search terms in natural language.',
      limit: 'Maximum snippets returned (default 6).',
      type: 'Filter by the frontmatter `tipo`: wiki, moc, projeto, daily.',
      folder: 'Restrict to a vault folder, e.g. `02-wiki/nestjs`.',
      tags: 'Filters by frontmatter tags. A note must carry ALL of them; case does not matter.',
      status: 'Filters by the frontmatter `status`, e.g. `ativo`.',
      include_raw: 'Include `01-raw/` (unvetted capture), left out of results by default.',
    },
    vault_get_note: {
      displayName: 'Read a note',
      description:
        'Reads a whole note by its vault-relative path (e.g. `02-wiki/nestjs/auth-guard.md`), with ' +
        'frontmatter, resolved links and broken links. Use it after vault_search when the snippet is ' +
        'not enough, or before editing the note.',
      path: 'Vault-relative path, with `.md`.',
      offset:
        'First character of the BODY to return, for reading a note that did not fit in one ' +
        'answer. Omit it on the first call; afterwards use the offset the cut marker announces.',
    },
    vault_list: {
      displayName: 'List notes',
      description:
        'Lists notes by metadata — tipo, tags, status, folder — without looking at content. Use it for ' +
        'inventory ("which projects are active?", "which notes carry the jwt tag?"), not to search by ' +
        'subject: for subject use vault_search.',
      type: 'Frontmatter `tipo`: wiki, moc, projeto, daily.',
      tags: 'Every one of these tags must be on the note.',
      status: 'Frontmatter `status`, e.g. ativo, pausado.',
      folder: 'Vault folder, matched on a segment boundary.',
      limit: 'Maximum notes returned (default 200, up to 1000). The answer gives the total and where to continue.',
      offset: 'How many notes to skip, in path order. Use the value the previous answer announced.',
    },
    vault_backlinks: {
      displayName: 'Notes linking to a note',
      description:
        'Lists the notes pointing at the given note. Use it to gauge how connected a subject is, to ' +
        'find the MOC that indexes the note, or to weigh the impact of changing or renaming it.',
      path: 'Vault-relative path, with `.md`.',
    },
    vault_graph: {
      displayName: 'Link graph',
      description:
        'Returns the vault\'s wiki-link graph: notes as nodes (path, title, tipo, status, tags, area, ' +
        'domain, degrees) and the links between them as edges, also as structured data for a client ' +
        'that draws the graph. Use it for an overview of how notes connect (orphans, clusters, what a ' +
        'filter covers), not to answer a question: for a subject use vault_search, and for who points ' +
        'at ONE note use vault_backlinks. Filters pick the nodes, and an edge comes back only when ' +
        'both of its ends do.',
      folder: 'Vault folder, matched on a segment boundary, as in vault_list.',
      type: 'Frontmatter `tipo`: wiki, moc, projeto, daily.',
      tags: 'Every one of these tags must be on the note; case does not matter.',
      status: 'Frontmatter `status`, e.g. ativo, pausado.',
      include_raw: 'Include `01-raw/` (unvetted capture), left out of the graph by default.',
      include_broken: 'Include the list of broken links (raw target) of the returned notes.',
      max_nodes:
        'Maximum notes returned, in path order (default 2000, up to 5000); ' +
        'beyond that the answer is marked as truncated.',
    },
    vault_status: {
      displayName: 'Server and vault status',
      description:
        'Reports the state of the server and of the vault: version, how many notes and chunks are ' +
        'indexed, whether the vault is a git repository, the branch, commits not pushed yet, ' +
        'commits that failed and will be retried, and who holds the write lock. Use it before a ' +
        'writing session, or after a write answered "Commit: no", to learn whether anything was ' +
        'left behind. Changes nothing.',
    },
    vault_write_note: {
      displayName: 'Write a note',
      description:
        'Creates or replaces a whole note, with frontmatter guaranteed, and commits it to the vault\'s ' +
        'git. It replaces the entire file: to change one passage use vault_edit_note, and to record a ' +
        'learning use vault_learn, which picks the destination and propagates on its own.',
      path: 'Vault-relative path, with `.md`.',
      content: 'The note\'s markdown body, without the frontmatter block.',
      frontmatter: 'Frontmatter fields, e.g. `{ "tipo": "wiki", "tags": ["jwt"] }`.',
    },
    vault_edit_note: {
      displayName: 'Edit a passage of a note',
      description:
        'Replaces ONE exact passage of an existing note and commits. Fails, without writing, if the ' +
        'passage does not appear or appears more than once — in that case send more context in old_text.',
      path: 'Vault-relative path, with `.md`.',
      old_text: 'The exact passage to replace; it must be unique within the note.',
      new_text: 'The text that takes its place.',
    },
    vault_learn: {
      displayName: 'Record a learning',
      description:
        'Records a learning in the vault. Call it whenever something non-obvious and reusable comes up ' +
        'during the session — an architecture decision, a pattern, a gotcha, a configuration trap — ' +
        'without asking first where to save it: the server decides on its own between appending to the ' +
        'existing note that already covers the subject and creating a new one (the bias is to create), ' +
        'and propagates on its own to the domain MOC and the daily note (and to the knowledge index when ' +
        'the domain is new), all in a single commit. ' +
        'Show the returned diff to the user.',
      title: 'Short title for the learning; it becomes the filename.',
      insight: 'The learning itself, in markdown.',
      context: 'Where and why this came up.',
      domain:
        'Domain under `02-wiki/`, e.g. nestjs, docker, patterns. A new domain requires confirm_new_domain.',
      project:
        'Name of the project under `03-projects/` this learning belongs to; it goes into the daily note\'s capture line.',
      tags: 'Tags for the note\'s frontmatter.',
      links: 'Related wiki-links, without the brackets.',
      confirm_new_domain: 'Confirms creating a domain that does not yet exist under `02-wiki/`.',
    },
    vault_move: {
      displayName: 'Move or rename a note',
      description:
        'Moves, renames, promotes or archives a note, fixing on its own every link that would otherwise ' +
        'start pointing somewhere else, migrating its entry between domain MOCs and committing it all at ' +
        'once. `to` is the full path with `.md`, so the four operations are one: ' +
        '`01-raw/inbox/rascunho.md` → `02-wiki/nestjs/auth-guard.md` promotes, renames and changes ' +
        'domain together. `99-archive/` counts as BOTH source and destination, which gives you archive ' +
        'and unarchive. A destination domain with no MOC requires confirm_new_domain. Show the ' +
        'returned diff to the user.',
      from: 'The note\'s current vault-relative path, with `.md`.',
      to: 'Full destination path, vault-relative, with `.md`. Moving, renaming and promoting are the same operation.',
      confirm_new_domain: 'Confirms creating the MOC of a destination domain that does not have one yet.',
    },
    vault_delete: {
      displayName: 'Delete a note',
      description:
        'Deletes a note and commits, removing its line from the domain MOC. Refuses, without deleting, ' +
        'if the note has no committed version in HEAD (there would be no way to undo), if it is ' +
        'structural (MOC, daily note, index) or if it lives under `99-archive/`. Notes pointed at by ' +
        'others require confirm, and the refusal lists who points at them — their links will break. The ' +
        'answer carries the exact command that undoes it.',
      path: 'Vault-relative path, with `.md`.',
      confirm: 'Confirms deleting even with other notes pointing at this one; their links will break.',
    },
  },
};

const CATALOGS: Record<Lang, Messages> = { pt: PT as unknown as Messages, en: EN };

/** O catálogo do idioma pedido. */
export function messagesFor(lang: Lang): Messages {
  // Fallback e não indexação crua: `createVaultServer` é entrypoint EXPORTADO de um pacote
  // publicado e tipa `lang` como `Lang`, o que o TypeScript garante só de dentro. Um chamador em
  // JS puro passando `'fr'` fazia isto devolver `undefined` e o servidor morrer com um TypeError
  // em `instructions` — degradar é a política que `resolveLang` já documenta para o mesmo valor,
  // e a camada de i18n passa a ser incapaz de lançar.
  return CATALOGS[lang] ?? CATALOGS.en;
}
