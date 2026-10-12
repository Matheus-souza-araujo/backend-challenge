# ARCHITECTURE

Decisões técnicas, garantias e trade-offs do Distributed Wagering Processor.

## 1. Visão geral

Arquitetura hexagonal enxuta em quatro camadas, montada com módulos idiomáticos de NestJS:

- **domain/** — modelo puro, **sem NestJS nem ORM** (§6.1 do desafio). Construtores privados + factories (`create`/`from`/`rehydrate`); `rehydrate` reconstrói estado persistido sem revalidar transições. As invariantes vivem nas classes: `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração.
- **application/** — um service por feature (`WalletsService`, `WageringService`), o `IntegrationEventsService` compartilhado e os contratos que eles exigem do mundo externo: `repositories/` (uma interface por repositório, mais o `UnitOfWork`), `system.ts` (`Clock`, `IdGenerator`) e `metrics.ts`. `WageringService` atende HTTP e SQS com o **mesmo** caso de uso (exigência §10).
- **infrastructure/** — MikroORM (EntitySchema + migrations SQL manuais), SQS, métricas Prometheus, relógio/ids.
- **interface/** — controllers HTTP por feature (+ DTOs, guard, filter, health indicators) e os processos de mensageria.
- **modules/** — o wiring do Nest, separado das camadas para não sujar nenhuma delas: `core`, `persistence`, `observability`, `sqs`, `integration-events`, `wallets`, `wagering`, `messaging`, `health`. O `AppModule` só compõe.

A direção de dependência é sempre para dentro: a infraestrutura implementa contratos **definidos na aplicação** — quem consome declara o que precisa, quem persiste se conforma (inclusive os erros de persistência tipados, `UniqueViolationError`/`ForeignKeyViolationError`, definidos em `application/errors/persistence-errors.ts` e lançados pela infra). Cada interface em `application/repositories/` tem seu adapter homônimo em `infrastructure/persistence/repositories/`.

### Imports: aliases por camada, sem barrels

Cada camada tem um alias em `tsconfig.json` (`@domain`, `@app`, `@infra`, `@interface`, `@modules`, `@config`, `@test`). A regra é simples: **cruzou de pasta, usa alias; mesmo diretório, continua relativo**. Isso mata os `../../../` e faz a camada de destino aparecer no próprio import — `@domain/money` deixa explícito que se está tocando o domínio.

Não há arquivos `index.ts` de barrel. O barrel economiza caracteres, mas esconde de onde o símbolo vem, cria uma ordem de import implícita entre módulos e faz qualquer mudança na pasta invalidar o cache de quem importa. Com alias o import já é curto, então o barrel perdeu a razão de existir: cada import aponta para o arquivo que **define** o símbolo (`@app/repositories/unit-of-work`, não `@app/repositories`).

Runtime: o Bun lê os `paths` do `tsconfig.json` nativamente, então os aliases valem em desenvolvimento, nos testes, nos scripts de migration e na imagem Docker (o `tsconfig.json` é copiado no build) — sem `tsconfig-paths` nem passo de bundling.

### Decomposição do fluxo de apostas

O caminho de uma transação tem quatro responsabilidades distintas, e cada uma vive onde pode ser lida e testada isoladamente:

| Peça | Camada | Responsabilidade |
| --- | --- | --- |
| [`checkReferenceRules`](src/domain/wager-reference-rules.ts) | domínio | regras 2–5 da §7 sobre a referência — decisão pura, sem I/O |
| [`applyTransactionToWallet`](src/domain/wallet-movement.ts) | domínio | direção do lançamento, débito/crédito e a §7 regra 9 (código distinto para reversão que negativaria o saldo) |
| [`WagerSettlement`](src/application/wagering/wager-settlement.ts) | aplicação | liquidar: aplicar no saldo, gravar ledger, emitir eventos, persistir rejeição |
| [`WageringService`](src/application/wagering/wagering.service.ts) | aplicação | idempotência, lock da wallet e fronteira transacional |
| [`PendingReferencesService`](src/application/wagering/pending-references.service.ts) | aplicação | §7.1 — reivindicar pendências, backoff, esgotamento |

Duas coisas motivaram essa separação. Primeiro, **as regras de negócio estavam num service** em vez do domínio, contrariando "invariantes encapsuladas em classes" — agora são funções puras com teste de unidade próprio. Segundo, **a aplicação no saldo estava duplicada** entre o fluxo de submissão e o de resolução de referência pendente: os dois liquidam, e agora compartilham o `WagerSettlement`, que é o único lugar onde saldo, ledger e eventos se movem juntos.

O `PendingReferencesService` é um caso de uso próprio porque tem gatilho diferente: roda agendado e em lote, reivindicando com `FOR UPDATE SKIP LOCKED`, enquanto a submissão é request/response. Ele consome o mesmo `WagerSettlement`.

### Trade-off: `@Injectable()` na camada de aplicação

Os services de `application/` carregam `@Injectable()` e `@Inject(TOKEN)`, ou seja, a camada importa `@nestjs/common`. Foi uma escolha consciente: elimina os `useFactory` que apenas repetiam `new Classe(...)` no módulo e devolve ao projeto a DI idiomática do Nest. O que **não** muda com isso:

- o **domínio** segue 100% livre de framework — é onde a restrição do desafio existe;
- a inversão de dependência continua intacta: os services dependem de interfaces (`UnitOfWork`, `WalletRepository`, `Clock`, `Metrics`), nunca de implementações;
- os testes continuam construindo os services com `new`, sem container — o decorator não impede instanciação direta (ver [test/helpers/context.ts](test/helpers/context.ts)).

### Configuração e health

`@nestjs/config` carrega um namespace `app` cujo factory é o `loadAppConfig()` de [src/config/app-config.ts](src/config/app-config.ts) — a validação fail-fast continua sendo a mesma função, agora dentro do ciclo do Nest. O token `APP_CONFIG` foi preservado, então os pontos de injeção não mudaram.

Health usa `@nestjs/terminus` (API v11, `HealthIndicatorService`) com dois indicators próprios — PostgreSQL (`SELECT 1`) e SQS (`GetQueueAttributes`). A resposta segue o formato do Terminus (`{ status, info, error, details }`), e os endpoints permanecem `@Public()` como o desafio exige.

## 2. Money e precisão monetária

- `Money` embrulha `decimal.js`; **`number` nunca representa dinheiro** em nenhum ponto do sistema (restrição eliminatória).
- Contratos de entrada aceitam apenas string decimal não-negativa com **exatamente 2 casas** (`^\d{1,16}\.\d{2}$`) — NaN, Infinity, notação científica, vazio e >2 casas são rejeitados na borda e na factory.
- Persistência: `NUMERIC(18,2)` + `CHAR(3)` em colunas separadas; o driver do PostgreSQL devolve `NUMERIC` como string, que é reidratada em `Money` — nenhuma conversão por float em ponto algum.
- Runtime opera em `BRL`, mas o modelo é multi-moeda: misturar moedas lança `CurrencyMismatchError` (testado), e wallet tem `UNIQUE (player_id, currency)`.
- MikroORM foi escolhido sobre TypeORM (preferência do desafio): `em.transactional()` explícito, `LockMode` de primeira classe e mapeamento por `EntitySchema` — o domínio não conhece o ORM e não há dependência de decorators/metadata sob Bun.

## 3. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** — `SELECT ... FOR UPDATE` na wallet (`LockMode.PESSIMISTIC_WRITE`) dentro da transação SQL do processamento.

Por quê pessimista:

- o hot path de uma wallet disputada é inerentemente serial (o saldo é um recurso único); lock de linha serializa exatamente o que precisa ser serial e nada mais (sem lock global — restrição §5.6);
- é trivial de raciocinar: nenhuma janela de lost update, nenhuma política de retry/jitter para calibrar;
- wallets diferentes seguem paralelas (locks de linhas distintas), e `LOSS` nem adquire lock (não afeta saldo).

Defesas em profundidade (o banco é a garantia final — §5.9):

| Invariante                                | Mecanismo no schema                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| saldo nunca negativo                      | `CHECK (balance >= 0)`                                                 |
| 1 wallet por player+moeda                 | `UNIQUE (player_id, currency)`                                         |
| 1 transação por idempotency key           | `UNIQUE (idempotency_key)`                                             |
| 1 transação por (provider, external_id)   | `UNIQUE (provider_id, external_transaction_id)`                        |
| 1 reversão aplicada por (referência,kind) | índice único parcial `WHERE status='PROCESSED' AND kind IN (...)`      |
| 1 lançamento por (transação, wallet)      | `UNIQUE (transaction_id, wallet_id)`                                   |
| aritmética do lançamento                  | `CHECK (balance_after = balance_before ± amount)`                      |
| ledger imutável                           | trigger `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`                  |
| dedup de mensagens                        | `PRIMARY KEY (consumer_name, message_id)`                              |

A coluna `version` da wallet existe (inicia em 1, incrementa quando o saldo muda) e é exposta na API/eventos; com o lock pessimista ela não é usada como CAS, mas permanece como contrato e permitiria migrar para optimistic locking sem mudança de schema.

**Corridas entre instâncias** (mesma idempotency key, mesma reversão, mesma mensagem): ambas passam nas checagens de leitura, uma comita, a outra estoura `UNIQUE` → o `WagerTransactionProcessor` captura `UniqueViolationError` das constraints de corrida e **reexecuta o comando uma vez**; a segunda passada resolve deterministicamente como replay/conflito/rejeição. Métrica `wager_race_retries_total` conta essas ocorrências.

## 4. Idempotência

- Header `Idempotency-Key` obrigatório (fonte da verdade); default recomendado `{providerId}:{externalTransactionId}`.
- `payloadHash` = **SHA-256 de um JSON canônico** — chaves ordenadas recursivamente, `undefined` omitido, sem espaços — do subconjunto de campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header e metadados de transporte ficam fora do hash (`src/domain/idempotency/payload-hash.ts`).
- Mesma key + payload igual → **replay**: resposta original completa, incluindo o saldo observado no desfecho (persistido em `observed_balance`), com `idempotentReplay: true` e o mesmo status HTTP.
- Mesma key + payload diferente → **409**, `IDEMPOTENCY_CONFLICT`, nada é persistido.
- Nada disso vive em memória: a verificação lê `wager_transactions` e a corrida é decidida pelo `UNIQUE` do banco.

## 5. Fluxo de processamento (uma transação SQL)

```
BEGIN
  1. inbox lookup (se origem SQS)          → duplicata? replay
  2. lookup por idempotency_key            → replay ou 409
  3. WagerTransaction.create (PENDING)     → validações estruturais
  4. wallet FOR UPDATE (se afeta saldo)
  5. INSERT da transação                   → UNIQUE decide corridas
  6. settle: referência → regras → débito/crédito → ledger
  7. UPDATE wallet + UPDATE transação (desfecho terminal)
  8. INSERT outbox (eventos) + INSERT inbox (se SQS)
COMMIT                                     → só então ack/resposta
```

Rejeições de negócio são **persistidas e auditáveis** (`REJECTED` + `failureCode` + evento), nunca exceção sem rastro. Reversão que negativaria o saldo rejeita com `REVERSAL_WOULD_OVERDRAW` — código distinto de `INSUFFICIENT_FUNDS` (regra 9, §7).

### Referências fora de ordem (§7.1)

`REFUND`/`ROLLBACK` (e `WIN` com referência) cuja referência não existe ou ainda não é terminal → `PENDING_REFERENCE` + evento. Um worker reivindica pendências com `FOR UPDATE SKIP LOCKED` e reprocessa com backoff exponencial `min(5s·2^n, 300s)`; após **8 tentativas** (~15 min de TTL efetivo) → `REJECTED` com `REFERENCE_NOT_FOUND` + evento. Os metadados de agendamento (`reference_retry_count`, `reference_next_retry_at`) são colunas de infraestrutura, não estado de domínio.

### Taxonomia de failure codes (§7.2)

Documentada em `src/domain/failure-code.ts`: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `MISSING_REFERENCE`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `WALLET_OWNERSHIP_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ERROR` — cada um com a ação sugerida ao provedor (reenviar / corrigir / desistir).

## 6. Mensageria

### Consumer (`wager-transactions.fifo`)

- Reusa o mesmo use case do HTTP; dedup por **inbox persistente** `(consumer_name, message_id)` gravada na mesma transação SQL do efeito.
- **Ack somente após o commit.** Worker que morre entre commit e ack: o redelivery encontra a inbox, responde replay e faz o ack — débito único (testado).
- Classificação de erros: **negócio** (DomainError, conflito, wallet inexistente) → terminal, ack; **transitório** (conexão, deadlock) → sem ack, visibilidade expira, redelivery; **permanente** → após `maxReceiveCount=5`, SQS move para a DLQ FIFO.
- Payload malformado → ack imediato (lixo determinístico não pertence à DLQ de infra) + métrica.
- `SIGTERM`: para de puxar, conclui as mensagens em andamento e devolve a visibilidade das não processadas (`ChangeMessageVisibility 0`).

### Transactional outbox (§11)

Evento de integração = linha em `outbox_messages` gravada **na mesma transação** do efeito financeiro — publicar antes do commit é impossível por construção. O publisher:

- reivindica lotes com `FOR UPDATE SKIP LOCKED` → múltiplos publishers nunca seguram a mesma linha;
- publica em `wager-events.fifo` (fila criada por decisão nossa — o desafio não fixa o destino) com `MessageDeduplicationId = eventId`;
- crash entre publicar e marcar `published_at` → a linha continua pendente e outra instância republica; duplicação é segura porque o `eventId` do envelope é estável (consumidor dedupa);
- falha de publicação → `scheduleRetry` com backoff exponencial (5s→300s), sem perda.

Ordenação FIFO/dedup do broker é otimização; a garantia é o banco (§8).

### Eventos

`WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando saldo muda), `WagerTransactionPendingReference`. Envelope: classe abstrata `IntegrationEvent<T>` com `eventType`/`version` **no tipo**; `data` carrega `MoneyProps` (string), nunca instâncias.

## 7. Autenticação

Integração com **Keycloak** (IdP externo — sem tabela própria de usuários):

- realm `wagering` importado no compose; providers são **service accounts** (client credentials) com audience `wagering-api`;
- guard global valida assinatura via **JWKS remoto** (jose), issuer e audience; `/health/*` e `/metrics` são `@Public()`;
- mensagens da fila são canal interno confiável (§2) — a identidade do provedor no payload segue sujeita às validações de domínio (ownership, referência do mesmo provider);
- ponto de extensão explícito: `AUTH_ENABLED=false` torna o guard no-op (útil em dev/teste), sem tocar no restante do sistema.

Limitação consciente: não há autorização fina por provider (ex.: `provider-a` só submeter transações próprias via claim ↔ payload). O gancho natural é o guard anexar o token ao request e a borda comparar `azp`/claim com `providerId`.

## 8. Observabilidade

- **Logs**: JSON estruturado (pino) com `correlationId` (header `x-correlation-id` ou gerado), `messageId`, `transactionId`, `walletId`, `providerId`; `authorization` e corpo das requisições são redigidos — sem payload financeiro completo em log.
- **Métricas** (`/metrics`, Prometheus): transações por status/kind/canal, replays (duplicatas), corridas perdidas por constraint, latência de processamento, desfechos do consumer, publicações/retries da outbox, resoluções de referência pendente, divergências de reconciliação, e gauges observados por polling — profundidade da DLQ e **outbox lag**.
- **Health**: `/health/live` (processo) e `/health/ready` (PostgreSQL + SQS alcançáveis), sem autenticação.

### Dashboard (Grafana + Prometheus + Loki)

Sobe num profile opcional do compose (`--profile observability`), para não pesar a stack de avaliação. Grafana já vem com datasources e o dashboard **provisionados** — abre pronto, sem cliques.

Três decisões que valem registro, porque erradas dão número errado:

1. **Descoberta das réplicas por DNS.** O serviço `app` publica a porta 3000 em porta efêmera do host, então não há alvo fixo para o Prometheus. O scrape usa `dns_sd_configs` type A sobre o nome do serviço: o DNS do Docker resolve para os IPs de **todas** as réplicas, e `--scale app=3` vira 3 targets automaticamente.
2. **`max()` nos gauges, `sum()` nos counters.** `sqs_dlq_depth` e `outbox_lag_seconds` são valores **globais** — cada réplica faz o mesmo polling e reporta o mesmo número. Somá-los mostraria o triplo da fila. Já os counters (`wager_transactions_total` etc.) são por instância e precisam de `sum(rate(...))`.
3. **`level` textual no pino.** O padrão do pino é numérico (`50`); com `formatters.level` ele emite `"error"`, que o promtail promove a label do Loki. É o que torna o filtro de erros legível no dashboard.

O `collectDefaultMetrics` do prom-client alimenta a linha de runtime (CPU, heap, event loop lag) no mesmo registry das métricas de negócio — um scrape só.

Para rastreio ponta a ponta, o `correlationId` agora aparece também nos logs do consumer SQS e dos workers (antes só os logs HTTP o tinham, via `customProps`): o consumer usa o `messageId` e o publisher o `aggregateId`, os mesmos valores que já eram propagados para os services.

### Teste de carga

`bun run test:load` ([scripts/load-test.ts](scripts/load-test.ts)) gera tráfego contra várias réplicas em round-robin e reporta throughput, p50/p95/p99, taxa de erro e distribuição por desfecho. O mix é deliberadamente adverso: replays idempotentes com payload **idêntico** (senão viram conflito, não replay), rajadas da mesma Idempotency-Key em paralelo contra réplicas diferentes — a única forma de produzir corrida real entre instâncias —, apostas sem saldo e uma fração entrando pela fila SQS.

## 9. Reconciliação

`POST /wallets/:id/reconciliation` recalcula o saldo pelo ledger (`SUM` por direção, em SQL, casts para string — sem float) sob lock da wallet para snapshot consistente. Divergência **não é corrigida**: é logada, contada em métrica e sinalizada na resposta. A invariante `wallet.balance == saldo do ledger` fecha todos os testes de integração/concorrência.

## 10. Testes

- **Unidade** (`bun test src`): Money (escala/entradas inválidas/moedas), invariantes de Wallet, máquina de estados e regras por kind, aritmética do ledger, backoff da outbox, hash canônico.
- **Integração** (PostgreSQL + LocalStack **reais**): violação deliberada de cada constraint; atomicidade (crash injetado antes do commit → nada persiste); inbox/redelivery; out-of-order + esgotamento de retries; publishers concorrentes na mesma outbox; retry/DLQ do consumer; worker morto entre commit e ack; recuperação pós-restart com contexto novo.
- **Concorrência** (3 **processos reais** da aplicação): a mesma aposta 50× em paralelo → um débito; cenário obrigatório §8 (100.00, duas de 80.00 → uma PROCESSED, uma REJECTED, saldo 20.00, um débito); wallets distintas em paralelo; reversão dupla concorrente decidida pelo índice único.

## 11. Trade-offs e limitações conhecidas

- **Escritas explícitas dentro do UoW**: INSERTs/UPDATEs via `em.insert`/`em.nativeUpdate` em vez do flush implícito do Unit of Work — em fluxo financeiro o *momento* de cada escrita importa (ponto de detecção da corrida de idempotência, ordem de FKs). O `em.transactional()` continua provendo a fronteira ACID; perde-se o batching automático do flush, irrelevante nesse volume por transação.
- **Lock pessimista** sacrifica throughput teórico em wallet extremamente quente (fila no lock) em troca de correção simples; a migração para otimista+retry está preparada pela coluna `version`.
- **Replay devolve o desfecho, não o processo**: uma transação `PENDING_REFERENCE` re-submetida devolve o status atual (que pode já ter avançado) — comportamento documentado e coerente com "resultado original" para estados terminais.
- **Ledger de partida simples** (uma perna por movimento); double-entry era diferencial opcional e o `CHECK` + imutabilidade cobrem a auditabilidade exigida.
- **DLQ sem replayer**: mensagens na DLQ são visíveis por métrica, mas o reprocessamento é manual (aceitável no escopo; automatizar seria um worker de redrive).
- **Autorização fina por provider** não implementada (ver §7).
- **Teste de carga** (diferencial opcional) não incluído por timebox.
