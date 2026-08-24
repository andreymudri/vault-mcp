---
tipo: wiki
tags: [patterns, redis, cache]
criado: 2026-02-05
---

# Cache Wrapper

## Contexto

Vários serviços da Potentia precisavam de um wrapper de cache consistente sobre Redis, evitando duplicar lógica de serialização e expiração de chaves em cada módulo.

## Solução

Criamos um wrapper de cache que encapsula o cliente Redis e expõe um método `get`/`set` genérico com TTL configurável. A autenticação usada para conectar ao Redis segue o mesmo padrão de configuração descrito em [[auth-guard]], reaproveitando as variáveis de ambiente do serviço.

## Exemplo

O wrapper de cache é usado para armazenar respostas de consultas caras ao Redis, reduzindo a carga no banco de dados principal.
