import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '@app/repositories/wager-transaction.repository';
import type { FailureCode } from '@domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@domain/wager-transaction';
import { WagerTransactionRecord } from '@infra/persistence/records';

function toTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: { amount: record.amount, currency: record.currency },
    referenceExternalTransactionId:
      record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode as FailureCode | null) ?? undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalance !== null
        ? { amount: record.observedBalance, currency: record.currency }
        : undefined,
  });
}

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ?? null,
      status: transaction.status,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
      referenceRetryCount: 0,
      referenceNextRetryAt: null,
    });
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      {
        status: transaction.status,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        failureCode: transaction.failureCode ?? null,
        observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
        processedAt: transaction.processedAt ?? null,
      },
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? toTransaction(record) : undefined;
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      idempotencyKey: key,
    });
    return record ? toTransaction(record) : undefined;
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? toTransaction(record) : undefined;
  }

  async existsProcessedReversal(
    referenceTransactionId: string,
    kind: string,
  ): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async claimPendingReferenceDue(
    limit: number,
    now: Date,
  ): Promise<PendingReferenceClaim[]> {
    const records = await this.em
      .qb(WagerTransactionRecord)
      .select('*')
      .where({
        status: WagerTransactionStatus.PendingReference,
        $or: [
          { referenceNextRetryAt: null },
          { referenceNextRetryAt: { $lte: now } },
        ],
      })
      .orderBy({ createdAt: 'ASC' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();

    return records.map((record) => ({
      transaction: toTransaction(record),
      retryCount: record.referenceRetryCount,
    }));
  }

  async scheduleReferenceRetry(
    transactionId: string,
    retryCount: number,
    nextRetryAt: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transactionId },
      { referenceRetryCount: retryCount, referenceNextRetryAt: nextRetryAt },
    );
  }
}
