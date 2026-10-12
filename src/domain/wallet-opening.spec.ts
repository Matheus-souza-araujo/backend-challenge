import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';
import { createWalletOpening } from './wallet-opening';

const NOW = new Date('2026-07-31T12:00:00.000Z');

function opening(amount = '100.00') {
  const wallet = Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    at: NOW,
  });
  return {
    wallet,
    ...createWalletOpening({
      wallet,
      transactionId: 't-1',
      entryId: 'e-1',
      at: NOW,
    }),
  };
}

describe('createWalletOpening', () => {
  it('monta a transação OPENING já PROCESSED com o saldo observado', () => {
    const { transaction } = opening();
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.walletId).toBe('w-1');
    expect(transaction.money.toJSON().amount).toBe('100.00');
    expect(transaction.observedBalance?.toJSON().amount).toBe('100.00');
    expect(transaction.processedAt).toEqual(NOW);
  });

  it('idempotency key e identidade externa são determinísticas por wallet', () => {
    const { transaction } = opening();
    expect(transaction.idempotencyKey).toBe('internal:opening:w-1');
    expect(transaction.providerId).toBe('internal');
    expect(transaction.externalTransactionId).toBe('opening:w-1');
  });

  it('lançamento registra a passagem 0.00 → saldo inicial, balanceado', () => {
    const { entry } = opening('250.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.transactionId).toBe('t-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('250.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('entry.balanceAfter é exatamente o saldo da wallet aberta', () => {
    const { wallet, entry } = opening('37.50');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });
});
