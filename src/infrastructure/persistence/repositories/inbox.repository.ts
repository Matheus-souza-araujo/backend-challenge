import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '@app/repositories/inbox.repository';
import { InboxMessage } from '@domain/inbox-message';
import { InboxMessageRecord } from '@infra/persistence/records';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }

  async save(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, {
      consumerName,
      messageId,
    });
    if (!record) return undefined;
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }
}
