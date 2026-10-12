import { Module } from '@nestjs/common';
import { WalletsService } from '@app/wallets/wallets.service';
import { WalletsController } from '@interface/http/wallets/wallets.controller';
import { IntegrationEventsModule } from './integration-events.module';
import { PersistenceModule } from './persistence.module';

@Module({
  imports: [PersistenceModule, IntegrationEventsModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
