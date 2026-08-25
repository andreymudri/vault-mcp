---
tipo: wiki
tags: [docker, build]
criado: 2026-02-01
---

# multi-stage

## Contexto

O Dockerfile de produção cresceu demais e a imagem final carregava ferramentas de build que não deveriam ir para produção. Precisávamos de um build multi-stage para separar as etapas de compilação das etapas de execução.

## Solução

Um build multi-stage divide o Dockerfile em vários blocos `FROM`, cada um representando um estágio isolado. O primeiro estágio instala dependências e compila o projeto; o último estágio copia apenas os artefatos necessários, resultando numa imagem final enxuta.

O Docker também mantém cache de camadas entre builds: cada instrução gera uma camada, e camadas que não mudaram são reaproveitadas do cache local. Ordenar o Dockerfile das instruções mais estáveis para as mais voláteis maximiza o acerto do cache de camadas e acelera builds repetidos do processo multi-stage.
