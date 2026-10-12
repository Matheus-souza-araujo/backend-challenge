import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from './errors';
import { WagerTransactionProcessed } from './events/wager-events';
import { InboxMessage } from './inbox-message';
import { Money } from './money';
import { OutboxMessage } from './outbox-message';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';

const NOW = new Date('2026-07-31T12:00:00.000Z');

function sampleEvent(): WagerTransactionProcessed {
  const tx = WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: NOW,
  });
  tx.markProcessed(undefined, NOW);
  return WagerTransactionProcessed.from(tx, {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    occurredAt: NOW,
  });
}

describe('OutboxMessage', () => {
  it('enqueue usa o eventId como id e serializa o envelope', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    expect(outbox.id).toBe('evt-1');
    expect(outbox.aggregateId).toBe('t-1');
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.payload.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(NOW)).toBe(true);
  });

  it('scheduleRetry aplica backoff exponencial com teto', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      outbox.scheduleRetry(NOW);
      delays.push((outbox.nextAttemptAt!.getTime() - NOW.getTime()) / 1000);
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
    expect(outbox.attempts).toBe(8);
    expect(outbox.isDue(NOW)).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 301_000))).toBe(true);
  });

  it('markPublished é terminal', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    outbox.markPublished(NOW);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(NOW)).toBe(false);
    expect(() => outbox.markPublished(NOW)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => outbox.scheduleRetry(NOW)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('InboxMessage', () => {
  it('receive → markProcessed uma única vez', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash',
      receivedAt: NOW,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(NOW)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
