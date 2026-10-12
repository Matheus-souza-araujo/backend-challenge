import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import type {
  Channel,
  ConsumerOutcome,
  Metrics,
  PendingReferenceOutcome,
} from '@config/metrics';

@Injectable()
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações por desfecho',
    labelNames: ['status', 'kind', 'channel'],
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'wager_idempotent_replays_total',
    help: 'Duplicatas detectadas (replays idempotentes)',
    labelNames: ['channel'],
    registers: [this.registry],
  });
  private readonly races = new Counter({
    name: 'wager_race_retries_total',
    help: 'Corridas perdidas para outra instância (retry após violação de UNIQUE)',
    labelNames: ['constraint'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de transações',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  private readonly consumer = new Counter({
    name: 'sqs_consumer_messages_total',
    help: 'Mensagens consumidas por desfecho',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados pela outbox',
    registers: [this.registry],
  });
  private readonly outboxRetries = new Counter({
    name: 'outbox_retries_total',
    help: 'Retries de publicação da outbox',
    registers: [this.registry],
  });
  private readonly pendingReferences = new Counter({
    name: 'pending_reference_resolutions_total',
    help: 'Resoluções de referência pendente por desfecho',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Divergências entre saldo materializado e ledger',
    registers: [this.registry],
  });
  private readonly dlqDepth = new Gauge({
    name: 'sqs_dlq_depth',
    help: 'Mensagens na DLQ (aproximado)',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo da outbox',
    registers: [this.registry],
  });

  transactionOutcome(status: string, kind: string, channel: Channel): void {
    this.transactions.inc({ status, kind, channel });
  }
  idempotentReplay(channel: Channel): void {
    this.replays.inc({ channel });
  }
  raceRetry(constraint: string): void {
    this.races.inc({ constraint });
  }
  processingDuration(seconds: number): void {
    this.duration.observe(seconds);
  }
  consumerOutcome(outcome: ConsumerOutcome): void {
    this.consumer.inc({ outcome });
  }
  outboxPublished(count: number): void {
    this.outboxPublishedCounter.inc(count);
  }
  outboxRetry(): void {
    this.outboxRetries.inc();
  }
  pendingReference(outcome: PendingReferenceOutcome): void {
    this.pendingReferences.inc({ outcome });
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  async observeGauges(
    em: EntityManager,
    sqs: SQSClient,
    dlqUrl: string,
  ): Promise<void> {
    const rows = await em.getConnection().execute(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::float AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    this.outboxLag.set(rows[0]?.lag ?? 0);

    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    this.dlqDepth.set(Number(Attributes?.ApproximateNumberOfMessages ?? 0));
  }
}
