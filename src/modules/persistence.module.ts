import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../mikro-orm.config';
import { UNIT_OF_WORK } from '@app/repositories/unit-of-work';
import { MikroOrmUnitOfWork } from '@infra/persistence/unit-of-work';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      registerRequestContext: false,
    }),
  ],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em),
      inject: [EntityManager],
    },
  ],

  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
