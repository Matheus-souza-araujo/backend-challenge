import { Module } from '@nestjs/common';
import { PendingReferencesService } from '@app/wagering/pending-references.service';
import { WagerSettlement } from '@app/wagering/wager-settlement';
import { WageringService } from '@app/wagering/wagering.service';
import { WageringController } from '@interface/http/wagering/wagering.controller';
import { IntegrationEventsModule } from './integration-events.module';
import { PersistenceModule } from './persistence.module';

@Module({
  imports: [PersistenceModule, IntegrationEventsModule],
  controllers: [WageringController],
  providers: [WageringService, WagerSettlement, PendingReferencesService],
  exports: [WageringService, PendingReferencesService],
})
export class WageringModule {}
