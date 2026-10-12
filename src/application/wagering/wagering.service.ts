import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '@domain/failure-code';
import { hashWagerPayload } from '@domain/idempotency/payload-hash';
import { InboxMessage } from '@domain/inbox-message';
import { Money } from '@domain/money';
import { WagerTransaction } from '@domain/wager-transaction';
import type { Wallet } from '@domain/wallet';
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '@app/errors/errors';
import {
  RACE_CONSTRAINTS,
  UniqueViolationError,
} from '@app/errors/persistence-errors';
import { METRICS, type Metrics } from '@config/metrics';
import {
  UNIT_OF_WORK,
  type TransactionalRepositories,
  type UnitOfWork,
} from '@app/repositories/unit-of-work';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@app/system';
import { toSubmitResult, toTransactionView } from './wager-result';
import { WagerSettlement } from './wager-settlement';
import type {
  SubmitWagerCommand,
  SubmitWagerResult,
  WagerTransactionView,
} from './wagering.types';

@Injectable()
export class WageringService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly settlement: WagerSettlement,
  ) {}

  async submit(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const channel = command.inbox ? 'sqs' : 'http';
    const startedAt = performance.now();
    try {
      const result = await this.submitWithRaceRetry(command);
      this.metrics.transactionOutcome(result.status, command.kind, channel);
      if (result.idempotentReplay) this.metrics.idempotentReplay(channel);
      return result;
    } finally {
      this.metrics.processingDuration((performance.now() - startedAt) / 1000);
    }
  }

  async findById(transactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async (repos) => {
      const transaction = await repos.transactions.findById(transactionId);
      if (!transaction) throw new TransactionNotFoundError(transactionId);
      return toTransactionView(transaction);
    });
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.uow.run(async (repos) => {
      const transaction = await repos.transactions.findByProviderExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError(
          `${providerId}:${externalTransactionId}`,
        );
      }
      return toTransactionView(transaction);
    });
  }

  private async submitWithRaceRetry(
    command: SubmitWagerCommand,
  ): Promise<SubmitWagerResult> {
    try {
      return await this.submitOnce(command);
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        RACE_CONSTRAINTS.includes(error.constraintName)
      ) {
        this.metrics.raceRetry(error.constraintName);
        return await this.submitOnce(command);
      }
      throw error;
    }
  }

  private async submitOnce(
    command: SubmitWagerCommand,
  ): Promise<SubmitWagerResult> {
    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const payloadHash = hashPayloadOf(command);

      const replay = await this.findReplay(repos, command, payloadHash);
      if (replay) {
        await this.recordInbox(repos, command, payloadHash, now);
        return toSubmitResult(replay, { replay: true });
      }

      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: Money.from(command.money),
        ...(command.referenceExternalTransactionId !== undefined
          ? {
              referenceExternalTransactionId:
                command.referenceExternalTransactionId,
            }
          : {}),
        createdAt: now,
      });

      const wallet = transaction.affectsBalance()
        ? await repos.wallets.findByIdForUpdate(command.walletId)
        : await repos.wallets.findById(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId);

      await repos.transactions.insert(transaction);
      const result = await this.settle(
        repos,
        transaction,
        wallet,
        command.correlationId,
        now,
      );
      await this.recordInbox(repos, command, payloadHash, now);
      return result;
    });
  }

  private async settle(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    if (wallet.playerId !== transaction.playerId) {
      return this.settlement.reject(
        repos,
        transaction,
        FailureCode.WalletOwnershipMismatch,
        correlationId,
        now,
        wallet,
      );
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.settlement.reject(
        repos,
        transaction,
        FailureCode.CurrencyMismatch,
        correlationId,
        now,
      );
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await repos.transactions.findByProviderExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (!reference || !reference.isTerminal()) {
        return this.settlement.deferForReference(
          repos,
          transaction,
          correlationId,
          now,
        );
      }

      const rejection = await this.settlement.validateReference(
        repos,
        transaction,
        reference,
      );
      if (rejection !== undefined) {
        return this.settlement.reject(
          repos,
          transaction,
          rejection,
          correlationId,
          now,
          wallet,
        );
      }
    }

    return this.settlement.apply(
      repos,
      transaction,
      wallet,
      reference,
      correlationId,
      now,
    );
  }

  private async findReplay(
    repos: TransactionalRepositories,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<WagerTransaction | undefined> {
    if (command.inbox) {
      const seen = await repos.inbox.find(
        command.inbox.consumerName,
        command.inbox.messageId,
      );
      if (seen) {
        const existing = await repos.transactions.findByIdempotencyKey(
          command.idempotencyKey,
        );

        if (existing) return existing;
      }
    }

    const existing = await repos.transactions.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (!existing) return undefined;
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return existing;
  }

  private async recordInbox(
    repos: TransactionalRepositories,
    command: SubmitWagerCommand,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    if (!command.inbox) return;
    const seen = await repos.inbox.find(
      command.inbox.consumerName,
      command.inbox.messageId,
    );
    if (seen) return;
    const message = InboxMessage.receive({
      messageId: command.inbox.messageId,
      consumerName: command.inbox.consumerName,
      payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    await repos.inbox.insert(message);
  }
}

function hashPayloadOf(command: SubmitWagerCommand): string {
  return hashWagerPayload({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}
