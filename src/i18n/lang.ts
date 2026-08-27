/**
 * O idioma em que o servidor FALA — e a fronteira, que é a parte que importa.
 *
 * Duas famílias de texto saem daqui e só UMA delas é traduzível:
 *
 * - **O que o servidor DIZ** ao agente e ao usuário: descrição das tools, descrição dos campos,
 *   erros, avisos, rótulos do resultado da busca. É isto que `VAULT_LANG` controla. Vale a pena
 *   controlar porque a descrição da tool é o que o MODELO lê para decidir se chama a tool: um
 *   servidor que descreve `vault_learn` em português para um agente operando em inglês está
 *   pagando um imposto de tradução em toda decisão de chamada.
 *
 * - **O que o servidor ESCREVE no vault**: assunto de commit (`docs(vault): atualizar X`) e nome
 *   de seção (`## Notas`, `## Domínios`, `## Capturas`). Isto NÃO é traduzível, e não é questão de
 *   gosto: `insertUnderSection` procura o nome da seção DENTRO DO ARQUIVO DO USUÁRIO. Traduzir
 *   `'## Notas'` para `'## Notes'` num vault cujo MOC diz `## Notas` não acha a seção, ANEXA uma
 *   segunda, e quebra em silêncio a idempotência que impede o MOC de ganhar uma linha repetida a
 *   cada captura. O assunto de commit tem o mesmo problema com outro nome: ele entra no histórico
 *   de git do usuário, que é do vault e não de quem está lendo.
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
  const raw = env['VAULT_LANG']?.trim().toLowerCase();
  return LANGS.includes(raw as Lang) ? (raw as Lang) : 'en';
}
