import type { FailureCode } from '@domain/failure-code';
import type { MoneyProps } from '@domain/money';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@domain/wager-transaction';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;

  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;

  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

export interface ResolvePendingSummary {
  claimed: number;
  processed: number;
  rescheduled: number;
  rejected: number;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}
