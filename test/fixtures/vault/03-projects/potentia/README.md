---
tipo: projeto
status: ativo
stack: [nestjs, mongoose, redis]
criado: 2026-01-05
---

# Potentia

## Objetivo

Potentia é um sistema multi-tenant para gestão de restaurantes, permitindo que cada restaurante opere de forma isolada dentro da mesma plataforma, com dados segregados por tenant.

## Stack

A API é construída em NestJS, com persistência via Mongoose sobre MongoDB e cache via Redis. O wrapper de cache usado no projeto está documentado em [[cache-wrapper]], e a camada de autenticação segue o padrão descrito em [[auth-guard]].

## Links

- [[cache-wrapper]]
- [[auth-guard]]
