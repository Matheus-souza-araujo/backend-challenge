import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainInputError,
} from './errors';
import { Money, type MoneyProps } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainInputError('Saldo inicial não pode ser negativo');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance.amount, state.balance.currency),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(
    direction: LedgerDirection,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw new InvalidDomainInputError('Movimentação exige valor positivo');
    }

    const before = this._balance;
    const after =
      direction === LedgerDirection.Debit
        ? before.subtract(props.money)
        : before.add(props.money);

    if (after.isNegative()) {
      throw new InsufficientFundsError(this.id);
    }

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
