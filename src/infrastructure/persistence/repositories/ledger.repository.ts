import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerAggregate,
  LedgerPage,
  LedgerRepository,
} from '@app/repositories/ledger.repository';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '@domain/wallet-ledger-entry';
import { WalletLedgerEntryRecord } from '@infra/persistence/records';

export class InvalidCursorError extends Error {
  constructor() {
    super('Cursor de paginação inválido');
    this.name = 'InvalidCursorError';
  }
}

interface LedgerCursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(entry: WalletLedgerEntry): string {
  const payload: LedgerCursorPayload = {
    createdAt: entry.createdAt.toISOString(),
    id: entry.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): LedgerCursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as LedgerCursorPayload;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string')
      throw new Error();
    if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return parsed;
  } catch {
    throw new InvalidCursorError();
  }
}

function toLedgerEntry(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: { amount: record.amount, currency: record.currency },
    balanceBefore: { amount: record.balanceBefore, currency: record.currency },
    balanceAfter: { amount: record.balanceAfter, currency: record.currency },
    createdAt: record.createdAt,
  });
}

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  }

  async listByWallet(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerPage> {
    const qb = this.em
      .qb(WalletLedgerEntryRecord)
      .select('*')
      .where({ walletId })
      .orderBy({ createdAt: 'DESC', id: 'DESC' })
      .limit(limit + 1);

    if (cursor !== undefined) {
      const { createdAt, id } = decodeCursor(cursor);

      qb.andWhere('(created_at, id) < (?, ?)', [new Date(createdAt), id]);
    }

    const records = await qb.getResultList();
    const page = records.slice(0, limit).map(toLedgerEntry);
    const hasMore = records.length > limit;
    const last = page[page.length - 1];
    return {
      entries: page,
      ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async aggregateByWallet(walletId: string): Promise<LedgerAggregate> {
    const rows = await this.em
      .getConnection()
      .execute<{ credits: string; debits: string; entry_count: number }[]>(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debits,
           COUNT(*)::int AS entry_count
         FROM wallet_ledger_entries
         WHERE wallet_id = ?`,
        [walletId],
      );

    const row = rows[0];
    if (!row) throw new Error('Agregação do ledger não retornou linha');
    return {
      credits: row.credits,
      debits: row.debits,
      entryCount: row.entry_count,
    };
  }
}
