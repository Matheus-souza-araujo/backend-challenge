import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainInputError,
} from './errors';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-07-31T12:00:00.000Z');

function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: brl(balance),
    at: NOW,
  });
}

describe('Wallet.open', () => {
  it('nasce com version 1 refletindo o saldo inicial', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
  });
});

describe('debit', () => {
  it('debita e devolve o lançamento balanceado correspondente', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({
      entryId: 'e-1',
      transactionId: 't-1',
      money: brl('25.00'),
      at: NOW,
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('permite zerar o saldo, mas nunca negativá-lo', () => {
    const wallet = openWallet('100.00');
    wallet.debit({
      entryId: 'e-1',
      transactionId: 't-1',
      money: brl('100.00'),
      at: NOW,
    });
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('saldo insuficiente lança e não muta o estado', () => {
    const wallet = openWallet('100.00');
    expect(() =>
      wallet.debit({
        entryId: 'e-1',
        transactionId: 't-1',
        money: brl('100.01'),
        at: NOW,
      }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejeita movimentação de valor zero', () => {
    const wallet = openWallet();
    expect(() =>
      wallet.debit({
        entryId: 'e-1',
        transactionId: 't-1',
        money: brl('0.00'),
        at: NOW,
      }),
    ).toThrow(InvalidDomainInputError);
  });

  it('rejeita moeda diferente da wallet', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() =>
      wallet.debit({
        entryId: 'e-1',
        transactionId: 't-1',
        money: usd,
        at: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('credit', () => {
  it('credita e incrementa version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit({
      entryId: 'e-1',
      transactionId: 't-1',
      money: brl('50.00'),
      at: NOW,
    });
    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });
});

describe('rehydrate', () => {
  it('reconstrói o estado persistido sem revalidar transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      balance: { amount: '20.00', currency: 'BRL' },
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });
});
