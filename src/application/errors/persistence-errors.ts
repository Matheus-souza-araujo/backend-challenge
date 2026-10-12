export class UniqueViolationError extends Error {
  constructor(
    public readonly constraintName: string,
    message?: string,
  ) {
    super(message ?? `Violação de constraint única: ${constraintName}`);
    this.name = 'UniqueViolationError';
  }
}

export class ForeignKeyViolationError extends Error {
  constructor(
    public readonly constraintName: string,
    message?: string,
  ) {
    super(message ?? `Violação de chave estrangeira: ${constraintName}`);
    this.name = 'ForeignKeyViolationError';
  }
}

export const CONSTRAINTS = {
  walletPlayerCurrency: 'uq_wallets_player_currency',
  idempotencyKey: 'uq_wager_tx_idempotency_key',
  providerExternal: 'uq_wager_tx_provider_external',
  reversalOnce: 'uq_wager_tx_reversal_once',
  ledgerTransactionWallet: 'uq_ledger_transaction_wallet',
  inboxPk: 'inbox_messages_pkey',
} as const;

export const RACE_CONSTRAINTS: readonly string[] = [
  CONSTRAINTS.idempotencyKey,
  CONSTRAINTS.providerExternal,
  CONSTRAINTS.reversalOnce,
  CONSTRAINTS.ledgerTransactionWallet,
  CONSTRAINTS.inboxPk,
];
