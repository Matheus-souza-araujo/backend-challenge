import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '@app/errors/errors';
import { METRICS, type Metrics } from '@config/metrics';
import { WageringService } from '@app/wagering/wagering.service';
import { APP_CONFIG, type AppConfig } from '@config/app-config';
import { DomainError } from '@domain/errors';
import { WagerTransactionKind } from '@domain/wager-transaction';
import { SQS_CLIENT } from '@infra/sqs/sqs-client';
import { isTransientInfraError } from '@interface/http/common/app-exception.filter';

export const CONSUMER_NAME = 'wager-transactions-consumer';

interface WagerQueueEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

@Injectable()
export class WagerConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerConsumer.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly wagering: WageringService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workers.sqsConsumer) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const { Messages } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.sqs.wagerQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5,
          }),
        );
        for (const message of Messages ?? []) {
          if (!this.running) {
            await this.releaseVisibility(message);
            continue;
          }
          await this.handle(message);
        }
      } catch (error) {
        if (!this.running) break;
        this.logger.error(
          { err: error },
          'Falha no poll do SQS — aguardando para tentar de novo',
        );
        await Bun.sleep(2000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle) return;

    let envelope: WagerQueueEnvelope;
    try {
      envelope = this.parseEnvelope(message.Body ?? '');
    } catch (error) {
      this.logger.warn(
        { err: error, sqsMessageId: message.MessageId },
        'Mensagem malformada — ack',
      );
      this.metrics.consumerOutcome('malformed');
      await this.ack(receiptHandle);
      return;
    }

    const messageId = envelope.messageId ?? message.MessageId ?? '';
    const { data } = envelope;

    try {
      const result = await this.wagering.submit({
        idempotencyKey:
          data.idempotencyKey ??
          `${data.providerId}:${data.externalTransactionId}`,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind as WagerTransactionKind,
        money: data.money,
        ...(data.referenceExternalTransactionId !== undefined
          ? {
              referenceExternalTransactionId:
                data.referenceExternalTransactionId,
            }
          : {}),
        correlationId: messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId },
      });

      await this.ack(receiptHandle);
      this.metrics.consumerOutcome('processed');
      this.logger.log(
        {
          correlationId: messageId,
          messageId,
          transactionId: result.transactionId,
          walletId: data.walletId,
          providerId: data.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        },
        'Mensagem processada',
      );
    } catch (error) {
      if (this.isTerminalBusinessError(error)) {
        this.logger.warn(
          {
            err: error,
            correlationId: messageId,
            messageId,
            providerId: data.providerId,
            walletId: data.walletId,
          },
          'Erro de negócio terminal — ack',
        );
        this.metrics.consumerOutcome('business_error');
        await this.ack(receiptHandle);
        return;
      }

      this.metrics.consumerOutcome('transient_error');
      this.logger.error(
        { err: error, correlationId: messageId, messageId },
        'Erro transitório — mensagem voltará à fila',
      );
    }
  }

  private parseEnvelope(body: string): WagerQueueEnvelope {
    const parsed = JSON.parse(body) as WagerQueueEnvelope;
    const data = parsed.data;
    if (typeof parsed.messageId !== 'string' || parsed.messageId === '') {
      throw new Error('messageId ausente');
    }
    if (parsed.type !== 'WagerTransactionRequested') {
      throw new Error(`type desconhecido: ${String(parsed.type)}`);
    }
    if (typeof data !== 'object' || data === null)
      throw new Error('data ausente');
    for (const field of [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ] as const) {
      if (typeof data[field] !== 'string' || data[field] === '') {
        throw new Error(`campo obrigatório ausente: ${field}`);
      }
    }
    if (!SUBMITTABLE_KINDS.has(data.kind))
      throw new Error(`kind inválido: ${String(data.kind)}`);
    if (
      typeof data.money?.amount !== 'string' ||
      typeof data.money?.currency !== 'string'
    ) {
      throw new Error('money inválido');
    }
    return parsed;
  }

  private isTerminalBusinessError(error: unknown): boolean {
    if (isTransientInfraError(error)) return false;
    return (
      error instanceof DomainError ||
      error instanceof IdempotencyConflictError ||
      error instanceof WalletNotFoundError
    );
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.sqs.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async releaseVisibility(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.sqs.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Falha ao devolver visibilidade no shutdown',
      );
    }
  }
}
