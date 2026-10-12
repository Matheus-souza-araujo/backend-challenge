import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(18,2)' },
    version: { type: 'integer' },
    createdAt: {
      type: 'Date',
      fieldName: 'created_at',
      columnType: 'timestamptz',
    },
    updatedAt: {
      type: 'Date',
      fieldName: 'updated_at',
      columnType: 'timestamptz',
    },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  status!: string;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  observedBalance!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;

  referenceRetryCount!: number;
  referenceNextRetryAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'string',
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(18,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    status: { type: 'string' },
    referenceTransactionId: {
      type: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    observedBalance: {
      type: 'string',
      fieldName: 'observed_balance',
      columnType: 'numeric(18,2)',
      nullable: true,
    },
    createdAt: {
      type: 'Date',
      fieldName: 'created_at',
      columnType: 'timestamptz',
    },
    processedAt: {
      type: 'Date',
      fieldName: 'processed_at',
      columnType: 'timestamptz',
      nullable: true,
    },
    referenceRetryCount: {
      type: 'integer',
      fieldName: 'reference_retry_count',
    },
    referenceNextRetryAt: {
      type: 'Date',
      fieldName: 'reference_next_retry_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(18,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: {
      type: 'string',
      fieldName: 'balance_before',
      columnType: 'numeric(18,2)',
    },
    balanceAfter: {
      type: 'string',
      fieldName: 'balance_after',
      columnType: 'numeric(18,2)',
    },
    createdAt: {
      type: 'Date',
      fieldName: 'created_at',
      columnType: 'timestamptz',
    },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: {
      type: 'Date',
      fieldName: 'received_at',
      columnType: 'timestamptz',
    },
    processedAt: {
      type: 'Date',
      fieldName: 'processed_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: {
      type: 'Date',
      fieldName: 'occurred_at',
      columnType: 'timestamptz',
    },
    attempts: { type: 'integer' },
    nextAttemptAt: {
      type: 'Date',
      fieldName: 'next_attempt_at',
      columnType: 'timestamptz',
      nullable: true,
    },
    publishedAt: {
      type: 'Date',
      fieldName: 'published_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
