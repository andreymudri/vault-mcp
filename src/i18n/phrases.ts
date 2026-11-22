/**
 * The fixed text of every warning and every reason the write layer produces.
 *
 * These were the declared exception of `lang.ts`: a commit that failed, a push that was rejected,
 * a template that was missing, the `Reason` with which `vault_learn` explains where it filed a
 * learning — all of them came out in Portuguese inside an English answer. They are not errors with
 * a code, they are sentences assembled in four modules and joined with `; `, so a code per warning
 * does not survive the join.
 *
 * What does survive it is the text itself. Each fixed fragment lives HERE under a key, the write
 * layer builds its sentences from these constants and from nothing else, and the tool boundary
 * swaps every fragment for the one under the same key in the catalog of the language it speaks
 * (`translatePhrases`). The write layer still knows no language — it writes what it always wrote —
 * and the two sides cannot drift, because the English table is typed by this one's keys.
 *
 * Word order is the limit of the scheme: a fragment is replaced where it stands, so the English
 * sentence takes its variable parts in the order the Portuguese one has them.
 */
export const PHRASES = {
  // git
  gitAddFailed: 'falha ao adicionar arquivos ao git: ',
  gitNothingChanged: 'nada a commitar: arquivos sem alteração',
  gitNothingGiven: 'nada a commitar: nenhum arquivo informado',
  gitDiffFailed: 'falha ao verificar alterações no git: ',
  gitCommitFailed: 'falha ao commitar: ',
  gitPending: 'o commit ficou pendente e será refeito na próxima escrita',
  gitNotARepo: 'o vault não é um repositório git: a nota foi salva, mas não versionada',
  gitMissing: 'o git não foi encontrado no PATH: a nota foi salva, mas não versionada',
  pushFailed: 'commit feito, mas o push falhou: ',
  pushFailedAdvice:
    '. A nota está salva e commitada localmente; nada foi desfeito e nenhum rebase foi tentado. ' +
    'Se o remote andou na frente, resolva com um pull no vault antes do próximo push.',
  pushTimedOutHead: 'o push passou de ',
  pushTimedOutTail: ' ms e foi encerrado',
  // exclusion
  writeOverranHead: 'uma escrita anterior passou de ',
  writeOverranTail:
    ' ms e pode ainda estar em andamento; esta chamada não teve exclusão garantida contra ela',
  lockLost:
    'o lock do vault foi tomado por outro processo durante esta escrita; ' +
    'a exclusão contra ele não foi garantida',
  // vault_learn: why a learning was filed where it was
  noMatch: 'nenhum match',
  topOutside: 'topo fora de ',
  topViaGraph: 'topo entrou por expansão do grafo, não por match direto',
  topNotStandingOut: 'topo não se destaca (razão ',
  similarElsewhere: 'nota parecida em outro domínio: ',
  duplicateOf: 'duplicata de ',
  noteExistsAt: '; nota já existe em ',
  appendedToIt: ', anexado nela',
  appendedAt: 'anexado em ',
  appendedByTitle: ' por coincidência de título; a checagem de duplicata não indicou essa nota (',
  appendedByTitleAdvice: ') — confira se o assunto é o mesmo',
  cannotAppend: 'não foi possível anexar em ',
  recordedIn: '; aprendizado gravado em ',
  insightTruncatedHead: 'insight truncado em ',
  insightTruncatedTail: ' caracteres para a checagem de duplicata',
  // templates and frontmatter
  templateIgnored: 'template ignorado: ',
  templateIgnoredTail: ' não é um arquivo comum',
  templateNotFound: 'template não encontrado: ',
  frontmatterUnfilled: 'frontmatter não preenchido (bloco YAML não editável com segurança): ',
  diffUnavailable: 'diff não pôde ser gerado (',
  // propagation, move, delete
  propagateDomainFailed: 'falha ao propagar domínio ',
  propagateFailed: 'falha ao propagar ',
  rewriteFailed: 'falha ao reescrever ',
  updateFailed: 'falha ao atualizar ',
  uncommittedEdits:
    ' tem edições não commitadas; restaurar traz de volta a versão commitada, não o que está em disco agora',
  indexMissing: ' não existe; o domínio novo não foi indexado',
  linkPointedTo: ' apontava para ',
  linkNotRewritten: ' e não pôde ser reescrito para ',
} as const;

export type PhraseKey = keyof typeof PHRASES;

/** Longest first, so a fragment that is the beginning of another is not replaced inside it. */
const KEYS_LONGEST_FIRST = (Object.keys(PHRASES) as PhraseKey[]).sort(
  (a, b) => PHRASES[b].length - PHRASES[a].length,
);

/**
 * `text` with every fragment of `PHRASES` replaced by the one under the same key in `phrases`.
 *
 * Handed the Portuguese table itself it returns the text untouched, which is what keeps the
 * Portuguese server byte-identical to what it was.
 */
export function translatePhrases(text: string, phrases: Readonly<Record<PhraseKey, string>>): string {
  if (phrases === PHRASES) return text;
  let out = text;
  for (const key of KEYS_LONGEST_FIRST) {
    const from = PHRASES[key];
    if (out.includes(from)) out = out.split(from).join(phrases[key]);
  }
  return out;
}
