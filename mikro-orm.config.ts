import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ALL_SCHEMAS } from '@infra/persistence/records';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
  entities: ALL_SCHEMAS,
  extensions: [Migrator],
  migrations: {
    path: './src/infrastructure/persistence/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    disableForeignKeys: false,
  },
  forceUtcTimezone: true,
});
