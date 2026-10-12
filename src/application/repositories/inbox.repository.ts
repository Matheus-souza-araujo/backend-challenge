import type { InboxMessage } from '@domain/inbox-message';

export interface InboxRepository {
  insert(message: InboxMessage): Promise<void>;
  save(message: InboxMessage): Promise<void>;
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
}
