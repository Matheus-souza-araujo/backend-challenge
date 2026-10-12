import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('recuperação após reinicialização', () => {
  let ctx2: TestContext;

  beforeAll(async () => {
    const ctx1 = await createTestContext();
    await resetDatabase(ctx1);
    ctx2 = ctx1;
  });
  afterAll(async () => ctx2.close());

  it('trabalho interrompido é retomado por outra instância sem perder nem duplicar', async () => {
    const ctx1 = await createTestContext();
    await resetDatabase(ctx1);

    const wallet = await ctx1.wallets.open({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const bet = await ctx1.wagering.submit({
      idempotencyKey: 'provider-a:rec-bet',
      providerId: 'provider-a',
      externalTransactionId: 'rec-bet',
      playerId: PLAYER,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
      correlationId: 'c',
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const rollback = await ctx1.wagering.submit({
      idempotencyKey: 'provider-a:rec-rb',
      providerId: 'provider-a',
      externalTransactionId: 'rec-rb',
      playerId: PLAYER,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: 'rec-bet-2',
      correlationId: 'c',
    });
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    await ctx1.close();

    ctx2 = await createTestContext();

    const bet2 = await ctx2.wagering.submit({
      idempotencyKey: 'provider-a:rec-bet-2',
      providerId: 'provider-a',
      externalTransactionId: 'rec-bet-2',
      playerId: PLAYER,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '15.00', currency: 'BRL' },
      correlationId: 'c',
    });
    expect(bet2.status).toBe(WagerTransactionStatus.Processed);

    await ctx2.em.getConnection().execute(
      `UPDATE wager_transactions SET reference_next_retry_at = now() - interval '1 hour'
         WHERE status = 'PENDING_REFERENCE'`,
    );
    const summary = await ctx2.pendingReferences.resolveDue(10);
    expect(summary.processed).toBe(1);

    const replay = await ctx2.wagering.submit({
      idempotencyKey: 'provider-a:rec-bet',
      providerId: 'provider-a',
      externalTransactionId: 'rec-bet',
      playerId: PLAYER,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
      correlationId: 'c',
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(bet.transactionId);

    const view = await ctx2.wallets.findById(wallet.id);
    expect(view.balance.amount).toBe('60.00');
    await expectWalletLedgerInvariant(ctx2, wallet.id);

    const outbox = await ctx2.em
      .getConnection()
      .execute(`SELECT COUNT(*)::int AS n FROM outbox_messages`);
    expect(outbox[0]!.n).toBeGreaterThanOrEqual(8);
  });
});
