import { describe, expect, it } from 'bun:test';
import { FailureCode } from './failure-code';
import { Money } from './money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';
import { applyTransactionToWallet } from './wallet-movement';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const wallet = (balance: string) =>
  Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: brl(balance),
    at: NOW,
  });

function tx(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'k',
    payloadHash: 'h',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'g-1',
    kind: WagerTransactionKind.Bet,
    money: brl('30.00'),
    createdAt: NOW,
    ...overrides,
  });
}

const apply = (w: Wallet, t: WagerTransaction, reference?: WagerTransaction) =>
  applyTransactionToWallet({
    wallet: w,
    transaction: t,
    ...(reference ? { reference } : {}),
    entryId: 'e-1',
    at: NOW,
  });

describe('applyTransactionToWallet', () => {
  it('BET debita e devolve o lançamento correspondente', () => {
    const w = wallet('100.00');
    const outcome = apply(w, tx());
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) throw new Error('esperava aplicado');
    expect(outcome.entry.direction).toBe(LedgerDirection.Debit);
    expect(outcome.entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(w.balance.toJSON().amount).toBe('70.00');
  });

  it('WIN credita', () => {
    const w = wallet('100.00');
    const outcome = apply(w, tx({ kind: WagerTransactionKind.Win }));
    if (!outcome.applied) throw new Error('esperava aplicado');
    expect(outcome.entry.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('130.00');
  });

  it('BET sem saldo → INSUFFICIENT_FUNDS, sem mutar a wallet', () => {
    const w = wallet('10.00');
    const outcome = apply(w, tx());
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('esperava rejeição');
    expect(outcome.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('reversão que negativaria o saldo → código DISTINTO (regra 9, §7)', () => {
    const w = wallet('10.00');
    const win = tx({ id: 't-win', kind: WagerTransactionKind.Win });
    win.markProcessed(undefined, NOW);
    const rollback = tx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-win',
    });
    const outcome = apply(w, rollback, win);
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('esperava rejeição');
    expect(outcome.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(outcome.failureCode).not.toBe(FailureCode.InsufficientFunds);
  });

  it('ROLLBACK inverte a direção da referência', () => {
    const bet = tx({ id: 't-bet' });
    bet.markProcessed(undefined, NOW);
    const rollback = tx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });
    const outcome = apply(wallet('100.00'), rollback, bet);
    if (!outcome.applied) throw new Error('esperava aplicado');

    expect(outcome.entry.direction).toBe(LedgerDirection.Credit);
  });
});
