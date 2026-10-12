import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly em: EntityManager,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'postgres'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    try {
      await this.em.fork().getConnection().execute('SELECT 1');
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
