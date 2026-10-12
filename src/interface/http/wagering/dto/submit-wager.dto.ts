import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '@domain/wager-transaction';
import { MoneyDto } from '@interface/http/common/money.dto';

const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export class SubmitWagerDto {
  @IsString()
  @Length(1, 128)
  providerId!: string;

  @IsString()
  @Length(1, 256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 256)
  roundId!: string;

  @IsString()
  @Length(1, 256)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS)
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  referenceExternalTransactionId?: string;
}
