export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(
      `Idempotency key reutilizada com payload diferente: ${idempotencyKey}`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Já existe wallet para o player ${playerId} em ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet não encontrada: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class TransactionNotFoundError extends Error {
  constructor(reference: string) {
    super(`Transação não encontrada: ${reference}`);
    this.name = 'TransactionNotFoundError';
  }
}
