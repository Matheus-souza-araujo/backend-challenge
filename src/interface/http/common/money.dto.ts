import { Matches } from 'class-validator';

export class MoneyDto {
  @Matches(/^\d{1,16}\.\d{2}$/, {
    message:
      'amount deve ser string decimal não-negativa com 2 casas (ex.: "25.00")',
  })
  amount!: string;

  @Matches(/^[A-Z]{3}$/, {
    message: 'currency deve ser código ISO-4217 (ex.: "BRL")',
  })
  currency!: string;
}
