import type { WalletLedgerEntry } from '@domain/wallet-ledger-entry';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerAggregate {
  credits: string;
  debits: string;
  entryCount: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerPage>;
  aggregateByWallet(walletId: string): Promise<LedgerAggregate>;
}
