import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '@interface/http/common/auth.guard';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { SqsHealthIndicator } from './indicators/sqs.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  @Public()
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.isHealthy(),
      () => this.sqs.isHealthy(),
    ]);
  }
}
