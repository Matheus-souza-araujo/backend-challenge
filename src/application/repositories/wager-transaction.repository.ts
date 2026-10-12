import type { WagerTransaction } from '@domain/wager-transaction';

export interface PendingReferenceClaim {
  transaction: WagerTransaction;
  retryCount: number;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  existsProcessedReversal(
    referenceTransactionId: string,
    kind: string,
  ): Promise<boolean>;

  claimPendingReferenceDue(
    limit: number,
    now: Date,
  ): Promise<PendingReferenceClaim[]>;

  scheduleReferenceRetry(
    transactionId: string,
    retryCount: number,
    nextRetryAt: Date,
  ): Promise<void>;
}
