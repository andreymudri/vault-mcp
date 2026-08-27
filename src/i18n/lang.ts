/**
 * O idioma em que o servidor FALA — e a fronteira, que é a parte que importa.
 *
 * Três famílias de texto saem daqui, e só a primeira é traduzível:
 *
 * - **O que o servidor DIZ como interface**, e é isto que `VAULT_LANG` controla: descrição das
 *   tools e dos campos, recusa de entrada (invólucro E conteúdo), erro de start, rótulos do
 *   resultado (Commit/Push/Aviso/Diff, cabeçalhos, listas vazias, manchetes) e os ERROS LANÇADOS
 *   pela camada de escrita, que chegam por CÓDIGO e são resolvidos na fronteira da tool — ver
 *   `errors.ts`. Vale a pena traduzir porque a descrição da tool é o que o MODELO lê para decidir
 *   se chama a tool, e porque quem esquece a VAULT_PATH recebe a única mensagem que precisava ler.
 *
 * - **O que o servidor ESCREVE no vault**, que NÃO é traduzível e não é questão de gosto: assunto
 *   de commit (`docs(vault): atualizar X`) e nome de seção (`## Notas`, `## Domínios`,
 *   `## Capturas`). `insertUnderSection` procura o nome da seção DENTRO DO ARQUIVO DO USUÁRIO:
 *   traduzir `'## Notas'` para `'## Notes'` num vault cujo MOC diz `## Notas` não acha a seção,
 *   ANEXA uma segunda, e quebra em silêncio a idempotência que impede o MOC de ganhar uma linha
 *   repetida a cada captura. O assunto de commit tem o mesmo problema com outro nome: ele entra
 *   no histórico de git do usuário, que é do vault e não de quem está lendo.
 *
 * - **AVISOS e DIAGNÓSTICOS, que continuam em português por ora** e são a exceção declarada:
 *   falhas de push e de commit (`git.ts`), avisos de mover/reescrever links (`relocate.ts`,
 *   `rewrite-links.ts`), e o `Motivo:` com que `vault_learn` explica ter anexado em vez de criado.
 *   Não é esquecimento: `writer.ts` funde até três avisos de origens diferentes numa string só
 *   (`joinWarnings`), então um código por aviso não sobrevive à fusão — traduzi-los exige
 *   reestruturar os arrays de aviso de quatro módulos, e parte deles é ANÁLISE (o `Motivo:` é
 *   prosa sobre o conteúdo do vault) e não rótulo de interface. Está aqui escrito para o próximo
 *   leitor saber que a fronteira é esta, e não descobrir por acidente.
 *
 * Resumo: o idioma da INTERFACE é do leitor; o idioma do CONTEÚDO é do vault.
 */
export type Lang = 'en' | 'pt';

/** Os idiomas que existem, para validar entrada sem repetir a lista. */
export const LANGS: readonly Lang[] = ['en', 'pt'];

/**
 * O idioma a partir do ambiente. `VAULT_LANG=pt` ou `VAULT_LANG=en`; qualquer outra coisa, e a
 * ausência, dão `en`.
 *
 * **O padrão é `en` e não o português de origem**, apesar de o servidor ter nascido servindo um
 * vault em português. O pacote está publicado no npm: quem instala do registro não tem como
 * adivinhar que as respostas vêm em português, e um erro que a pessoa não lê é um erro que ela não
 * corrige. Quem quer português diz que quer, uma vez, na configuração do cliente MCP.
 *
 * Deliberadamente NÃO infere de `LANG`/`LC_ALL`: medido nesta máquina, o autor do projeto — cujo
 * vault É em português — roda com `LANG=en_US.UTF-8`, então a inferência acertaria o caso genérico
 * e erraria justamente o caso conhecido. Um padrão explícito que a pessoa troca é melhor que uma
 * adivinhação que ela precisa descobrir para desligar.
 *
 * Recebe o ambiente como ARGUMENTO, como `resolveVaultPath`, para os modos de falha serem testáveis
 * sem mutar estado global num runner paralelo.
 */
export function resolveLang(env: NodeJS.ProcessEnv): Lang {
  // Pela SUBTAG PRIMÁRIA, não pela tag inteira. Este repositório chama o próprio README em
  // português de `README.pt-BR.md`, o que faz de `VAULT_LANG=pt-BR` a primeira coisa que um
  // usuário de português digita — e casando a tag inteira ele recebia um servidor em inglês sem
  // nada em lugar nenhum dizendo por quê. `pt-BR`, `pt_BR` e `pt_BR.UTF-8` são todos português.
  const raw = env['VAULT_LANG']?.trim().toLowerCase().split(/[-_.]/)[0];
  return LANGS.includes(raw as Lang) ? (raw as Lang) : 'en';
}
