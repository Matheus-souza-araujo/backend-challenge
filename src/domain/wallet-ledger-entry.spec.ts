import { describe, expect, it } from 'bun:test';
import { InvalidDomainInputError, LedgerArithmeticError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-07-31T12:00:00.000Z');

function entryProps(
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) {
  return {
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('valida a aritmética do lançamento na factory', () => {
    const entry = WalletLedgerEntry.create(entryProps());
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética errada (débito)', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ balanceAfter: brl('80.00') })),
    ).toThrow(LedgerArithmeticError);
  });

  it('rejeita aritmética errada (crédito)', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          direction: LedgerDirection.Credit,
          balanceAfter: brl('120.00'),
        }),
      ),
    ).toThrow(LedgerArithmeticError);
  });

  it('rejeita lançamento que resultaria em saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          money: brl('150.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00').subtract(brl('150.00')),
        }),
      ),
    ).toThrow(LedgerArithmeticError);
  });

  it('rejeita valor não-positivo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow(InvalidDomainInputError);
  });

  it('é estruturalmente imutável — sem setters nem métodos de transição', () => {
    const entry = WalletLedgerEntry.create(entryProps());
    const mutators = Object.getOwnPropertyNames(
      WalletLedgerEntry.prototype,
    ).filter((name) => name.startsWith('set') || name.startsWith('mark'));
    expect(mutators).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(entry, 'money')?.writable).toBe(
      true,
    );
  });
});
