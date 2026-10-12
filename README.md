# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) de múltiplos provedores, com entrega at-least-once, idempotência persistente, ledger imutável e correção sob concorrência multi-instância.

Desafio técnico — Jungle Gaming.

- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões de arquitetura e trade-offs
- [postman/API.md](postman/API.md) — referência completa dos endpoints e respostas
- [TESTING.md](TESTING.md) — roteiro passo a passo de testes manuais
- [postman/wagering-api.postman_collection.json](postman/wagering-api.postman_collection.json) — coleção Postman com todos os cenários

## Stack

- **Bun 1.x** (runtime, package manager e test runner)
- **TypeScript** estrito + **NestJS**
- **PostgreSQL** (MikroORM, migrations versionadas e reversíveis)
- **AWS SQS** via LocalStack
- **Keycloak** (OIDC) para autenticação
- Observabilidade: logs JSON (pino), métricas Prometheus, health checks

## Subindo o ambiente

Pré-requisitos: Docker + Docker Compose e Bun 1.x (`curl -fsSL https://bun.sh/install | bash` ou `brew install oven-sh/bun/bun`).

```bash
# 1. Dependências
bun install

# 2. Infra local: PostgreSQL (host 5442), LocalStack/SQS (4566), Keycloak (8080)
#    O serviço queues-setup cria as filas FIFO automaticamente.
docker compose up -d postgres localstack keycloak queues-setup

# 3. Config local
cp .env.example .env

# 4. Migrations
bun run migration:up

# 5. App em modo dev
bun run start:dev
```

### Aplicação completa em Docker (múltiplas instâncias)

```bash
docker compose up -d --build --scale app=3
```

Cada instância roda consumer SQS, outbox publisher e worker de referências pendentes — a correção com N instâncias é garantida pelo banco (locks + constraints), não por haver uma instância só.

## Comandos

| Comando                    | O que faz                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| `bun run start:dev`        | app local com watch                                                |
| `bun test`                 | **todas** as suítes (101 testes)                                   |
| `bun run test`             | só unidade (domínio puro, não precisa de infra)                    |
| `bun run test:integration` | integração real contra PostgreSQL + LocalStack                     |
| `bun run test:concurrency` | corridas com **3 instâncias reais** (processos separados)          |
| `bun run test:load`        | gera carga e imprime throughput + p50/p95/p99 (ver Observabilidade)|
| `bun run migration:up`     | aplica migrations                                                  |
| `bun run migration:down`   | reverte a última migration                                         |
| `bun run queues:setup`     | cria as filas FIFO no LocalStack                                   |
| `bun run typecheck`        | `tsc --noEmit`                                                     |
| `bun run lint`             | verifica (não reescreve arquivos)                                  |
| `bun run lint:fix`         | aplica correções automáticas                                       |

> Se o editor mostrar uma enxurrada de `Unsafe … of type error` (`no-unsafe-*`) e o
> `bun run lint` estiver limpo, o TS server está com cache anterior aos aliases:
> **TypeScript: Restart TS Server** e **ESLint: Restart ESLint Server** resolvem.

Os testes de integração/concorrência esperam a infra do compose de pé e criam/usam o banco `wagering_test` isolado. Eles declaram o próprio timeout (60s) chamando `useRealInfraTimeouts()` no topo do arquivo — o default de 5s do Bun não cobre long polling do SQS nem redrive para a DLQ.

## Autenticação

Endpoints (exceto `/health/*` e `/metrics`) exigem access token do Keycloak (realm `wagering`, importado automaticamente):

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d 'grant_type=client_credentials&client_id=provider-a&client_secret=provider-a-secret' | jq -r .access_token)
```

Para desenvolvimento sem Keycloak: `AUTH_ENABLED=false`.

## API

### Criar wallet

```bash
curl -X POST localhost:3000/wallets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

### Submeter transação

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

### Consultas e reconciliação

```
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=...&limit=50
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET  /health/live | /health/ready | /metrics
```

### Status HTTP

| Situação                              | Status | Corpo                              |
| ------------------------------------- | ------ | ---------------------------------- |
| transação aplicada (ou replay dela)   | 200    | `status: PROCESSED`, saldo         |
| aceita aguardando referência          | 202    | `status: PENDING_REFERENCE`        |
| payload inválido (forma ou domínio)   | 400    | mensagem de validação              |
| sem token                             | 401    | —                                  |
| recurso inexistente                   | 404    | —                                  |
| conflito (idempotência/wallet dupla)  | 409    | `failureCode: IDEMPOTENCY_CONFLICT`|
| rejeição de negócio                   | 422    | `failureCode` estável              |
| falha transitória de infraestrutura   | 503    | `Retry-After`                      |

Replays idempotentes retornam **a resposta original** (mesmo status, mesmo saldo observado) com `idempotentReplay: true`.

## Mensageria

- `wager-transactions.fifo` — entrada de transações (consumer com inbox persistente, ack só após commit, DLQ após 5 tentativas)
- `wager-transactions-dlq.fifo` — dead letter queue
- `wager-events.fifo` — eventos de integração publicados pelo transactional outbox

## Observabilidade — dashboard

Métricas e logs num só lugar, em um profile opcional do compose (o `up` normal continua subindo só o essencial):

```bash
docker compose --profile observability up -d --build --scale app=3
```

| Serviço | URL | Papel |
| --- | --- | --- |
| **Grafana** | http://localhost:3001 | dashboard (sem login — stack local) |
| Prometheus | http://localhost:9090 | scrape das réplicas; `/targets` mostra 3 UP |
| Loki + promtail | interno | logs JSON dos containers |

O dashboard **Distributed Wagering Processor** já vem provisionado (datasources + painéis), então abre pronto. Para ele ter dados, gere tráfego:

```bash
LOAD_BASE_URL="$(for i in 1 2 3; do printf 'http://localhost:%s,' "$(docker port backend-challenge-junglegaming-app-$i 3000/tcp | head -1 | sed 's/.*://')"; done | sed 's/,$//')" bun run test:load
```

O gerador mistura apostas normais com **replays idempotentes**, **rajadas da mesma chave em paralelo** (que produzem corrida entre instâncias), apostas sem saldo e uma fatia entrando pela **fila SQS** — e ao final imprime throughput, p50/p95/p99, taxa de erro e distribuição por desfecho. Parâmetros por env: `DURATION_S`, `CONCURRENCY`, `WALLETS`, `REPLAY_RATE`, `BURST_RATE`, `SQS_RATE`, `OVERDRAW_RATE`.

O dashboard é organizado pelas áreas que o desafio avalia:

| Linha | O que responde |
| --- | --- |
| **Saúde da operação** | divergências de reconciliação (tem que ser **0**), DLQ, outbox lag, instâncias vivas |
| **Transações** | volume por desfecho e por tipo, taxa de rejeição |
| **Idempotência e concorrência** | duplicatas absorvidas e corridas perdidas entre instâncias, por constraint |
| **Latência e throughput** | p50/p95/p99 e req/s |
| **Mensageria** | consumer por desfecho, outbox publicados × retries |
| **Runtime por instância** | CPU, heap e event loop lag das 3 réplicas |
| **Logs** | erros/avisos e rastreio de uma transação pela variável `correlationId` |

> Para seguir uma transação de ponta a ponta, cole um `correlationId` na caixa do topo do dashboard: os logs de HTTP, do consumer SQS e dos workers carregam o mesmo campo.

## Estrutura

Camadas + módulos Nest: as camadas isolam o domínio, os módulos fazem o wiring.

Cada camada tem um alias de import (`tsconfig.json` → `paths`), então nenhum arquivo
sobe diretórios com `../../..`:

| Alias | Aponta para |
| --- | --- |
| `@domain/*` | `src/domain/*` |
| `@app/*` | `src/application/*` |
| `@infra/*` | `src/infrastructure/*` |
| `@interface/*` | `src/interface/*` |
| `@modules/*` | `src/modules/*` |
| `@config/*` | `src/config/*` |
| `@test/*` | `test/*` |

Regra: import que cruza pasta usa alias; import do mesmo diretório continua relativo
(`./wallets.types`). Sem barrels (`index.ts`) — cada import aponta para o arquivo que
realmente define o símbolo.

```
src/
  domain/                  # Money, Wallet, WagerTransaction, LedgerEntry, Inbox/Outbox,
                           # eventos — puro: sem NestJS, sem ORM
  application/
    wallets/               # WalletsService  (@Injectable) + tipos
    wagering/              # WageringService (@Injectable) + tipos
    events/                # IntegrationEventsService
    repositories/          # contratos de persistência (1 por repositório + UnitOfWork)
    system.ts metrics.ts   # portas de relógio/ids e métricas
  infrastructure/          # adapters: MikroORM (EntitySchema, migrations, repositórios),
                           # SQS, Prometheus, clock/uuid
  interface/
    http/                  # controllers por feature, DTOs, guard, filter, health indicators
    messaging/             # wager.consumer, outbox.publisher, pending-reference.worker
  modules/                 # módulos Nest: core, persistence, observability, sqs,
                           # wallets, wagering, messaging, health
  app.module.ts            # compõe os módulos + pipe/filter/guard globais
test/
  integration/             # PostgreSQL + LocalStack reais: constraints, atomicidade, inbox, outbox, DLQ, recovery
  concurrency/             # 3 processos reais disputando as mesmas wallets
```
