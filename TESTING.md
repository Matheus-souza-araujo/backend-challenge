# Guia de testes manuais — passo a passo

Roteiro para subir o ambiente, autenticar no Keycloak e exercitar todos os fluxos do sistema, com **a resposta exata que você deve ver** em cada passo. Se alguma resposta divergir, algo está errado.

> Todos os comandos são copy-paste. Os passos guardam valores em variáveis de shell (`$TOKEN`, `$WID`...), então execute na **mesma sessão de terminal**, na ordem.

---

## 0. Subir o ambiente

```bash
bun install
docker compose up -d postgres localstack keycloak queues-setup
cp .env.example .env
bun run migration:up
bun run start:dev
```

Aguarde o Keycloak ficar pronto (~20 s na primeira vez):

```bash
until curl -sf http://localhost:8080/realms/wagering/.well-known/openid-configuration > /dev/null; do sleep 2; done; echo "keycloak pronto"
```

### O que esperar dos health checks

```bash
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
```

```json
{"status":"ok","info":{},"error":{},"details":{}}
{"status":"ok","info":{"postgres":{"status":"up"},"sqs":{"status":"up"}},"error":{},"details":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
```

Formato padrão do `@nestjs/terminus`. Se algum componente cair, ele aparece em `error` com `"status":"down"`, o `status` geral vira `"error"` e o endpoint responde **503**.

---

## 1. Login (Keycloak)

O provedor `provider-a` é um service account (client credentials) já importado no realm:

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d 'grant_type=client_credentials&client_id=provider-a&client_secret=provider-a-secret' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "token: ${#TOKEN} caracteres"
AUTH="Authorization: Bearer $TOKEN"
CT='Content-Type: application/json'
```

**Esperado:** `token: ~1200 caracteres`. O token expira em 1 h — se mais tarde você receber 401, gere outro.

### 1.1 Prova de que a autenticação está ativa

```bash
curl -s -w '\n[%{http_code}]' localhost:3000/wallets/00000000-0000-7000-8000-000000000000
```

**Esperado (sem token):**

```json
{"message":"Token Bearer ausente","error":"Unauthorized","statusCode":401}
[401]
```

Com um token inválido/expirado a mensagem muda para `"Token inválido ou expirado"`, também `[401]`.

---

## 2. Criar wallet

```bash
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

W=$(curl -s -X POST localhost:3000/wallets -H "$AUTH" -H "$CT" \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo $W
WID=$(echo $W | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "walletId: $WID"
```

**Esperado (HTTP 201):**

```json
{"id":"<uuid>","playerId":"0192f28f-...","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Repare: `version: 1` **já com o saldo inicial aplicado** — o crédito de abertura (`OPENING`) faz parte da criação e gera o primeiro lançamento no ledger.

### 2.1 Wallet duplicada → conflito

```bash
curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wallets -H "$AUTH" -H "$CT" \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"50.00\",\"currency\":\"BRL\"}}"
```

**Esperado:** `[409]` com `"error":"WalletAlreadyExistsError"` — no máximo uma wallet por `(playerId, currency)`, garantido por constraint no banco.

---

## 3. Cenário feliz: BET

Helper para os próximos passos (submete uma transação e mostra o status HTTP):

```bash
SUBMIT() { curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wagering/transactions \
  -H "$AUTH" -H "$CT" -H "Idempotency-Key: provider-a:$1" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"$4\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}${5:+,\"referenceExternalTransactionId\":\"$5\"}}"; echo; }
```

```bash
SUBMIT bet-1 BET 30.00 round-1
```

**Esperado (HTTP 200):** saldo caiu 100.00 → 70.00, exatamente um débito:

```json
{"transactionId":"<uuid>","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
[200]
```

---

## 4. Idempotência (o coração do desafio)

### 4.1 Replay exato → mesma resposta, sem novo débito

Repita **o mesmo comando**:

```bash
SUBMIT bet-1 BET 30.00 round-1
```

**Esperado:** resposta idêntica à original (mesmo `transactionId`, mesmo saldo `70.00`), mudando apenas:

```json
{"...":"...","idempotentReplay":true}
[200]
```

Rode 10 vezes se quiser — o saldo **nunca** cai de novo. Confira:

```bash
curl -s localhost:3000/wallets/$WID -H "$AUTH"
```

`balance.amount` deve continuar `"70.00"`.

### 4.2 Mesma key, payload diferente → conflito

```bash
SUBMIT bet-1 BET 35.00 round-1
```

**Esperado:** não é replay, é violação de contrato:

```json
{"statusCode":409,"error":"IdempotencyConflictError","failureCode":"IDEMPOTENCY_CONFLICT","message":"..."}
[409]
```

---

## 5. Rejeição de negócio: saldo insuficiente

Saldo atual: 70.00. Aposte 500.00:

```bash
SUBMIT bet-2 BET 500.00 round-2
```

**Esperado (HTTP 422):** rejeição **auditável** (a transação existe, com `failureCode`), saldo intacto:

```json
{"transactionId":"<uuid>","status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
[422]
```

O replay de uma rejeição também devolve o resultado original: repita o comando e veja o mesmo 422 com `idempotentReplay: true`.

---

## 6. WIN e LOSS

```bash
SUBMIT win-1 WIN 45.00 round-1 bet-1     # WIN referenciando a BET da rodada
SUBMIT loss-1 LOSS 10.00 round-2         # LOSS: registra resultado, não move saldo
```

**Esperado:**

- WIN → `[200]`, `PROCESSED`, saldo `70.00 + 45.00 = "115.00"`;
- LOSS → `[200]`, `PROCESSED`, mas `balance` **continua `"115.00"`** — LOSS não gera débito nem crédito, nem lançamento no ledger.

---

## 7. REFUND — reverte a BET uma única vez

```bash
SUBMIT refund-1 REFUND 30.00 round-1 bet-1
```

**Esperado:** `[200]`, `PROCESSED`, saldo `115.00 + 30.00 = "145.00"`.

### 7.1 Segunda reversão do mesmo tipo → rejeitada

```bash
SUBMIT refund-2 REFUND 30.00 round-1 bet-1
```

**Esperado (HTTP 422):**

```json
{"...":"...","status":"REJECTED","failureCode":"REFERENCE_ALREADY_REVERSED","balance":{"amount":"145.00","currency":"BRL"}}
[422]
```

### 7.2 Valor diferente da referência → rejeitado

```bash
SUBMIT bet-3 BET 20.00 round-3
SUBMIT refund-3 REFUND 15.00 round-3 bet-3
```

**Esperado:** a BET passa (`[200]`, saldo `"125.00"`); o REFUND de valor parcial é rejeitado:

```json
{"...":"...","status":"REJECTED","failureCode":"AMOUNT_MISMATCH","...":"..."}
[422]
```

### 7.3 REFUND sem referência → payload inválido

```bash
SUBMIT refund-4 REFUND 20.00 round-3
```

**Esperado:** `[400]` — `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`.

---

## 8. Fora de ordem: ROLLBACK chega antes da BET

Este é o cenário de entrega at-least-once fora de ordem. O ROLLBACK referencia uma BET que **ainda não chegou**:

```bash
RB=$(curl -s -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -H 'Idempotency-Key: provider-a:ooo-rb' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"ooo-rb\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"round-9\",\"gameId\":\"fortune-chimp\",\"kind\":\"ROLLBACK\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"ooo-bet\"}")
echo $RB
RBID=$(echo $RB | sed -E 's/.*"transactionId":"([^"]+)".*/\1/')
```

**Esperado (HTTP 202):** aceita, aguardando a referência:

```json
{"transactionId":"<uuid>","status":"PENDING_REFERENCE","idempotentReplay":false}
```

Agora a BET referenciada chega:

```bash
SUBMIT ooo-bet BET 25.00 round-9
```

**Esperado:** `[200]`, saldo `125.00 - 25.00 = "100.00"`.

O **worker** resolve a pendência sozinho (poll de 2 s + backoff). Acompanhe:

```bash
until curl -s localhost:3000/wagering/transactions/$RBID -H "$AUTH" | grep -q '"status":"PROCESSED"'; do sleep 2; done
curl -s localhost:3000/wagering/transactions/$RBID -H "$AUTH"
```

**Esperado (em segundos):** o ROLLBACK virou `PROCESSED`, com `referenceTransactionId` preenchido e o crédito devolvido — saldo de volta a `"125.00"`:

```json
{"transactionId":"<uuid>","kind":"ROLLBACK","status":"PROCESSED","referenceTransactionId":"<uuid da BET>","balance":{"amount":"125.00","currency":"BRL"},"...":"..."}
```

> **Variação:** se a referência nunca chegar, após 8 tentativas (~15 min) o status final é `REJECTED` com `failureCode: REFERENCE_NOT_FOUND`.

---

## 9. Ledger e reconciliação

### 9.1 Extrato paginado (cursor opaco)

```bash
curl -s "localhost:3000/wallets/$WID/ledger?limit=3" -H "$AUTH"
```

**Esperado:** os 3 lançamentos mais recentes, cada um com `direction`, `money`, `balanceBefore`/`balanceAfter` **encadeados** (o `balanceAfter` de um é o `balanceBefore` do seguinte), e um `nextCursor` opaco. Próxima página:

```bash
CURSOR=$(curl -s "localhost:3000/wallets/$WID/ledger?limit=3" -H "$AUTH" | sed -E 's/.*"nextCursor":"([^"]+)".*/\1/')
curl -s "localhost:3000/wallets/$WID/ledger?limit=3&cursor=$CURSOR" -H "$AUTH"
```

Observe que **não há lançamento** para o LOSS nem para as transações REJECTED.

### 9.2 Reconciliação: a prova final

```bash
curl -s -X POST localhost:3000/wallets/$WID/reconciliation -H "$AUTH"
```

**Esperado — este é o teste-mãe do sistema:**

```json
{
  "walletId": "<uuid>",
  "storedBalance":     { "amount": "125.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "125.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 7
}
```

`consistent: true` significa que o saldo materializado é **exatamente** o que o ledger reconstrói. Rode depois de qualquer sequência de operações — deve ser sempre `true`.

---

## 10. Entrada via SQS (fila, não HTTP)

Envie a mesma operação pelo canal assíncrono — e uma **duplicata** dela, simulando at-least-once:

```bash
BODY="{\"messageId\":\"msg-manual-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-31T15:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"sqs-bet-1\",\"idempotencyKey\":\"provider-a:sqs-bet-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"round-sqs\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

docker exec backend-challenge-junglegaming-localstack-1 awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-body "$BODY" --message-group-id "$WID" --message-deduplication-id m1 > /dev/null

docker exec backend-challenge-junglegaming-localstack-1 awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-body "$BODY" --message-group-id "$WID" --message-deduplication-id m2 > /dev/null

sleep 6
curl -s localhost:3000/wallets/$WID -H "$AUTH"
```

**Esperado:** o saldo caiu **uma única vez** (125.00 → `"115.00"`), apesar das duas mensagens — a inbox persistente + idempotency key deduplicam. Consulte a transação criada pela fila:

```bash
curl -s localhost:3000/providers/provider-a/wagering/transactions/sqs-bet-1 -H "$AUTH"
```

**Esperado:** `"status":"PROCESSED"`, `"money":{"amount":"10.00",...}`.

### 10.1 Eventos publicados (transactional outbox)

Tudo que aconteceu gerou eventos na fila `wager-events.fifo`:

```bash
docker exec backend-challenge-junglegaming-localstack-1 awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events.fifo \
  --max-number-of-messages 10 --wait-time-seconds 2 \
  | grep -oE '\\\\"eventType\\\\":\\\\"[A-Za-z]+' | sed 's/.*"//' | sort | uniq -c
```

**Esperado:** contagens de `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` — os eventos só são publicados **depois** do commit, pelo worker da outbox.

---

## 11. Concorrência: duas apostas disputando o mesmo saldo

Cenário obrigatório do desafio. Crie uma wallet nova com 100.00 e dispare duas BETs de 80.00 **ao mesmo tempo**:

```bash
PLAYER2=0192f28f-5dc0-7d58-bdb2-814ad6a0f4e1
W2=$(curl -s -X POST localhost:3000/wallets -H "$AUTH" -H "$CT" \
  -d "{\"playerId\":\"$PLAYER2\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
WID2=$(echo $W2 | sed -E 's/.*"id":"([^"]+)".*/\1/')

RACE() { curl -s -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -H "Idempotency-Key: provider-a:$1" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER2\",\"walletId\":\"$WID2\",\"roundId\":\"race\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"; echo; }

RACE race-a & RACE race-b & wait
curl -s -X POST localhost:3000/wallets/$WID2/reconciliation -H "$AUTH"
```

**Esperado (a ordem das duas linhas pode variar):**

- exatamente **uma** resposta `"status":"PROCESSED"` com `"balance":{"amount":"20.00",...}`;
- exatamente **uma** resposta `"status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS"`;
- reconciliação com `storedBalance: "20.00"`, `consistent: true` e **um único débito** (checkedEntries: 2 — abertura + 1 débito).

Nunca deve acontecer: duas PROCESSED, saldo negativo ou dois débitos.

> Para o mesmo teste com **3 instâncias em processos separados** (mais forte), rode a suíte automatizada: `bun run test:concurrency`.

---

## 12. Validação de payload (borda)

```bash
# amount como número (proibido — dinheiro nunca é number)
curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -H 'Idempotency-Key: provider-a:bad-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bad-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":25,\"currency\":\"BRL\"}}"

# sem o header Idempotency-Key
curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bad-2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# kind OPENING é interno — não pode ser submetido
curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -H 'Idempotency-Key: provider-a:bad-3' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bad-3\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"OPENING\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# moeda diferente da wallet → rejeição de negócio auditável
SUBMIT usd-1 BET 10.00 round-usd; true
curl -s -w '\n[%{http_code}]' -X POST localhost:3000/wagering/transactions -H "$AUTH" -H "$CT" \
  -H 'Idempotency-Key: provider-a:usd-2' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"usd-2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WID\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"USD\"}}"
```

**Esperado, na ordem:** `[400]` (amount numérico), `[400]` (header obrigatório ausente), `[400]` (OPENING fora da lista aceita) e `[422]` com `"failureCode":"CURRENCY_MISMATCH"`.

---

## 13. Observabilidade

```bash
curl -s localhost:3000/metrics | grep -E '^wager_transactions_total|^wager_idempotent_replays_total|^sqs_consumer_messages_total|^outbox_published_total'
```

**Esperado:** contadores refletindo tudo que você fez neste guia, por exemplo:

```
wager_transactions_total{status="PROCESSED",kind="BET",channel="http"} 4
wager_transactions_total{status="REJECTED",kind="REFUND",channel="http"} 2
wager_idempotent_replays_total{channel="http"} 1
sqs_consumer_messages_total{outcome="processed"} 1
outbox_published_total 20
```

Os logs da aplicação são JSON estruturado — cada requisição carrega `correlationId` (propague o seu enviando o header `x-correlation-id`).

---

## 14. Suítes automatizadas (resumo)

Tudo acima também é coberto por testes automatizados, mais os cenários difíceis de reproduzir manualmente (crash entre commit e ack, DLQ, publishers concorrentes, restart):

```bash
bun test src              # 68 testes de unidade
bun run test:integration  # 25 testes contra Postgres + LocalStack reais
bun run test:concurrency  # 4 testes com 3 instâncias reais em paralelo
```

**Esperado:** `0 fail` nas três suítes.

---

## Tabela-resumo dos cenários

| # | Cenário                                   | Status esperado | Sinal de que está correto                            |
|---|-------------------------------------------|-----------------|------------------------------------------------------|
| 1 | Requisição sem token                      | 401             | guard Keycloak ativo                                 |
| 2 | Criar wallet                              | 201, version 1  | saldo inicial + lançamento OPENING                   |
| 2.1 | Wallet duplicada                        | 409             | constraint `(player, currency)`                      |
| 3 | BET com saldo                             | 200 PROCESSED   | saldo debitado uma vez                               |
| 4.1 | Replay exato                            | 200, `idempotentReplay: true` | mesmo transactionId, saldo não cai de novo |
| 4.2 | Mesma key, payload diferente            | 409             | `IDEMPOTENCY_CONFLICT`                               |
| 5 | BET sem saldo                             | 422 REJECTED    | `INSUFFICIENT_FUNDS`, saldo intacto                  |
| 6 | WIN / LOSS                                | 200 PROCESSED   | WIN credita; LOSS não muda saldo nem gera ledger     |
| 7 | REFUND 1ª vez / 2ª vez / valor errado     | 200 / 422 / 422 | `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`      |
| 8 | ROLLBACK antes da BET                     | 202 → PROCESSED | worker resolve sozinho em segundos                   |
| 9 | Reconciliação                             | 200             | `consistent: true`, `difference: 0.00` sempre        |
| 10 | Mensagem SQS + duplicata                 | —               | um único débito; eventos na `wager-events.fifo`      |
| 11 | Duas BETs de 80 sobre 100 em paralelo    | 200 + 422       | uma processada, uma rejeitada, saldo 20.00           |
| 12 | Payloads inválidos                       | 400 / 422       | borda e domínio rejeitando com códigos distintos     |
