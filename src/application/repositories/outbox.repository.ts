import type { OutboxMessage } from '@domain/outbox-message';

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  save(message: OutboxMessage): Promise<void>;

  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
}
