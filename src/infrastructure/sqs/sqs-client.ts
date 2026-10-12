import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@config/app-config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
}
