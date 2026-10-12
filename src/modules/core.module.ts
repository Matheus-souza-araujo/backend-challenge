import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService, registerAs } from '@nestjs/config';
import { APP_CONFIG, loadAppConfig, type AppConfig } from '@config/app-config';
import { CLOCK, ID_GENERATOR } from '@app/system';
import { SystemClock, UuidV7Generator } from '@infra/system';

const appConfig = registerAs('app', (): AppConfig => loadAppConfig());

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, load: [appConfig] }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (config: ConfigService) =>
        config.getOrThrow<AppConfig>('app'),
      inject: [ConfigService],
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [APP_CONFIG, CLOCK, ID_GENERATOR],
})
export class CoreModule {}
