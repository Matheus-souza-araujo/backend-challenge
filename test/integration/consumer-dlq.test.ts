import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { WageringService } from '@app/wagering/wagering.service';
import type {
  SubmitWagerCommand,
  SubmitWagerResult,
} from '@app/wagering/wagering.types';
import type { AppConfig } from '@config/app-config';
import { WagerConsumer } from '@interface/messaging/wager.consumer';
import {
  createTestContext,
  expectWalletLedgerInvariant,
  LOCALSTACK_ENDPOINT,
  resetDatabase,
  waitFor,
  type TestContext,
} from '@test/helpers/context';
import { useRealInfraTimeouts } from '@test/helpers/setup';

useRealInfraTimeouts();

let ctx: TestContext;
let sqs: SQSClient;
let queueUrl: string;
let dlqUrl: string;

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

function consumerConfig(): AppConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    databaseUrl: '',
    sqs: {
      endpoint: LOCALSTACK_ENDPOINT,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      wagerQueueUrl: queueUrl,
      wagerDlqUrl: dlqUrl,
      eventsQueueUrl: '',
    },
    auth: { enabled: false, issuer: '', audience: '', jwksUri: '' },
    workers: {
      sqsConsumer: true,
      outboxPublisher: false,
      pendingReferenceResolver: false,
    },
    runMigrationsOnBoot: false,
  };
}

async function depth(url: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

async function send(
  body: unknown,
  groupId: string,
  dedupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

function envelope(messageId: string, walletId: string, externalId: string) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: PLAYER,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
  };
}

async function withConsumer(
  consumer: WagerConsumer,
  fn: () => Promise<void>,
): Promise<void> {
  consumer.onApplicationBootstrap();
  try {
    await fn();
  } finally {
    await consumer.onApplicationShutdown();
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = new SQSClient({
    endpoint: LOCALSTACK_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
});
afterAll(async () => ctx.close());

beforeEach(async () => {
  await resetDatabase(ctx);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `consumer-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  dlqUrl = dlq.QueueUrl!;
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `consumer-main-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes!.QueueArn!,
          maxReceiveCount: 5,
        }),
      },
    }),
  );
  queueUrl = main.QueueUrl!;
});

describe('consumer SQS: ack pós-commit, redelivery e DLQ (§10)', () => {
  it('worker morre DEPOIS do commit e ANTES do ack: redelivery não duplica débito', async () => {
    const wallet = await ctx.wallets.open({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const crashingProcessor = {
      submit: async (cmd: SubmitWagerCommand): Promise<SubmitWagerResult> => {
        await ctx.wagering.submit(cmd);
        const crash = new Error('processo morto antes do ack') as Error & {
          code: string;
        };
        crash.code = 'ECONNRESET';
        throw crash;
      },
      resolveDuePendingReferences: ctx.pendingReferences.resolveDue.bind(
        ctx.pendingReferences,
      ),
    } as unknown as WageringService;

    await send(
      envelope('msg-crash', wallet.id, 'ext-crash'),
      wallet.id,
      'msg-crash',
    );

    const crashing = new WagerConsumer(
      sqs,
      consumerConfig(),
      crashingProcessor,
      ctx.metrics,
    );
    await withConsumer(crashing, async () => {
      await waitFor(
        async () =>
          (await ctx.wallets.findById(wallet.id)).balance.amount === '90.00',
        { label: 'commit da instância que vai morrer' },
      );
    });

    const healthy = new WagerConsumer(
      sqs,
      consumerConfig(),
      ctx.wagering,
      ctx.metrics,
    );
    await withConsumer(healthy, async () => {
      await waitFor(async () => (await depth(queueUrl)) === 0, {
        label: 'mensagem ackada após replay',
        timeoutMs: 30_000,
      });
    });

    expect((await ctx.wallets.findById(wallet.id)).balance.amount).toBe(
      '90.00',
    );
    const debits = await ctx.em
      .getConnection()
      .execute(
        `SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'`,
      );
    expect(debits[0]?.n).toBe(1);
    expect(await depth(dlqUrl)).toBe(0);
    await expectWalletLedgerInvariant(ctx, wallet.id);
  });

  it('mensagem malformada: ack terminal, nunca DLQ', async () => {
    await send('isto não é json', 'grupo', `malformed-${Date.now()}`);
    const consumer = new WagerConsumer(
      sqs,
      consumerConfig(),
      ctx.wagering,
      ctx.metrics,
    );
    await withConsumer(consumer, async () => {
      await waitFor(async () => (await depth(queueUrl)) === 0, {
        label: 'malformada ackada',
      });
    });
    expect(await depth(dlqUrl)).toBe(0);
  });

  it('erro de negócio terminal (wallet inexistente): ack, sem DLQ', async () => {
    await send(
      envelope(
        'msg-no-wallet',
        '99999999-9999-7999-8999-999999999999',
        'ext-nw',
      ),
      'grupo',
      'msg-no-wallet',
    );
    const consumer = new WagerConsumer(
      sqs,
      consumerConfig(),
      ctx.wagering,
      ctx.metrics,
    );
    await withConsumer(consumer, async () => {
      await waitFor(async () => (await depth(queueUrl)) === 0, {
        label: 'negócio terminal ackado',
      });
    });
    expect(await depth(dlqUrl)).toBe(0);
  });

  it('erro transitório persistente: respeita maxReceiveCount e vai para a DLQ', async () => {
    const wallet = await ctx.wallets.open({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const alwaysDown = {
      submit: async (): Promise<SubmitWagerResult> => {
        const err = new Error('banco fora do ar') as Error & { code: string };
        err.code = 'ECONNREFUSED';
        throw err;
      },
    } as unknown as WageringService;

    await send(envelope('msg-dlq', wallet.id, 'ext-dlq'), wallet.id, 'msg-dlq');

    const consumer = new WagerConsumer(
      sqs,
      consumerConfig(),
      alwaysDown,
      ctx.metrics,
    );
    await withConsumer(consumer, async () => {
      await waitFor(async () => (await depth(dlqUrl)) === 1, {
        label: 'mensagem movida para a DLQ',
        timeoutMs: 30_000,
      });
    });
    expect(await depth(queueUrl)).toBe(0);

    expect((await ctx.wallets.findById(wallet.id)).balance.amount).toBe(
      '100.00',
    );
  });
});
