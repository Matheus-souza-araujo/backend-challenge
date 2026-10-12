import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const INPUT_AMOUNT = /^\d{1,16}\.\d{2}$/;

const STORED_AMOUNT = /^-?\d{1,16}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);
    if (typeof props.amount !== 'string' || !INPUT_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError(
        `Valor monetário inválido: ${JSON.stringify(props.amount)} — esperado string decimal não-negativa com 2 casas (ex.: "25.00")`,
      );
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  static rehydrate(amount: string, currency: string): Money {
    Money.assertCurrency(currency);
    if (typeof amount !== 'string' || !STORED_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        `Valor persistido inválido: ${JSON.stringify(amount)}`,
      );
    }
    return new Money(new Decimal(amount), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(
        `Moeda inválida: ${JSON.stringify(currency)} — esperado código ISO-4217`,
      );
    }
  }
}
