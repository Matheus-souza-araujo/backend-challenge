import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
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
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

async function openWallet(amount = '100.00'): Promise<string> {
  const wallet = await ctx.wallets.open({
    playerId: PLAYER,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-0',
  });
  return wallet.id;
}

function command(walletId: string, messageId: string, externalId = 'ext-1') {
  return {
    idempotencyKey: `provider-a:${externalId}`,
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId: PLAYER,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '30.00', currency: 'BRL' },
    correlationId: messageId,
    inbox: { consumerName: 'wager-transactions-consumer', messageId },
  };
}

describe('inbox persistente e redelivery (§10)', () => {
  it('redelivery da MESMA mensagem devolve o resultado original sem duplicar efeito', async () => {
    const walletId = await openWallet();

    const first = await ctx.wagering.submit(command(walletId, 'msg-1'));
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.balance?.amount).toBe('70.00');

    const redelivered = await ctx.wagering.submit(command(walletId, 'msg-1'));
    expect(redelivered.idempotentReplay).toBe(true);
    expect(redelivered.transactionId).toBe(first.transactionId);
    expect(redelivered.balance?.amount).toBe('70.00');

    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe('70.00');
    await expectWalletLedgerInvariant(ctx, walletId);
  });

  it('mensagens DIFERENTES com a mesma idempotency key: replay, um único débito', async () => {
    const walletId = await openWallet();

    await ctx.wagering.submit(command(walletId, 'msg-1'));
    const second = await ctx.wagering.submit(command(walletId, 'msg-2'));
    expect(second.idempotentReplay).toBe(true);

    const inboxRows = await ctx.em
      .getConnection()
      .execute(`SELECT message_id FROM inbox_messages ORDER BY message_id`);

    expect(inboxRows.map((r) => r.message_id)).toEqual(['msg-1', 'msg-2']);
    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe('70.00');
    await expectWalletLedgerInvariant(ctx, walletId);
  });

  it('entrega fora de ordem: ROLLBACK antes da BET fica PENDING_REFERENCE e resolve depois', async () => {
    const walletId = await openWallet();

    const rollback = await ctx.wagering.submit({
      ...command(walletId, 'msg-rb', 'ext-rb'),
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await ctx.wagering.submit({
      ...command(walletId, 'msg-bet', 'ext-bet'),
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.balance?.amount).toBe('70.00');

    const summary = await ctx.pendingReferences.resolveDue(10);
    expect(summary.processed).toBe(1);

    const resolved = await ctx.wagering.findById(rollback.transactionId);
    expect(resolved.status).toBe(WagerTransactionStatus.Processed);
    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe(
      '100.00',
    );
    await expectWalletLedgerInvariant(ctx, walletId);
  });

  it('referência que nunca chega: esgota as tentativas e rejeita com REFERENCE_NOT_FOUND', async () => {
    const walletId = await openWallet();

    const refund = await ctx.wagering.submit({
      ...command(walletId, 'msg-refund', 'ext-refund'),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-fantasma',
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    for (let i = 0; i < 8; i++) {
      await ctx.em
        .getConnection()
        .execute(
          `UPDATE wager_transactions SET reference_next_retry_at = now() - interval '1 hour' WHERE id = ?`,
          [refund.transactionId],
        );
      await ctx.pendingReferences.resolveDue(10);
    }

    const final = await ctx.wagering.findById(refund.transactionId);
    expect(final.status).toBe(WagerTransactionStatus.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceNotFound);

    const events = await ctx.em
      .getConnection()
      .execute(
        `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
        [refund.transactionId],
      );
    expect(events.map((e) => e.event_type)).toContain(
      'WagerTransactionRejected',
    );
    await expectWalletLedgerInvariant(ctx, walletId);
  });
});
