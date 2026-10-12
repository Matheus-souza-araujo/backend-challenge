import { Controller, Get, Header } from '@nestjs/common';
import { PrometheusMetrics } from '@infra/observability/prometheus-metrics';
import { Public } from '@interface/http/common/auth.guard';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
