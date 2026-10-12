import type { Wallet } from '@domain/wallet';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;

  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
}
