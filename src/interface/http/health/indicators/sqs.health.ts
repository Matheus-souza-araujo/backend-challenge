import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { APP_CONFIG, type AppConfig } from '@config/app-config';
import { SQS_CLIENT } from '@infra/sqs/sqs-client';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'sqs'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.config.sqs.wagerQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
