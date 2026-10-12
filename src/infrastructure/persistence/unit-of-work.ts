import {
  ForeignKeyConstraintViolationException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '@app/repositories/unit-of-work';
import {
  ForeignKeyViolationError,
  UniqueViolationError,
} from '@app/errors/persistence-errors';
import { createRepositories } from '@infra/persistence/repositories/create-repositories';

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(
    fn: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em
        .fork()
        .transactional(async (tem) => fn(createRepositories(tem)));
    } catch (error) {
      throw translateConstraintViolation(error);
    }
  }
}

function extractConstraintName(error: {
  constraint?: string;
  message: string;
}): string {
  return (
    error.constraint ??
    /constraint "([^"]+)"/.exec(error.message)?.[1] ??
    'unknown'
  );
}

function translateConstraintViolation(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const pgError = error as unknown as {
      constraint?: string;
      message: string;
    };
    return new UniqueViolationError(
      extractConstraintName(pgError),
      pgError.message,
    );
  }
  if (error instanceof ForeignKeyConstraintViolationException) {
    const pgError = error as unknown as {
      constraint?: string;
      message: string;
    };
    return new ForeignKeyViolationError(
      extractConstraintName(pgError),
      pgError.message,
    );
  }
  return error;
}
