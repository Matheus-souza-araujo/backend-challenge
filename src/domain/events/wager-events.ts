import type { FailureCode } from '@domain/failure-code';
import type { MoneyProps } from '@domain/money';
import type {
  WagerTransaction,
  WagerTransactionKind,
} from '@domain/wager-transaction';
import type { Wallet } from '@domain/wallet';
import type {
  WalletLedgerEntry,
  LedgerDirection,
} from '@domain/wallet-ledger-entry';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (transaction.failureCode === undefined) {
      throw new Error('Transação rejeitada sem failureCode');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (transaction.referenceExternalTransactionId === undefined) {
      throw new Error(
        'Transação PENDING_REFERENCE sem referenceExternalTransactionId',
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
      },
    });
  }
}
