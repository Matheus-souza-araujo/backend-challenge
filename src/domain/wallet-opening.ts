import { hashWagerPayload } from './idempotency/payload-hash';
import { Money } from './money';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletOpeningProps {
  wallet: Wallet;
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface WalletOpening {
  transaction: WagerTransaction;
  entry: WalletLedgerEntry;
}

const OPENING_PROVIDER = 'internal';
const OPENING_ROUND = 'opening';
const OPENING_GAME = 'internal';

export function createWalletOpening(props: WalletOpeningProps): WalletOpening {
  const { wallet, at } = props;
  const initialBalance = wallet.balance;
  const externalTransactionId = `opening:${wallet.id}`;

  const transaction = WagerTransaction.create({
    id: props.transactionId,
    providerId: OPENING_PROVIDER,
    externalTransactionId,
    idempotencyKey: `internal:opening:${wallet.id}`,
    payloadHash: hashWagerPayload({
      providerId: OPENING_PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: OPENING_ROUND,
      gameId: OPENING_GAME,
      kind: WagerTransactionKind.Opening,
      money: initialBalance.toJSON(),
    }),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: OPENING_ROUND,
    gameId: OPENING_GAME,
    kind: WagerTransactionKind.Opening,
    money: initialBalance,
    createdAt: at,
  });
  transaction.markProcessed(undefined, at, initialBalance);

  const entry = WalletLedgerEntry.create({
    id: props.entryId,
    walletId: wallet.id,
    transactionId: transaction.id,
    direction: LedgerDirection.Credit,
    money: initialBalance,
    balanceBefore: Money.zero(wallet.currency),
    balanceAfter: initialBalance,
    createdAt: at,
  });

  return { transaction, entry };
}
