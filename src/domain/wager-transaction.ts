import {
  InvalidDomainInputError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors';
import { FailureCode } from './failure-code';
import { Money, type MoneyProps } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const VALID_TRANSITIONS: Record<
  WagerTransactionStatus,
  readonly WagerTransactionStatus[]
> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: MoneyProps;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,

    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,

    private _observedBalance?: Money,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const hasReference =
      props.referenceExternalTransactionId !== undefined &&
      props.referenceExternalTransactionId !== '';

    if (WagerTransaction.kindRequiresReference(props.kind) && !hasReference) {
      throw new InvalidReferenceError(
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (hasReference && !(props.kind in ALLOWED_REFERENCE_KINDS)) {
      throw new InvalidReferenceError(
        `${props.kind} não pode carregar referência`,
      );
    }
    if (props.money.isNegative()) {
      throw new InvalidDomainInputError(
        'Valor da transação não pode ser negativo',
      );
    }
    if (
      props.kind !== WagerTransactionKind.Opening &&
      !props.money.isPositive()
    ) {
      throw new InvalidDomainInputError('Valor da transação deve ser positivo');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      hasReference ? props.referenceExternalTransactionId : undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.rehydrate(state.money.amount, state.money.currency),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance
        ? Money.rehydrate(
            state.observedBalance.amount,
            state.observedBalance.currency,
          )
        : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    this.transition(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.transition(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._observedBalance = observedBalance;
  }

  fail(code: FailureCode): void {
    this.transition(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  private transition(to: WagerTransactionStatus): void {
    if (!VALID_TRANSITIONS[this._status].includes(to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    this._status = to;
  }

  isTerminal(): boolean {
    return VALID_TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    if (this.kind === WagerTransactionKind.Loss) return false;
    if (this.kind === WagerTransactionKind.Opening)
      return this.money.isPositive();
    return true;
  }

  requiresReference(): boolean {
    return WagerTransaction.kindRequiresReference(this.kind);
  }

  canReference(kind: WagerTransactionKind): boolean {
    return (ALLOWED_REFERENCE_KINDS[this.kind] ?? []).includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidReferenceError(
            'ROLLBACK exige a transação referenciada para derivar a direção',
          );
        }
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidDomainInputError(
          'LOSS não afeta saldo — sem direção de ledger',
        );
    }
  }

  private static kindRequiresReference(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }
}
