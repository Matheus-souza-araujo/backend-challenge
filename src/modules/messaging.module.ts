import { Module } from '@nestjs/common';
import { OutboxPublisher } from '@interface/messaging/outbox.publisher';
import { PendingReferenceWorker } from '@interface/messaging/pending-reference.worker';
import { WagerConsumer } from '@interface/messaging/wager.consumer';
import { PersistenceModule } from './persistence.module';
import { WageringModule } from './wagering.module';

@Module({
  imports: [WageringModule, PersistenceModule],
  providers: [WagerConsumer, OutboxPublisher, PendingReferenceWorker],
})
export class MessagingModule {}
