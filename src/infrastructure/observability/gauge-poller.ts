import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { METRICS } from '@config/metrics';
import { APP_CONFIG, type AppConfig } from '@config/app-config';
import { SQS_CLIENT } from '@infra/sqs/sqs-client';
import type { PrometheusMetrics } from './prometheus-metrics';

const POLL_INTERVAL_MS = 15_000;

@Injectable()
export class GaugePoller
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(GaugePoller.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(METRICS) private readonly metrics: PrometheusMetrics,
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.metrics
        .observeGauges(this.em.fork(), this.sqs, this.config.sqs.wagerDlqUrl)
        .catch((error: unknown) =>
          this.logger.warn(`Falha ao observar gauges: ${String(error)}`),
        );
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
