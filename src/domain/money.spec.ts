import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it('aceita string decimal com escala 2', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.01').toString()).toBe('0.01 BRL');
  });

  it.each([
    '',
    '25',
    '25.5',
    '25.005',
    '-5.00',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e2',
    '2.5e1',
    '25,00',
    ' 25.00',
    '25.00 ',
    '+25.00',
  ])('rejeita entrada inválida %j', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita valores não-string', () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  it('rejeita moeda fora do formato ISO-4217', () => {
    expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: '25.00', currency: 'REAIS' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: '25.00', currency: '' })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('aritmética', () => {
  it('add/subtract são exatos e imutáveis', () => {
    const a = brl('0.10');
    const b = brl('0.20');
    const sum = a.add(b);
    expect(sum.toJSON().amount).toBe('0.30');
    expect(a.toJSON().amount).toBe('0.10');
  });

  it('subtract pode produzir negativo internamente', () => {
    const result = brl('10.00').subtract(brl('15.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-5.00');
  });

  it('negate inverte o sinal', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
  });

  it('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => brl('5.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('5.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('5.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('comparações', () => {
  it('zero / positivo / negativo', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  it('equals considera valor e moeda', () => {
    expect(brl('5.00').equals(brl('5.00'))).toBe(true);
    expect(brl('5.00').equals(brl('5.01'))).toBe(false);
    expect(
      brl('5.00').equals(Money.from({ amount: '5.00', currency: 'USD' })),
    ).toBe(false);
  });

  it('isLessThan', () => {
    expect(brl('5.00').isLessThan(brl('5.01'))).toBe(true);
    expect(brl('5.01').isLessThan(brl('5.00'))).toBe(false);
  });
});

describe('Money.rehydrate', () => {
  it('aceita valores persistidos com sinal', () => {
    expect(Money.rehydrate('-5.00', 'BRL').isNegative()).toBe(true);
    expect(Money.rehydrate('5', 'BRL').toJSON().amount).toBe('5.00');
  });

  it('rejeita lixo persistido', () => {
    expect(() => Money.rehydrate('abc', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.rehydrate('1e5', 'BRL')).toThrow(InvalidMoneyError);
  });
});
