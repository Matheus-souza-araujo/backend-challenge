import { Inject, Injectable } from '@nestjs/common';
import type {
  EventContext,
  IntegrationEvent,
} from '@domain/events/integration-event';
import { OutboxMessage } from '@domain/outbox-message';
import type { OutboxRepository } from '@app/repositories/outbox.repository';
import { ID_GENERATOR, type IdGenerator } from '@app/system';

@Injectable()
export class IntegrationEventsService {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  context(
    correlationId: string,
    occurredAt: Date,
    causationId?: string,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId,
      occurredAt,
      ...(causationId !== undefined ? { causationId } : {}),
    };
  }

  async record(
    outbox: OutboxRepository,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await outbox.insert(OutboxMessage.enqueue(event));
  }
}
