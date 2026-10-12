import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '@app/system';
import { WalletsService } from '@app/wallets/wallets.service';
import type {
  LedgerPageView,
  OpenWalletResult,
  ReconciliationView,
  WalletView,
} from '@app/wallets/wallets.types';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';

const DEFAULT_LEDGER_PAGE = 50;

@Controller('wallets')
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly wallets: WalletsService,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: OpenWalletDto): Promise<OpenWalletResult> {
    return this.wallets.open({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: this.ids.next(),
    });
  }

  @Get(':walletId')
  async get(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletView> {
    return this.wallets.findById(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: LedgerQueryDto,
  ): Promise<LedgerPageView> {
    return this.wallets.findLedger(
      walletId,
      query.limit ?? DEFAULT_LEDGER_PAGE,
      query.cursor,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<ReconciliationView> {
    const result = await this.wallets.reconcile(walletId);
    if (!result.consistent) {
      this.logger.error(
        { walletId, difference: result.difference },
        'Divergência entre saldo materializado e ledger',
      );
    }
    return result;
  }
}
