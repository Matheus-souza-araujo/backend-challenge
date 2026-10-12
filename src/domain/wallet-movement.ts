import { InsufficientFundsError } from './errors';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface ApplyMovementProps {
  wallet: Wallet;
  transaction: WagerTransaction;

  reference?: WagerTransaction;
  entryId: string;
  at: Date;
}

export type MovementOutcome =
  | { applied: true; entry: WalletLedgerEntry }
  | { applied: false; failureCode: FailureCode };

export function applyTransactionToWallet(
  props: ApplyMovementProps,
): MovementOutcome {
  const { wallet, transaction, reference } = props;
  const direction = transaction.ledgerDirectionFor(reference);
  const movement = {
    entryId: props.entryId,
    transactionId: transaction.id,
    money: transaction.money,
    at: props.at,
  };

  try {
    const entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(movement)
        : wallet.credit(movement);
    return { applied: true, entry };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return {
        applied: false,
        failureCode:
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalWouldOverdraw,
      };
    }
    throw error;
  }
}
