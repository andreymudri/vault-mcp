import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

/**
 * O nome `vault-mcp` JÁ EXISTE no npm — `vault-mcp@0.0.1`, 443 bytes, de outro autor. O README e a
 * mensagem de erro do servidor já foram corrigidos para nunca sugerirem `npx vault-mcp`; falta o
 * guard local, para um `npm publish` acidental falhar aqui e não no registry.
 */
describe('package.json', () => {
  it('é privado', () => {
    expect(pkg.private).toBe(true);
  });

  it('ainda declara o bin pelo caminho absoluto documentado', () => {
    // O `bin` continua útil para `npm link` local; o que não pode é publicar sob esse nome.
    expect(pkg.bin).toEqual({ 'vault-mcp': './dist/server/index.js' });
  });
});
