import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@config/app-config';
import { createSqsClient, SQS_CLIENT } from '@infra/sqs/sqs-client';

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: (config: AppConfig) => createSqsClient(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
