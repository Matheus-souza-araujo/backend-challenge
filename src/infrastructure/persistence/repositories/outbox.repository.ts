import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '@app/repositories/outbox.repository';
import { OutboxMessage } from '@domain/outbox-message';
import { OutboxMessageRecord } from '@infra/persistence/records';

function toOutbox(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const records = await this.em
      .qb(OutboxMessageRecord)
      .select('*')
      .where({
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      })
      .orderBy({ occurredAt: 'ASC' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();
    return records.map(toOutbox);
  }
}
