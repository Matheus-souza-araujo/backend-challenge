# API Reference

Documentação de todos os endpoints HTTP do Distributed Wagering Processor.

> **Postman:** importe [postman/wagering-api.postman_collection.json](postman/wagering-api.postman_collection.json) — a coleção cobre todos os endpoints e cenários abaixo, com token automático e variáveis encadeadas.
> **Roteiro guiado de testes:** [TESTING.md](TESTING.md).

- Base URL local: `http://localhost:3000`
- Todos os corpos são JSON (`Content-Type: application/json`)
- Valores monetários são **sempre** `{ "amount": "<string decimal com 2 casas>", "currency": "<ISO-4217>" }` — `amount` nunca é number

## Autenticação

Todos os endpoints exigem `Authorization: Bearer <access_token>` do Keycloak, **exceto** `GET /health/*` e `GET /metrics`.

Obtenção do token (client credentials do provedor):

```
POST http://localhost:8080/realms/wagering/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=provider-a&client_secret=provider-a-secret
```

| Resposta | Quando |
|---|---|
| `200` `{ access_token, expires_in: 3600, ... }` | credenciais válidas; token dura 1 h |
| `401` `{ error: "invalid_client" }` | client/secret errados |

Falhas de autenticação na API:

```json
401 { "message": "Token Bearer ausente",       "error": "Unauthorized", "statusCode": 401 }
401 { "message": "Token inválido ou expirado", "error": "Unauthorized", "statusCode": 401 }
```

## Convenção de status HTTP

| Status | Significado | Pode reenviar? |
|---|---|---|
| `200` | transação aplicada — ou **replay** dela (`idempotentReplay: true`) | sim (idempotente) |
| `201` | recurso criado | — |
| `202` | aceita, aguardando referência (`PENDING_REFERENCE`) | não — o worker resolve |
| `400` | payload inválido (forma ou regra estrutural do domínio) | após corrigir |
| `401` | não autenticado | após obter token |
| `404` | recurso inexistente | não |
| `409` | conflito — idempotency key reutilizada com payload diferente, ou wallet duplicada | não — corrigir key/payload |
| `422` | rejeição de negócio, **persistida e auditável**, com `failureCode` estável | não |
| `503` | infraestrutura transitória indisponível (header `Retry-After`) | sim, com backoff, mesma key |

---

## POST /wallets

Cria a wallet de um player. Saldo inicial positivo gera a transação interna `OPENING` + lançamento `CREDIT` no ledger, **na mesma transação SQL** — por isso a wallet já nasce com `version: 1` e o saldo aplicado.

**Request**

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

| Campo | Tipo | Regras |
|---|---|---|
| `playerId` | UUID | obrigatório |
| `initialBalance` | Money | obrigatório; `amount ≥ 0.00`, exatamente 2 casas |

**Respostas**

`201 Created`
```json
{
  "id": "019fb8a7-ad54-75da-af94-148bb61c4bf2",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

`400` — playerId não-UUID; `amount` numérico, negativo, sem 2 casas, `NaN`/científico; moeda fora do padrão `AAA`.

`409` — wallet duplicada (máx. 1 por `player + currency`, constraint no banco):
```json
{ "statusCode": 409, "error": "WalletAlreadyExistsError", "message": "Já existe wallet para o player ... em BRL" }
```

---

## GET /wallets/:walletId

Estado atual da wallet.

**Respostas**

`200`
```json
{
  "id": "019fb8a7-...",
  "playerId": "0192f28f-...",
  "balance": { "amount": "125.00", "currency": "BRL" },
  "version": 5,
  "createdAt": "2026-07-31T14:58:07.360Z",
  "updatedAt": "2026-07-31T14:58:07.535Z"
}
```

`version` incrementa **somente** quando o saldo muda (LOSS e rejeições não incrementam).

`400` — `walletId` não é UUID. `404` — `{ "error": "WalletNotFoundError", ... }`.

---

## GET /wallets/:walletId/ledger?cursor=&limit=

Extrato do ledger (append-only), do mais recente ao mais antigo, com **cursor opaco e estável**.

| Query | Tipo | Default | Regras |
|---|---|---|---|
| `limit` | int | 50 | 1–200 |
| `cursor` | string | — | valor de `nextCursor` da página anterior; opaco, não construa manualmente |

**Respostas**

`200`
```json
{
  "entries": [
    {
      "id": "019fb8ae-...",
      "transactionId": "019fb8ae-...",
      "direction": "DEBIT",
      "money":         { "amount": "20.00",  "currency": "BRL" },
      "balanceBefore": { "amount": "145.00", "currency": "BRL" },
      "balanceAfter":  { "amount": "125.00", "currency": "BRL" },
      "createdAt": "2026-07-31T14:58:07.535Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOi..."
}
```

Propriedades que valem sempre:
- os saldos são **encadeados**: `balanceAfter` de um lançamento = `balanceBefore` do seguinte;
- `LOSS` e transações `REJECTED` **não** aparecem (não geram lançamento);
- `nextCursor` ausente = última página.

`400` — cursor corrompido (`InvalidCursorError`) ou `limit` fora de 1–200. `404` — wallet inexistente.

---

## POST /wagering/transactions

Submete uma operação de aposta. **Mesmo use case do consumer SQS** — o canal não muda o comportamento.

**Headers**

| Header | Obrigatório | Descrição |
|---|---|---|
| `Idempotency-Key` | **sim** | fonte da verdade da deduplicação; recomendado `{providerId}:{externalTransactionId}` |

**Request**

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "019fb8a7-ad54-75da-af94-148bb61c4bf2",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "transaction-100"
}
```

| Campo | Regras |
|---|---|
| `kind` | `BET` \| `WIN` \| `LOSS` \| `REFUND` \| `ROLLBACK` — `OPENING` é interno e rejeitado com 400 |
| `referenceExternalTransactionId` | **obrigatório** para `REFUND`/`ROLLBACK`; opcional para `WIN`; proibido para `BET`/`LOSS` |
| `money.amount` | string decimal positiva com exatamente 2 casas |

Semântica por kind:

| Kind | Efeito no saldo | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 × DEBIT | — |
| `WIN` | crédito | 1 × CREDIT | opcional, só BET, mesma rodada; valor livre |
| `LOSS` | nenhum | nenhum | — |
| `REFUND` | crédito | 1 × CREDIT | obrigatória, só BET `PROCESSED`, **mesmo valor**, 1× |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | obrigatória, BET/WIN/REFUND `PROCESSED`, mesmo valor, 1× por kind |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao mesmo provider, player, wallet, moeda e rodada.

**Respostas**

`200 OK` — aplicada:
```json
{
  "transactionId": "019fb8ae-bda7-7498-80b7-a58688579e48",
  "status": "PROCESSED",
  "balance": { "amount": "70.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

`200 OK` — **replay idempotente** (mesma key + payload idêntico): resposta byte-a-byte igual à original — mesmo `transactionId`, mesmo `balance` observado na época — com `idempotentReplay: true`. O efeito **não** se repete. Replays preservam o status HTTP original (um replay de rejeição devolve `422` de novo).

`202 Accepted` — referência ainda não chegou (entrega fora de ordem):
```json
{ "transactionId": "019fb8af-...", "status": "PENDING_REFERENCE", "idempotentReplay": false }
```
Um worker reprocessa com backoff exponencial (até 8 tentativas ≈ 15 min); acompanhe via `GET /wagering/transactions/:id`. Esgotado o prazo → `REJECTED` com `REFERENCE_NOT_FOUND`.

`400 Bad Request` — forma inválida: header `Idempotency-Key` ausente; `amount` numérico/escala errada; `kind` desconhecido ou `OPENING`; `REFUND`/`ROLLBACK` sem referência; `BET`/`LOSS` com referência; UUIDs malformados. Nada é persistido.

`404` — `walletId` inexistente (`WalletNotFoundError`).

`409 Conflict` — mesma key com payload **diferente** (comparação por SHA-256 de JSON canônico dos campos de negócio):
```json
{ "statusCode": 409, "error": "IdempotencyConflictError", "failureCode": "IDEMPOTENCY_CONFLICT", "message": "..." }
```

`422 Unprocessable Entity` — rejeição de negócio, persistida (auditável e consultável) e com evento `WagerTransactionRejected`:
```json
{
  "transactionId": "019fb8ae-...",
  "status": "REJECTED",
  "failureCode": "INSUFFICIENT_FUNDS",
  "balance": { "amount": "70.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Tabela completa de `failureCode`:

| failureCode | Situação | Ação sugerida ao provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta maior que o saldo | não reenviar |
| `REVERSAL_WOULD_OVERDRAW` | reversão (débito) negativaria o saldo | não reenviar — situação operacional distinta da anterior |
| `MISSING_REFERENCE` | kind exige referência (defensivo; a borda responde 400 antes) | corrigir payload |
| `REFERENCE_NOT_FOUND` | referência não apareceu dentro do prazo de retries | verificar se a operação referenciada foi enviada |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrigir payload |
| `INVALID_REFERENCE_KIND` | ex.: REFUND referenciando WIN | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou REJECTED/FAILED | não reenviar |
| `REFERENCE_ALREADY_REVERSED` | segunda reversão do mesmo tipo | não reenviar |
| `AMOUNT_MISMATCH` | valor difere do da referência (reversão parcial não existe) | corrigir payload |
| `CURRENCY_MISMATCH` | moeda difere da moeda da wallet (`balance` omitido na resposta) | corrigir payload |
| `WALLET_OWNERSHIP_MISMATCH` | wallet não pertence ao `playerId` enviado | corrigir payload |
| `IDEMPOTENCY_CONFLICT` | (via 409) mesma key, payload diferente | corrigir payload ou trocar a key |
| `INTERNAL_ERROR` | falha permanente de infraestrutura (status `FAILED`, auditável) | contatar operação |

`503 Service Unavailable` + `Retry-After: 5` — PostgreSQL/SQS momentaneamente indisponíveis. Seguro reenviar **com a mesma key**.

---

## GET /wagering/transactions/:transactionId

Consulta pelo id interno (UUID devolvido no submit).

**Respostas**

`200`
```json
{
  "transactionId": "019fb8af-04d6-77ec-b9e6-3fda906a6205",
  "providerId": "provider-a",
  "externalTransactionId": "ooo-rb",
  "walletId": "019fb8af-...",
  "playerId": "0192f28f-...",
  "roundId": "round-x",
  "gameId": "g1",
  "kind": "ROLLBACK",
  "money": { "amount": "25.00", "currency": "BRL" },
  "status": "PROCESSED",
  "referenceTransactionId": "019fb8af-04f6-...",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "createdAt": "2026-07-31T14:58:25.621Z",
  "processedAt": "2026-07-31T14:58:27.159Z"
}
```

Campos condicionais: `failureCode` (só REJECTED/FAILED), `referenceTransactionId` (só quando resolvida), `balance` (saldo observado no desfecho; ausente em `PENDING_REFERENCE` e em rejeições sem leitura de saldo), `processedAt` (só PROCESSED).

Ciclo de vida do `status`: `PENDING → (PENDING_REFERENCE) → PROCESSED | REJECTED | FAILED` — os três últimos são terminais e imutáveis.

`400` — id não-UUID. `404` — `TransactionNotFoundError`.

---

## GET /providers/:providerId/wagering/transactions/:externalTransactionId

Mesma consulta, pela **identidade externa** — a visão do provedor, sem precisar do UUID interno. Par `(providerId, externalTransactionId)` é único no sistema (constraint).

**Respostas:** `200` (mesmo corpo acima), `404` se o par não existir.

---

## POST /wallets/:walletId/reconciliation

Recalcula o saldo a partir do ledger (SUM em SQL, sob lock da wallet — snapshot consistente) e compara com o saldo materializado. Divergência **não é corrigida**: é logada, contada na métrica `reconciliation_divergences_total` e sinalizada na resposta.

**Respostas**

`200`
```json
{
  "walletId": "019fb8a7-...",
  "storedBalance":     { "amount": "125.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "125.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 7
}
```

Invariante do sistema: `consistent` deve ser **sempre** `true`. `checkedEntries` é o total de lançamentos somados.

`404` — wallet inexistente.

---

> Ambos usam `@nestjs/terminus` e respondem no formato padrão dele:
> `{ status, info, error, details }` — `status` é `"ok"` ou `"error"`, `info` traz
> os indicadores saudáveis, `error` os que falharam e `details` todos.

## GET /health/live *(sem auth)*

Liveness — o processo responde, sem tocar dependências externas.

`200` → `{ "status": "ok", "info": {}, "error": {}, "details": {} }`

## GET /health/ready *(sem auth)*

Readiness — dependências alcançáveis de verdade (query no PostgreSQL + chamada ao SQS).

| Resposta | Corpo |
|---|---|
| `200` | `{ "status": "ok", "info": { "postgres": { "status": "up" }, "sqs": { "status": "up" } }, "error": {}, "details": { … } }` |
| `503` | `{ "status": "error", "info": { … }, "error": { "postgres": { "status": "down", "message": "…" } }, "details": { … } }` |

## GET /metrics *(sem auth)*

Métricas no formato de exposição Prometheus (`text/plain`). Séries principais:

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{status,kind,channel}` | transações por desfecho e canal (http/sqs/worker) |
| `wager_idempotent_replays_total{channel}` | duplicatas detectadas |
| `wager_race_retries_total{constraint}` | corridas perdidas para outra instância |
| `wager_processing_duration_seconds` | latência do processamento (histograma) |
| `sqs_consumer_messages_total{outcome}` | consumo da fila: processed/business_error/transient_error/malformed |
| `outbox_published_total` / `outbox_retries_total` | publicação de eventos |
| `outbox_lag_seconds` | idade do evento pendente mais antigo |
| `pending_reference_resolutions_total{outcome}` | worker de referências: processed/rescheduled/rejected |
| `sqs_dlq_depth` | mensagens na DLQ (aproximado) |
| `reconciliation_divergences_total` | divergências saldo × ledger — deve permanecer 0 |

---

## Apêndice: entrada assíncrona (SQS)

Não é HTTP, mas faz parte do contrato. Fila `wager-transactions.fifo`, envelope:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...",
    "walletId": "...",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Comportamento do consumer: dedup por inbox persistente `(consumer, messageId)`; ack só após o commit; erro de negócio → ack terminal; erro transitório → redelivery até 5 tentativas e então `wager-transactions-dlq.fifo`; payload malformado → ack (não polui a DLQ).

Eventos de integração publicados em `wager-events.fifo` (pelo transactional outbox, sempre **após** o commit): `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo muda) e `WagerTransactionPendingReference`. Envelope com `eventId` estável — consumidores devem deduplicar por ele.
