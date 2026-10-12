import { Inject, Injectable } from '@nestjs/common';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@domain/events/wager-events';
import { FailureCode } from '@domain/failure-code';
import type { WagerTransaction } from '@domain/wager-transaction';
import { checkReferenceRules } from '@domain/wager-reference-rules';
import type { Wallet } from '@domain/wallet';
import { applyTransactionToWallet } from '@domain/wallet-movement';
import { IntegrationEventsService } from '@app/events/integration-events.service';
import type { TransactionalRepositories } from '@app/repositories/unit-of-work';
import { ID_GENERATOR, type IdGenerator } from '@app/system';
import { toSubmitResult } from './wager-result';
import type { SubmitWagerResult } from './wagering.types';

@Injectable()
export class WagerSettlement {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly events: IntegrationEventsService,
  ) {}

  async validateReference(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): Promise<FailureCode | undefined> {
    const rejection = checkReferenceRules(transaction, reference);
    if (rejection !== undefined) return rejection;

    if (transaction.requiresReference()) {
      const alreadyReversed = await repos.transactions.existsProcessedReversal(
        reference.id,
        transaction.kind,
      );
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }

  async apply(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      await repos.transactions.save(transaction);
      await this.events.record(
        repos.outbox,
        WagerTransactionProcessed.from(
          transaction,
          this.events.context(correlationId, now),
        ),
      );
      return toSubmitResult(transaction);
    }

    const outcome = applyTransactionToWallet({
      wallet,
      transaction,
      ...(reference ? { reference } : {}),
      entryId: this.ids.next(),
      at: now,
    });
    if (!outcome.applied) {
      return this.reject(
        repos,
        transaction,
        outcome.failureCode,
        correlationId,
        now,
        wallet,
      );
    }

    transaction.markProcessed(reference?.id, now, wallet.balance);
    await repos.ledger.insert(outcome.entry);
    await repos.wallets.save(wallet);
    await repos.transactions.save(transaction);

    await this.events.record(
      repos.outbox,
      WagerTransactionProcessed.from(
        transaction,
        this.events.context(correlationId, now),
      ),
    );
    await this.events.record(
      repos.outbox,
      WalletBalanceChanged.from(
        wallet,
        outcome.entry,
        this.events.context(correlationId, now),
      ),
    );
    return toSubmitResult(transaction);
  }

  async reject(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    code: FailureCode,
    correlationId: string,
    now: Date,
    wallet?: Wallet,
  ): Promise<SubmitWagerResult> {
    const observed =
      wallet && wallet.currency === transaction.money.currency
        ? wallet.balance
        : undefined;
    transaction.reject(code, observed);
    await repos.transactions.save(transaction);
    await this.events.record(
      repos.outbox,
      WagerTransactionRejected.from(
        transaction,
        this.events.context(correlationId, now),
      ),
    );
    return toSubmitResult(transaction);
  }

  async deferForReference(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    transaction.markPendingReference();
    await repos.transactions.save(transaction);
    await this.events.record(
      repos.outbox,
      WagerTransactionPendingReference.from(
        transaction,
        this.events.context(correlationId, now),
      ),
    );
    return toSubmitResult(transaction);
  }
}
