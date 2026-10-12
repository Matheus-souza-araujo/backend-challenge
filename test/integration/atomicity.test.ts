import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { WageringService } from '@app/wagering/wagering.service';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '@app/repositories/unit-of-work';
import { FailureCode } from '@domain/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@domain/wager-transaction';
import {
  createTestContext,
  expectWalletLedgerInvariant,
  resetDatabase,
  type TestContext,
} from '@test/helpers/context';
import { useRealInfraTimeouts } from '@test/helpers/setup';

useRealInfraTimeouts();

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

const count = async (table: string): Promise<number> => {
  const rows = await ctx.em
    .getConnection()
    .execute(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
};

function betCommand(walletId: string, playerId: string, externalId = 'ext-1') {
  return {
    idempotencyKey: `provider-a:${externalId}`,
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'corr-1',
    inbox: { consumerName: 'test-consumer', messageId: `msg-${externalId}` },
  };
}

describe('atomicidade wallet + ledger + inbox + outbox (§11)', () => {
  it('sucesso: tudo comita junto na mesma transação SQL', async () => {
    const wallet = await ctx.wallets.open({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'corr-0',
    });

    const result = await ctx.wagering.submit(
      betCommand(wallet.id, '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);

    expect(await count('wager_transactions')).toBe(2);
    expect(await count('wallet_ledger_entries')).toBe(2);
    expect(await count('inbox_messages')).toBe(1);

    expect(await count('outbox_messages')).toBe(4);
    await expectWalletLedgerInvariant(ctx, wallet.id);
  });

  it('crash antes do commit: NADA é persistido (nem parcialmente)', async () => {
    const wallet = await ctx.wallets.open({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'corr-0',
    });

    const crashingUow: UnitOfWork = {
      run: <T>(fn: (repos: TransactionalRepositories) => Promise<T>) =>
        ctx.uow.run(async (repos) => {
          await fn(repos);
          throw new Error('crash-antes-do-commit');
        }),
    };
    const crashingWagering = new WageringService(
      crashingUow,
      ctx.clock,
      ctx.ids,
      ctx.metrics,
      ctx.settlement,
    );

    await expect(
      crashingWagering.submit(
        betCommand(wallet.id, '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'),
      ),
    ).rejects.toThrow('crash-antes-do-commit');

    expect(await count('wager_transactions')).toBe(1);
    expect(await count('wallet_ledger_entries')).toBe(1);
    expect(await count('inbox_messages')).toBe(0);
    expect(await count('outbox_messages')).toBe(2);

    const view = await ctx.wallets.findById(wallet.id);
    expect(view.balance.amount).toBe('100.00');
    expect(view.version).toBe(1);
    await expectWalletLedgerInvariant(ctx, wallet.id);

    const result = await ctx.wagering.submit(
      betCommand(wallet.id, '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect((await ctx.wallets.findById(wallet.id)).balance.amount).toBe(
      '75.00',
    );
    await expectWalletLedgerInvariant(ctx, wallet.id);
  });

  it('rejeição de negócio também comita atômica (transação + evento, sem ledger)', async () => {
    const wallet = await ctx.wallets.open({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'corr-0',
    });

    const result = await ctx.wagering.submit(
      betCommand(wallet.id, '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await count('wallet_ledger_entries')).toBe(1);
    const outboxTypes = await ctx.em
      .getConnection()
      .execute(`SELECT event_type FROM outbox_messages ORDER BY occurred_at`);
    expect(outboxTypes.map((r) => r.event_type)).toContain(
      'WagerTransactionRejected',
    );
    await expectWalletLedgerInvariant(ctx, wallet.id);
  });
});
