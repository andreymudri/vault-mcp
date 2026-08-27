/**
 * Códigos de erro, e por que a tradução não é feita onde o erro NASCE.
 *
 * Os erros que o usuário lê são lançados fundo na camada de escrita — `paths.ts`, `writer.ts`,
 * `relocate.ts`, `learn.ts` —, e nenhuma dessas funções tem, nem deveria ter, um catálogo de
 * idioma. Passá-lo por parâmetro contaminaria dezenas de assinaturas que não têm nada que ver com
 * apresentação; um singleton de módulo seria estado global mutável, que este projeto evita de
 * propósito (ver `resolveVaultPath`, que recebe o ambiente em vez de ler `process.env`).
 *
 * Então o erro carrega um CÓDIGO e os PARÂMETROS, e quem resolve é a fronteira da tool, que já
 * tem o catálogo em mãos. O texto português continua no `message` de sempre: nada que já testava
 * `err.message` diretamente mudou de comportamento, e a fronteira só reescreve quando há código.
 */
export interface ErrorContext {
  /** Chave em `messages.errorCodes`. Ausente = erro sem tradução, relatado como veio. */
  readonly code?: string;
  /** Valores para os `{placeholders}` do template. */
  readonly params?: Readonly<Record<string, string | number>>;
  /**
   * Uma DICA anexada ao erro, com código próprio, resolvida e acrescentada depois do template.
   *
   * Existe para o `withWriteDetail`, que junta uma explicação ao erro original. Sem este canal,
   * traduzir pelo código devolveria só o template e a dica sumiria — trocar um vazamento de
   * idioma por uma perda de informação seria péssimo negócio. Tem código próprio porque a dica
   * é frase inteira e independente, não um parâmetro do erro que a acompanha.
   */
  readonly hint?: { readonly code: string; readonly params?: Readonly<Record<string, string | number>> };
}

/**
 * Substitui `{nome}` pelos parâmetros. Um placeholder sem valor fica VISÍVEL como `{nome}` em vez
 * de virar `undefined`: um buraco no texto é um bug que alguém reporta, `undefined` é um bug que
 * alguém lê como parte da mensagem.
 */
export function renderTemplate(
  template: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}

/**
 * Marca um erro já construído com código e parâmetros, e devolve o MESMO objeto.
 *
 * Anexa em vez de mudar sete construtores de erro espalhados por sete arquivos: a mensagem
 * portuguesa continua sendo a que sempre foi, `instanceof` continua valendo, e quem já capturava
 * essas classes não vê diferença. A fronteira lê o código quando existe e ignora quando não.
 */
export function coded<E extends Error>(
  err: E,
  code: string,
  params?: Readonly<Record<string, string | number>>,
  hint?: ErrorContext['hint'],
): E {
  return Object.assign(err, {
    code,
    ...(params === undefined ? {} : { params }),
    ...(hint === undefined ? {} : { hint }),
  });
}

/** O contexto de um erro desconhecido, vazio quando ele não carrega nenhum. */
export function errorContext(err: unknown): ErrorContext {
  if (typeof err !== 'object' || err === null) return {};
  const { code, params, hint } = err as ErrorContext;
  if (typeof code !== 'string') return {};
  return {
    code,
    ...(params === undefined ? {} : { params }),
    ...(hint === undefined ? {} : { hint }),
  };
}
