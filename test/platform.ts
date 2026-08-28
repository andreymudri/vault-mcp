/**
 * O que o sistema de arquivos do Windows torna INEXPRIMÍVEL, e por que pular é a resposta certa
 * em vez de adaptar o teste.
 *
 * Dois grupos de teste desta suíte não descrevem uma regra de negócio: descrevem uma defesa contra
 * uma forma de arquivo que só o POSIX consegue produzir. Adaptá-los para o Windows não os deixaria
 * mais fracos — os deixaria SEM ASSUNTO, afirmando algo sobre um arquivo que não pode existir lá.
 *
 * - `NO_HOSTILE_FILENAMES`: nomes que o NTFS recusa na criação (`*`, `?`, `<`, `>`, `|`, `"`, `:` e
 *   qualquer controle, quebra de linha incluída). Os testes que os usam verificam que um nome
 *   hostil não vira glob para o git nem forja uma linha na resposta de uma tool. No Windows o
 *   `open` falha antes: a defesa continua correta e a ameaça é inalcançável.
 *
 * - `NO_FIFO`: FIFOs. `mkfifo` não existe no Windows, e o `readFileSync` que trava para
 *   sempre num FIFO sem escritor — a falha que esses testes existem para impedir — não tem
 *   equivalente lá.
 *
 * - `NO_POSIX_MODES`: bits de permissão. O NTFS não os tem, e o Node relata `0o666` para
 *   qualquer arquivo gravável por mais que se chame `chmod` nele — medido: os testes de modo
 *   deste projeto receberam 438 (`0o666`) onde exigiam 384 (`0o600`). O `chmod` do `atomicWrite`
 *   continua sendo chamado lá e continua sendo inofensivo; o controle de acesso no Windows é por
 *   ACL herdada do diretório, que é outro mecanismo e não algo que esta suíte afirme.
 *
 * Ambos são nomeados pelo que FALTA na plataforma, para o `it.skipIf(NO_FIFO)` do
 * call site se ler como uma frase. Ambos são `skipIf` e não uma exclusão do arquivo inteiro: o resto de cada um desses arquivos
 * roda no Windows e é justamente onde o tratamento de CAMINHO pode quebrar.
 */
export const IS_WINDOWS = process.platform === 'win32';

/** Nomes de arquivo que o NTFS não aceita criar. Ver o comentário acima. */
export const NO_HOSTILE_FILENAMES = IS_WINDOWS;

/** FIFOs, que o Windows não tem. Ver o comentário acima. */
export const NO_FIFO = IS_WINDOWS;

/** Bits de permissão POSIX, que o NTFS não tem. Ver o comentário acima. */
export const NO_POSIX_MODES = IS_WINDOWS;

/**
 * Hooks de git escritos em `sh`.
 *
 * No Windows os hooks rodam sob o `sh` que o Git for Windows empacota, e esta suíte não pode
 * assumi-lo: um `git` instalado por winget ou Scoop sem o bundle de bash não tem shell nenhum
 * para rodá-los. O que os dois testes guardados por esta flag PROVAM — que uma invocação de git
 * é limitada por relógio e não pode perguntar nada ao terminal — é a opção `timeout` e a variável
 * `GIT_TERMINAL_PROMPT` do `execFile`, que não têm nada de específico de plataforma. O que não é
 * portátil é o único jeito de fazer o git TRAVAR de propósito.
 */
export const NO_SHELL_HOOKS = IS_WINDOWS;
