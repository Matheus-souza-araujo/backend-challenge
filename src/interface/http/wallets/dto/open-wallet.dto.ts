import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from '@interface/http/common/money.dto';

export class OpenWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
