import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Retriever } from '../src/retrieval/retrieval.js';
import { VaultScanner } from '../src/vault/scanner.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

const BULLMQ = '02-wiki/nestjs/bullmq-worker.md';
const AUTH_GUARD = '02-wiki/nestjs/auth-guard.md';
const MULTI_STAGE = '02-wiki/docker/multi-stage.md';
const CACHE_WRAPPER = '02-wiki/patterns/cache-wrapper.md';
const POTENTIA = '03-projects/potentia/README.md';

/**
 * Rede de regressão do scoring. Cada linha é uma pergunta em linguagem natural e a nota que
 * DEVE vencer; mexer em peso de campo (`FIELD_WEIGHTS`), peso por tipo de nota
 * (`NOTE_TYPE_WEIGHTS`), amortecimento do grafo (`GRAPH_DAMPING`) ou `k1`/`b` sem rodar este
 * arquivo é mexer às cegas. Metade das queries tem um MOC ou uma nota diária citando os mesmos
 * termos numa linha curta, que a normalização por comprimento do BM25 colocaria no topo.
 */
const GOLDEN: ReadonlyArray<{ query: string; expectedTopPath: string }> = [
  { query: 'worker de fila', expectedTopPath: BULLMQ },
  { query: 'bullmq', expectedTopPath: BULLMQ },
  { query: 'autenticacao jwt', expectedTopPath: AUTH_GUARD },
  { query: 'guard de autenticação', expectedTopPath: AUTH_GUARD },
  { query: 'build multi-stage', expectedTopPath: MULTI_STAGE },
  { query: 'cache de camadas docker', expectedTopPath: MULTI_STAGE },
  { query: 'wrapper de cache redis', expectedTopPath: CACHE_WRAPPER },
  { query: 'redis', expectedTopPath: CACHE_WRAPPER },
  { query: 'potentia', expectedTopPath: POTENTIA },
  { query: 'projeto multi-tenant restaurantes', expectedTopPath: POTENTIA },
];

const retriever = new Retriever({ scanner: new VaultScanner({ vaultRoot: FIXTURE }) });

describe('golden queries', () => {
  for (const { query, expectedTopPath } of GOLDEN) {
    it(`"${query}" ranqueia ${expectedTopPath} em primeiro`, () => {
      const { results } = retriever.search({ query });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.chunk.path).toBe(expectedTopPath);
      // O primeiro lugar tem de ser mérito de BM25, não score herdado de um vizinho.
      expect(results[0]!.viaGraph).toBe(false);
      // E tem de ser uma vitória, não um empate resolvido pela ordem alfabética do `chunk.id`:
      // um empate no topo significaria que a query não discrimina entre notas.
      const runnerUp = results.find((result) => result.chunk.path !== expectedTopPath);
      if (runnerUp !== undefined) expect(results[0]!.score).toBeGreaterThan(runnerUp.score);
    });
  }

  it('a tabela cobre as dez queries do plano, sem repetição', () => {
    expect(GOLDEN).toHaveLength(10);
    expect(new Set(GOLDEN.map((entry) => entry.query)).size).toBe(10);
  });
});
