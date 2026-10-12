import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
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
import type { AppConfig } from '@config/app-config';
import { WagerTransactionKind } from '@domain/wager-transaction';
import { OutboxPublisher } from '@interface/messaging/outbox.publisher';
import {
  createTestContext,
  FakeClock,
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

function testConfig(eventsQueueUrl: string): AppConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    databaseUrl: '',
    sqs: {
      endpoint: LOCALSTACK_ENDPOINT,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      wagerQueueUrl: '',
      wagerDlqUrl: '',
      eventsQueueUrl,
    },
    auth: { enabled: false, issuer: '', audience: '', jwksUri: '' },
    workers: {
      sqsConsumer: false,
      outboxPublisher: true,
      pendingReferenceResolver: false,
    },
    runMigrationsOnBoot: false,
  };
}

async function queueDepth(url: string): Promise<number> {
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

async function outboxCounts(): Promise<{ total: number; published: number }> {
  const rows = await ctx.em
    .getConnection()
    .execute<{ total: number; published: number }[]>(
      `SELECT COUNT(*)::int AS total, COUNT(published_at)::int AS published FROM outbox_messages`,
    );
  return rows[0] ?? { total: 0, published: 0 };
}

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = new SQSClient({
    endpoint: LOCALSTACK_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const name = `outbox-test-${Date.now()}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  queueUrl = created.QueueUrl!;
});
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

async function seedOutboxViaBet(): Promise<void> {
  const wallet = await ctx.wallets.open({
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId: 'corr-0',
  });
  await ctx.wagering.submit({
    idempotencyKey: 'provider-a:pub-1',
    providerId: 'provider-a',
    externalTransactionId: 'pub-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    correlationId: 'corr-1',
  });
}

describe('transactional outbox (§11)', () => {
  it('dois publishers concorrentes: cada evento publicado exatamente uma vez', async () => {
    await seedOutboxViaBet();
    const before = await queueDepth(queueUrl);

    const publisherA = new OutboxPublisher(
      sqs,
      testConfig(queueUrl),
      ctx.uow,
      ctx.clock,
      ctx.metrics,
    );
    const publisherB = new OutboxPublisher(
      sqs,
      testConfig(queueUrl),
      ctx.uow,
      ctx.clock,
      ctx.metrics,
    );

    await Promise.all([
      (async () => {
        for (let i = 0; i < 5; i++) await publisherA.publishDueBatch();
      })(),
      (async () => {
        for (let i = 0; i < 5; i++) await publisherB.publishDueBatch();
      })(),
    ]);

    const counts = await outboxCounts();
    expect(counts.total).toBe(4);
    expect(counts.published).toBe(4);

    await waitFor(async () => (await queueDepth(queueUrl)) - before === 4, {
      label: 'todas as mensagens na fila, sem duplicatas',
    });
  });

  it('crash depois do commit e antes de publicar: outra instância assume (§11)', async () => {
    await seedOutboxViaBet();

    const pendingBefore = await outboxCounts();
    expect(pendingBefore.published).toBe(0);

    const publisher = new OutboxPublisher(
      sqs,
      testConfig(queueUrl),
      ctx.uow,
      ctx.clock,
      ctx.metrics,
    );
    await publisher.publishDueBatch();

    const counts = await outboxCounts();
    expect(counts.published).toBe(counts.total);
  });

  it('falha de publicação agenda retry com backoff; sucesso posterior publica', async () => {
    await seedOutboxViaBet();
    const clock = new FakeClock();

    const brokenSqs = new SQSClient({
      endpoint: 'http://localhost:1', // porta fechada
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const failing = new OutboxPublisher(
      brokenSqs,
      testConfig(queueUrl),
      ctx.uow,
      clock,
      ctx.metrics,
    );
    await failing.publishDueBatch();

    const afterFailure = await ctx.em
      .getConnection()
      .execute(
        `SELECT attempts, next_attempt_at, published_at FROM outbox_messages`,
      );
    for (const row of afterFailure) {
      expect(row.attempts).toBe(1);
      expect(row.published_at).toBeNull();
      expect(row.next_attempt_at).not.toBeNull();
    }

    const healthy = new OutboxPublisher(
      sqs,
      testConfig(queueUrl),
      ctx.uow,
      clock,
      ctx.metrics,
    );
    expect(await healthy.publishDueBatch()).toBe(0);

    clock.advance(10_000);
    await healthy.publishDueBatch();
    const counts = await outboxCounts();
    expect(counts.published).toBe(counts.total);
  });
});
