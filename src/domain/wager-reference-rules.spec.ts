import { describe, expect, it } from 'bun:test';
import { FailureCode } from './failure-code';
import { Money } from './money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from './wager-transaction';
import { checkReferenceRules } from './wager-reference-rules';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function tx(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'g-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    ...overrides,
  });
}

function processedBet(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const bet = tx({
    id: 't-ref',
    externalTransactionId: 'ext-ref',
    ...overrides,
  });
  bet.markProcessed(undefined, NOW, brl('75.00'));
  return bet;
}

const refund = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  tx({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'ext-ref',
    ...overrides,
  });

describe('checkReferenceRules', () => {
  it('aceita REFUND que espelha a BET referenciada', () => {
    expect(checkReferenceRules(refund(), processedBet())).toBeUndefined();
  });

  it('rejeita referência que não terminou PROCESSED', () => {
    const pending = tx({ id: 't-ref', externalTransactionId: 'ext-ref' });
    expect(checkReferenceRules(refund(), pending)).toBe(
      FailureCode.ReferenceNotProcessed,
    );
  });

  it('rejeita referência de kind não permitido (REFUND → WIN)', () => {
    const win = processedBet({ kind: WagerTransactionKind.Win });
    expect(checkReferenceRules(refund(), win)).toBe(
      FailureCode.InvalidReferenceKind,
    );
  });

  it.each([
    ['player', { playerId: 'outro-player' }],
    ['wallet', { walletId: 'outra-wallet' }],
    ['rodada', { roundId: 'outra-rodada' }],
  ])('rejeita referência de outro %s', (_label, overrides) => {
    expect(checkReferenceRules(refund(), processedBet(overrides))).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  it('rejeita referência em outra moeda', () => {
    const usd = processedBet({
      money: Money.from({ amount: '25.00', currency: 'USD' }),
    });
    expect(checkReferenceRules(refund(), usd)).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  it('rejeita reversão de valor diferente (reversão parcial fora de escopo)', () => {
    expect(
      checkReferenceRules(refund({ money: brl('10.00') }), processedBet()),
    ).toBe(FailureCode.AmountMismatch);
  });

  it('WIN pode pagar valor diferente da BET — não exige referência', () => {
    const win = tx({
      kind: WagerTransactionKind.Win,
      money: brl('99.00'),
      referenceExternalTransactionId: 'ext-ref',
    });
    expect(checkReferenceRules(win, processedBet())).toBeUndefined();
  });

  it('ROLLBACK aceita BET, WIN e REFUND como referência', () => {
    const rollback = tx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-ref',
    });
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]) {
      const reference = processedBet({
        kind,
        ...(kind === WagerTransactionKind.Bet
          ? {}
          : { referenceExternalTransactionId: 'ext-outra' }),
      });
      expect(checkReferenceRules(rollback, reference)).toBeUndefined();
    }
  });
});
