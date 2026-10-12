import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  createTestContext,
  resetDatabase,
  type TestContext,
} from '@test/helpers/context';
import { useRealInfraTimeouts } from '@test/helpers/setup';

useRealInfraTimeouts();

let ctx: TestContext;

const sql = (query: string, params: unknown[] = []) =>
  ctx.em.getConnection().execute(query, params);

const WALLET = '11111111-1111-7111-8111-111111111111';
const TX_A = '22222222-2222-7222-8222-222222222222';
const TX_B = '33333333-3333-7333-8333-333333333333';

async function seedWallet(
  id = WALLET,
  player = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
): Promise<void> {
  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', 100.00, 1, now(), now())`,
    [id, player],
  );
}

async function seedTransaction(
  id: string,
  externalId: string,
  overrides: {
    kind?: string;
    status?: string;
    referenceId?: string | null;
    idempotencyKey?: string;
  } = {},
): Promise<void> {
  await sql(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, status, reference_transaction_id, created_at)
     VALUES (?, 'provider-a', ?, ?, 'hash', ?, 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
             'round-1', 'game-1', ?, 10.00, 'BRL', ?, ?, now())`,
    [
      id,
      externalId,
      overrides.idempotencyKey ?? `provider-a:${externalId}`,
      WALLET,
      overrides.kind ?? 'BET',
      overrides.status ?? 'PROCESSED',
      overrides.referenceId ?? null,
    ],
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

describe('constraints do schema', () => {
  it('uq_wallets_player_currency: uma wallet por (player, moeda)', async () => {
    await seedWallet();
    await expect(seedWallet(TX_A)).rejects.toThrow(
      /uq_wallets_player_currency/,
    );
  });

  it('ck_wallets_balance_non_negative: saldo nunca negativo', async () => {
    await seedWallet();
    await expect(
      sql(`UPDATE wallets SET balance = -0.01 WHERE id = ?`, [WALLET]),
    ).rejects.toThrow(/ck_wallets_balance_non_negative/);
  });

  it('uq_wager_tx_idempotency_key: idempotency key única', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-1');
    await expect(
      sql(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind, amount, currency, status, created_at)
         VALUES (?, 'provider-b', 'ext-outra', 'provider-a:ext-1', 'hash', ?,
                 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', now())`,
        [TX_B, WALLET],
      ),
    ).rejects.toThrow(/uq_wager_tx_idempotency_key/);
  });

  it('uq_wager_tx_provider_external: (provider, external_id) único', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-1');
    await expect(
      seedTransaction(TX_B, 'ext-1', { idempotencyKey: 'outra-key' }),
    ).rejects.toThrow(/uq_wager_tx_provider_external/);
  });

  it('uq_wager_tx_reversal_once: uma reversão PROCESSED por (referência, kind)', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-bet');
    await seedTransaction(TX_B, 'ext-rb-1', {
      kind: 'ROLLBACK',
      referenceId: TX_A,
    });
    await expect(
      seedTransaction('44444444-4444-7444-8444-444444444444', 'ext-rb-2', {
        kind: 'ROLLBACK',
        referenceId: TX_A,
      }),
    ).rejects.toThrow(/uq_wager_tx_reversal_once/);
  });

  it('uq_wager_tx_reversal_once não bloqueia reversões REJECTED', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-bet');
    await seedTransaction(TX_B, 'ext-rb-1', {
      kind: 'ROLLBACK',
      referenceId: TX_A,
      status: 'REJECTED',
    });

    await seedTransaction('44444444-4444-7444-8444-444444444444', 'ext-rb-2', {
      kind: 'ROLLBACK',
      referenceId: TX_A,
    });
  });

  it('uq_ledger_transaction_wallet: no máximo 1 lançamento por transação/wallet', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-1');
    const insertEntry = (id: string) =>
      sql(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, now())`,
        [id, WALLET, TX_A],
      );
    await insertEntry('55555555-5555-7555-8555-555555555555');
    await expect(
      insertEntry('66666666-6666-7666-8666-666666666666'),
    ).rejects.toThrow(/uq_ledger_transaction_wallet/);
  });

  it('ck_ledger_arithmetic: aritmética do lançamento verificada no banco', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-1');
    await expect(
      sql(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES ('55555555-5555-7555-8555-555555555555', ?, ?, 'DEBIT', 10.00, 'BRL', 100.00, 95.00, now())`,
        [WALLET, TX_A],
      ),
    ).rejects.toThrow(/ck_ledger_arithmetic/);
  });

  it('trigger: ledger é imutável (UPDATE e DELETE falham)', async () => {
    await seedWallet();
    await seedTransaction(TX_A, 'ext-1');
    await sql(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ('55555555-5555-7555-8555-555555555555', ?, ?, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, now())`,
      [WALLET, TX_A],
    );
    await expect(
      sql(`UPDATE wallet_ledger_entries SET amount = 5.00`),
    ).rejects.toThrow(/imutável/);
    await expect(sql(`DELETE FROM wallet_ledger_entries`)).rejects.toThrow(
      /imutável/,
    );
  });

  it('inbox: PK composta (consumer, message) impede duplicata', async () => {
    const insert = () =>
      sql(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES ('consumer-1', 'msg-1', 'hash', now())`,
      );
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pkey/);
  });
});
