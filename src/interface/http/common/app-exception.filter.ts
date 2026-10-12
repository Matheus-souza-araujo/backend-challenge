import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConnectionException } from '@mikro-orm/core';
import type { Response } from 'express';
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@app/errors/errors';
import { DomainError } from '@domain/errors';
import { FailureCode } from '@domain/failure-code';
import { InvalidCursorError } from '@infra/persistence/repositories/ledger.repository';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (
      exception instanceof DomainError ||
      exception instanceof InvalidCursorError
    ) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: 400,
        error: exception.name,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        error: exception.name,
        failureCode: FailureCode.IdempotencyConflict,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletAlreadyExistsError) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        error: exception.name,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof WalletNotFoundError ||
      exception instanceof TransactionNotFoundError
    ) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: 404,
        error: exception.name,
        message: exception.message,
      });
      return;
    }

    if (isTransientInfraError(exception)) {
      this.logger.error(
        { err: serializeError(exception) },
        'Falha transitória de infraestrutura',
      );
      response
        .setHeader('Retry-After', '5')
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({
          statusCode: 503,
          error: 'ServiceUnavailable',
          message: 'Tente novamente em instantes',
        });
      return;
    }

    this.logger.error({ err: serializeError(exception) }, 'Erro não tratado');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'InternalServerError',
      message: 'Erro interno',
    });
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  '57P01',
  '57P03',
  '53300',
  '40001',
  '40P01',
]);

export function isTransientInfraError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

function serializeError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
