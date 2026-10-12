import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '@app/repositories/wallet.repository';
import { Wallet } from '@domain/wallet';
import { WalletRecord } from '@infra/persistence/records';

function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: { amount: record.balance, currency: record.currency },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  async save(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }
}
