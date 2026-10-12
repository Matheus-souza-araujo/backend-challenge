import type { WagerTransaction } from '@domain/wager-transaction';
import type { SubmitWagerResult, WagerTransactionView } from './wagering.types';

export function toSubmitResult(
  transaction: WagerTransaction,
  options: { replay?: boolean } = {},
): SubmitWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode !== undefined
      ? { failureCode: transaction.failureCode }
      : {}),
    ...(transaction.observedBalance !== undefined
      ? { balance: transaction.observedBalance.toJSON() }
      : {}),
    idempotentReplay: options.replay === true,
  };
}

export function toTransactionView(
  transaction: WagerTransaction,
): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.failureCode !== undefined
      ? { failureCode: transaction.failureCode }
      : {}),
    ...(transaction.referenceTransactionId !== undefined
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.observedBalance !== undefined
      ? { balance: transaction.observedBalance.toJSON() }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt !== undefined
      ? { processedAt: transaction.processedAt.toISOString() }
      : {}),
  };
}
