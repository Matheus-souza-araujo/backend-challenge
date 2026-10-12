import { Inject, Injectable } from '@nestjs/common';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '@domain/events/wager-events';
import { Money } from '@domain/money';
import { Wallet } from '@domain/wallet';
import { createWalletOpening } from '@domain/wallet-opening';
import {
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@app/errors/errors';
import { IntegrationEventsService } from '@app/events/integration-events.service';
import { METRICS, type Metrics } from '@config/metrics';
import {
  CONSTRAINTS,
  UniqueViolationError,
} from '@app/errors/persistence-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '@app/repositories/unit-of-work';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@app/system';
import type {
  LedgerPageView,
  OpenWalletCommand,
  OpenWalletResult,
  ReconciliationView,
  WalletView,
} from './wallets.types';

@Injectable()
export class WalletsService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly events: IntegrationEventsService,
  ) {}

  async open(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      return await this.uow.run(async (repos) => {
        const now = this.clock.now();
        const wallet = Wallet.open({
          id: this.ids.next(),
          playerId: command.playerId,
          initialBalance,
          at: now,
        });
        await repos.wallets.insert(wallet);

        if (initialBalance.isPositive()) {
          const opening = createWalletOpening({
            wallet,
            transactionId: this.ids.next(),
            entryId: this.ids.next(),
            at: now,
          });
          await repos.transactions.insert(opening.transaction);
          await repos.ledger.insert(opening.entry);

          const ctx = () => this.events.context(command.correlationId, now);
          await this.events.record(
            repos.outbox,
            WagerTransactionProcessed.from(opening.transaction, ctx()),
          );
          await this.events.record(
            repos.outbox,
            WalletBalanceChanged.from(wallet, opening.entry, ctx()),
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraintName === CONSTRAINTS.walletPlayerCurrency
      ) {
        throw new WalletAlreadyExistsError(
          command.playerId,
          initialBalance.currency,
        );
      }
      throw error;
    }
  }

  async findById(walletId: string): Promise<WalletView> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }

  async findLedger(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerPageView> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const page = await repos.ledger.listByWallet(walletId, limit, cursor);
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      };
    });
  }

  async reconcile(walletId: string): Promise<ReconciliationView> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const aggregate = await repos.ledger.aggregateByWallet(walletId);
      const calculated = Money.rehydrate(
        aggregate.credits,
        wallet.currency,
      ).subtract(Money.rehydrate(aggregate.debits, wallet.currency));
      const difference = wallet.balance.subtract(calculated);
      if (!difference.isZero()) this.metrics.reconciliationDivergence();

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: aggregate.entryCount,
      };
    });
  }
}
