import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { METRICS, type Metrics } from '@config/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '@app/repositories/unit-of-work';
import { CLOCK, type Clock } from '@app/system';
import { APP_CONFIG, type AppConfig } from '@config/app-config';
import { SQS_CLIENT } from '@infra/sqs/sqs-client';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 20;

@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisher.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workers.outboxPublisher) return;
    this.running = true;
    this.loop = this.publishLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async publishLoop(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.publishDueBatch();
        if (published === 0) await Bun.sleep(POLL_INTERVAL_MS);
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ err: error }, 'Falha no publisher da outbox');
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  async publishDueBatch(): Promise<number> {
    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const due = await repos.outbox.claimDue(BATCH_SIZE, now);
      let published = 0;

      for (const message of due) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.config.sqs.eventsQueueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );
          message.markPublished(this.clock.now());
          published += 1;
        } catch (error) {
          this.logger.warn(
            {
              err: error,

              correlationId: message.aggregateId,
              outboxId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
            },
            'Falha ao publicar evento — retry com backoff',
          );
          message.scheduleRetry(this.clock.now());
          this.metrics.outboxRetry();
        }
        await repos.outbox.save(message);
      }

      if (published > 0) this.metrics.outboxPublished(published);
      return published;
    });
  }
}
