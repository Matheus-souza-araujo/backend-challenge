import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '@domain/wager-transaction';
import {
  canonicalJson,
  hashWagerPayload,
  type WagerPayloadFields,
} from './payload-hash';

const fields: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'p-1',
  walletId: 'w-1',
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('ordena chaves recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('omite undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('hashWagerPayload', () => {
  it('é estável independentemente da ordem das chaves', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: 'w-1',
      playerId: 'p-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-a',
    } as WagerPayloadFields;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(fields));
  });

  it('muda quando qualquer campo de negócio muda', () => {
    const base = hashWagerPayload(fields);
    expect(
      hashWagerPayload({
        ...fields,
        money: { amount: '25.01', currency: 'BRL' },
      }),
    ).not.toBe(base);
    expect(hashWagerPayload({ ...fields, roundId: 'round-2' })).not.toBe(base);
  });

  it('referência ausente e undefined produzem o mesmo hash', () => {
    expect(
      hashWagerPayload({
        ...fields,
        referenceExternalTransactionId: undefined,
      }),
    ).toBe(hashWagerPayload(fields));
  });
});
