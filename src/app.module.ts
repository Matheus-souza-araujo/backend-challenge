import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppExceptionFilter } from './interface/http/common/app-exception.filter';
import { KeycloakAuthGuard } from './interface/http/common/auth.guard';
import { CoreModule } from './modules/core.module';
import { HealthModule } from './modules/health.module';
import { MessagingModule } from './modules/messaging.module';
import { ObservabilityModule } from './modules/observability.module';
import { PersistenceModule } from './modules/persistence.module';
import { SqsModule } from './modules/sqs.module';
import { WageringModule } from './modules/wagering.module';
import { WalletsModule } from './modules/wallets.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req: IncomingMessage) =>
          (req.headers['x-correlation-id'] as string | undefined) ??
          randomUUID(),
        customProps: (req: IncomingMessage & { id?: unknown }) => ({
          correlationId: typeof req.id === 'string' ? req.id : '',
        }),

        formatters: {
          level: (label: string) => ({ level: label }),
        },

        redact: ['req.headers.authorization', 'req.body'],
        autoLogging: {
          ignore: (req: IncomingMessage) =>
            (req.url ?? '').startsWith('/health') ||
            (req.url ?? '') === '/metrics',
        },
      },
    }),
    CoreModule,
    PersistenceModule,
    ObservabilityModule,
    SqsModule,
    WalletsModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidUnknownValues: true,
      }),
    },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: KeycloakAuthGuard },
  ],
})
export class AppModule {}
