export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`Moedas incompatíveis: esperado ${expected}, recebido ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string) {
    super(`Saldo insuficiente na wallet ${walletId}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super(`Transição de status inválida: ${from} → ${to}`);
  }
}

export class InvalidReferenceError extends DomainError {}

export class LedgerArithmeticError extends DomainError {}

export class InvalidDomainInputError extends DomainError {}
