import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';

export function checkReferenceRules(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (!transaction.canReference(reference.kind)) {
    return FailureCode.InvalidReferenceKind;
  }

  if (
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.roundId !== transaction.roundId ||
    reference.money.currency !== transaction.money.currency
  ) {
    return FailureCode.ReferenceMismatch;
  }

  if (
    transaction.requiresReference() &&
    !transaction.money.equals(reference.money)
  ) {
    return FailureCode.AmountMismatch;
  }

  return undefined;
}
