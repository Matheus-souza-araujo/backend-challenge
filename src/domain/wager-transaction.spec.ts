import { describe, expect, it } from 'bun:test';
import {
  InvalidDomainInputError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors';
import { FailureCode } from './failure-code';
import { hashWagerPayload } from './idempotency/payload-hash';
import { Money } from './money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from './wager-transaction';
import { LedgerDirection } from './wallet-ledger-entry';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    ...overrides,
  };
}

function bet(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(props(overrides));
}

describe('create', () => {
  it('nasce em PENDING', () => {
    expect(bet().status).toBe(WagerTransactionStatus.Pending);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s sem referência é rejeitado na criação',
    (kind) => {
      expect(() => bet({ kind })).toThrow(InvalidReferenceError);
    },
  );

  it.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Opening,
  ])('%s não pode carregar referência', (kind) => {
    expect(() =>
      bet({ kind, referenceExternalTransactionId: 'ext-0' }),
    ).toThrow(InvalidReferenceError);
  });

  it('WIN pode carregar referência opcional', () => {
    expect(
      bet({ kind: WagerTransactionKind.Win }).referenceExternalTransactionId,
    ).toBeUndefined();
    expect(
      bet({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'ext-0',
      }).referenceExternalTransactionId,
    ).toBe('ext-0');
  });

  it('valor deve ser positivo (exceto OPENING, que aceita zero)', () => {
    expect(() => bet({ money: brl('0.00') })).toThrow(InvalidDomainInputError);
    expect(
      bet({
        kind: WagerTransactionKind.Opening,
        money: brl('0.00'),
      }).affectsBalance(),
    ).toBe(false);
  });
});

describe('transições', () => {
  it('PENDING → PROCESSED registra referência interna, timestamp e saldo observado', () => {
    const tx = bet();
    tx.markProcessed('ref-tx-id', NOW, brl('75.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-tx-id');
    expect(tx.processedAt).toEqual(NOW);
    expect(tx.observedBalance?.toJSON().amount).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-0',
    });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref-tx-id', NOW);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('REJECTED carrega failureCode e é terminal', () => {
    const tx = bet();
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'));
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  it('estados terminais não transicionam mais', () => {
    const processed = bet();
    processed.markProcessed(undefined, NOW);
    expect(() => processed.reject(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => processed.markProcessed(undefined, NOW)).toThrow(
      InvalidTransactionStateError,
    );

    const rejected = bet();
    rejected.reject(FailureCode.AmountMismatch);
    expect(() => rejected.markProcessed(undefined, NOW)).toThrow(
      InvalidTransactionStateError,
    );

    const failed = bet();
    failed.fail(FailureCode.InternalError);
    expect(() => failed.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('PENDING_REFERENCE não regride para PENDING_REFERENCE', () => {
    const tx = bet({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('consultas de domínio', () => {
  it('affectsBalance é false para LOSS', () => {
    expect(bet({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(
      false,
    );
    expect(bet().affectsBalance()).toBe(true);
  });

  it('requiresReference apenas para REFUND e ROLLBACK', () => {
    expect(bet().requiresReference()).toBe(false);
    expect(
      bet({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'x',
      }).requiresReference(),
    ).toBe(true);
    expect(
      bet({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'x',
      }).requiresReference(),
    ).toBe(true);
  });

  it('canReference: REFUND só BET; ROLLBACK: BET, WIN, REFUND; WIN só BET', () => {
    const refund = bet({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'x',
    });
    expect(refund.canReference(WagerTransactionKind.Bet)).toBe(true);
    expect(refund.canReference(WagerTransactionKind.Win)).toBe(false);

    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'x',
    });
    expect(rollback.canReference(WagerTransactionKind.Bet)).toBe(true);
    expect(rollback.canReference(WagerTransactionKind.Win)).toBe(true);
    expect(rollback.canReference(WagerTransactionKind.Refund)).toBe(true);
    expect(rollback.canReference(WagerTransactionKind.Loss)).toBe(false);
    expect(rollback.canReference(WagerTransactionKind.Rollback)).toBe(false);

    const win = bet({ kind: WagerTransactionKind.Win });
    expect(win.canReference(WagerTransactionKind.Bet)).toBe(true);
    expect(win.canReference(WagerTransactionKind.Win)).toBe(false);
  });

  it('ledgerDirectionFor cobre todos os kinds', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(bet({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      bet({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(
      bet({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'x',
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);

    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'x',
    });
    expect(rollback.ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(
      rollback.ledgerDirectionFor(bet({ kind: WagerTransactionKind.Win })),
    ).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidReferenceError);
    expect(() =>
      bet({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor(),
    ).toThrow(InvalidDomainInputError);
  });
});

describe('idempotência', () => {
  const fields = {
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    playerId: 'p-1',
    walletId: 'w-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('mesma key com payload idêntico é replay (hash bate)', () => {
    const tx = bet({ payloadHash: hashWagerPayload(fields) });
    expect(tx.matchesPayload(hashWagerPayload({ ...fields }))).toBe(true);
  });

  it('mesma key com payload divergente é conflito (hash difere)', () => {
    const tx = bet({ payloadHash: hashWagerPayload(fields) });
    const tampered = hashWagerPayload({
      ...fields,
      money: { amount: '26.00', currency: 'BRL' },
    });
    expect(tx.matchesPayload(tampered)).toBe(false);
  });
});
