import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ID_GENERATOR, type IdGenerator } from '@app/system';
import { WageringService } from '@app/wagering/wagering.service';
import type {
  SubmitWagerResult,
  WagerTransactionView,
} from '@app/wagering/wagering.types';
import { WagerTransactionStatus } from '@domain/wager-transaction';
import { SubmitWagerDto } from './dto/submit-wager.dto';

const STATUS_BY_OUTCOME: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
};

@Controller()
export class WageringController {
  constructor(
    private readonly wagering: WageringService,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerResult> {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new BadRequestException('Header Idempotency-Key é obrigatório');
    }

    const result = await this.wagering.submit({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      ...(body.referenceExternalTransactionId !== undefined
        ? {
            referenceExternalTransactionId: body.referenceExternalTransactionId,
          }
        : {}),
      correlationId: this.ids.next(),
    });

    response.status(STATUS_BY_OUTCOME[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<WagerTransactionView> {
    return this.wagering.findById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.wagering.findByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
