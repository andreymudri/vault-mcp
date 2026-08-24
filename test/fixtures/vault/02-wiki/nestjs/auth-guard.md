---
tipo: wiki
tags: [nestjs, auth, jwt]
criado: 2026-01-10
---

# Auth Guard

Este documento registra uma decisão de autenticação tomada para os serviços NestJS da Potentia, cobrindo como guards validam tokens JWT antes de liberar acesso às rotas protegidas.

## Contexto

A API precisava de um mecanismo central de autenticação e autorização, aplicado de forma consistente em todos os módulos, sem repetir lógica de validação de JWT em cada controller.

## Solução

Implementamos um `AuthGuard` global baseado em `@nestjs/passport`, que decodifica o token JWT recebido no header `Authorization` e injeta o usuário autenticado no contexto da requisição. O worker de processamento assíncrono também depende deste guard indiretamente: veja [[bullmq-worker]] para os detalhes de como os jobs enfileirados carregam o contexto do usuário.

Ainda há um ponto em aberto documentado em [[nota-que-nao-existe]], que cobriria a rotação de chaves de assinatura do JWT.
