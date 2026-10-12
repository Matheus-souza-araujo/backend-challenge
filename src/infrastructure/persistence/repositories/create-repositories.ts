import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionalRepositories } from '@app/repositories/unit-of-work';
import { MikroInboxRepository } from './inbox.repository';
import { MikroLedgerRepository } from './ledger.repository';
import { MikroOutboxRepository } from './outbox.repository';
import { MikroWagerTransactionRepository } from './wager-transaction.repository';
import { MikroWalletRepository } from './wallet.repository';

export function createRepositories(
  em: EntityManager,
): TransactionalRepositories {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}
