import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadAppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  if (config.runMigrationsOnBoot) {
    await app.get(MikroORM).getMigrator().up();
  }

  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
