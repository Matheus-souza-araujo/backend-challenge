import { Global, Module } from '@nestjs/common';
import { METRICS } from '@config/metrics';
import { GaugePoller } from '@infra/observability/gauge-poller';
import { PrometheusMetrics } from '@infra/observability/prometheus-metrics';
import { MetricsController } from '@interface/http/metrics/metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    PrometheusMetrics,
    { provide: METRICS, useExisting: PrometheusMetrics },
    GaugePoller,
  ],
  exports: [METRICS, PrometheusMetrics],
})
export class ObservabilityModule {}
