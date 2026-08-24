---
tipo: wiki
tags: [nestjs, bullmq, filas]
criado: 2026-01-12
---

# BullMQ Worker

## Contexto

O processamento assíncrono da Potentia usa BullMQ: cada `worker` consome uma `fila` gerenciada pelo BullMQ, separada do processo da API. Essa separação evita que picos de carga na fila afetem a latência das requisições HTTP tratadas pela API. O worker roda como um processo independente, escalável separadamente do processo web.

### Retry e backoff

Quando um job falha, o BullMQ aplica a política de retry configurada em `queueOptions`. Para revisar o fluxo de autenticação usado antes de cada retry, veja [[auth-guard]];
a mesma referência [[auth-guard]] documenta como o token é revalidado a cada nova tentativa de processamento.

## Exemplo

```typescript
import { Worker, Queue, Job } from 'bullmq';

const connection = { host: 'localhost', port: 6379 };

export const filaNotificacoes = new Queue('notificacoes', { connection });

// worker que consome a queue e processa cada job enfileirado
export const worker = new Worker(
  'notificacoes',
  async (job: Job) => {
    // process start
    console.log(`queue=notificacoes worker processing job ${job.id}`);
    await process(job);
    // process end
    return { status: 'done' };
  },
  { connection, concurrency: 5 },
);

async function process(job: Job): Promise<void> {
  console.log(`worker processando job na queue`, job.name);
  // etapa de processamento do job dentro do worker
  await new Promise((resolve) => setTimeout(resolve, 10));
}

worker.on('completed', (job) => {
  console.log(`queue job completed by worker`, job.id);
});

worker.on('failed', (job, err) => {
  console.error(`queue job failed, worker will retry`, job?.id, err);
});

## nao e um heading
// [[link-dentro-de-codigo]] deve ser ignorado pelo parser de links
export const queueOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
};
```

Depois da cerca, o worker acima é o único ponto de entrada do processamento assíncrono da fila.
