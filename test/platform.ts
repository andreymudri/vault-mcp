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
 * Ambos são nomeados pelo que FALTA na plataforma, para o `it.skipIf(NO_FIFO)` do
 * call site se ler como uma frase. Ambos são `skipIf` e não uma exclusão do arquivo inteiro: o resto de cada um desses arquivos
 * roda no Windows e é justamente onde o tratamento de CAMINHO pode quebrar.
 */
export const IS_WINDOWS = process.platform === 'win32';

/** Nomes de arquivo que o NTFS não aceita criar. Ver o comentário acima. */
export const NO_HOSTILE_FILENAMES = IS_WINDOWS;

/** FIFOs, que o Windows não tem. Ver o comentário acima. */
export const NO_FIFO = IS_WINDOWS;
