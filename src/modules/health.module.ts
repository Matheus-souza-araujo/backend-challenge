import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from '@interface/http/health/health.controller';
import { DatabaseHealthIndicator } from '@interface/http/health/indicators/database.health';
import { SqsHealthIndicator } from '@interface/http/health/indicators/sqs.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, SqsHealthIndicator],
})
export class HealthModule {}
