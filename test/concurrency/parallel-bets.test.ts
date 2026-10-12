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
  expectWalletLedgerInvariant,
  resetDatabase,
  type TestContext,
} from '@test/helpers/context';
import { spawnAppInstances, type AppInstances } from '@test/helpers/instances';
import { useRealInfraTimeouts } from '@test/helpers/setup';

useRealInfraTimeouts();

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let ctx: TestContext;
let instances: AppInstances;

interface SubmitResponse {
  status: number;
  body: {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance?: { amount: string };
    idempotentReplay: boolean;
  };
}

async function submit(
  baseUrl: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<SubmitResponse> {
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as SubmitResponse['body'],
  };
}

function betPayload(
  walletId: string,
  externalId: string,
  amount: string,
  roundId = 'round-1',
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId: PLAYER,
    walletId,
    roundId,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function openWallet(amount: string, playerId = PLAYER): Promise<string> {
  const result = await ctx.wallets.open({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'c',
  });
  return result.id;
}

async function debitCount(walletId: string): Promise<number> {
  const rows = await ctx.em
    .getConnection()
    .execute(
      `SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [walletId],
    );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  ctx = await createTestContext();

  instances = await spawnAppInstances(3);
});
afterAll(async () => {
  await instances.stop();
  await ctx.close();
});
beforeEach(async () => resetDatabase(ctx));

const url = (i: number) => instances.urls[i % instances.urls.length]!;

describe('concorrência multi-instância (3 processos reais)', () => {
  it('§13.1: a mesma aposta 50 vezes em paralelo → um único débito', async () => {
    const walletId = await openWallet('1000.00');
    const payload = betPayload(walletId, 'burst-1', '25.00');

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        submit(url(i), 'provider-a:burst-1', payload),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PROCESSED');
      expect(res.body.balance?.amount).toBe('975.00');
    }
    const transactionIds = new Set(responses.map((r) => r.body.transactionId));
    expect(transactionIds.size).toBe(1);

    expect(await debitCount(walletId)).toBe(1);
    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe(
      '975.00',
    );
    await expectWalletLedgerInvariant(ctx, walletId);
  });

  it('§8: duas apostas de 80.00 disputando saldo de 100.00', async () => {
    const walletId = await openWallet('100.00');

    const [a, b] = await Promise.all([
      submit(
        url(0),
        'provider-a:race-a',
        betPayload(walletId, 'race-a', '80.00'),
      ),
      submit(
        url(1),
        'provider-a:race-b',
        betPayload(walletId, 'race-b', '80.00'),
      ),
    ]);

    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = a.body.status === 'REJECTED' ? a : b;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe('20.00');
    expect(await debitCount(walletId)).toBe(1);

    const retry = await submit(
      url(2),
      rejected === a ? 'provider-a:race-a' : 'provider-a:race-b',
      betPayload(walletId, rejected === a ? 'race-a' : 'race-b', '80.00'),
    );
    expect(retry.body.idempotentReplay).toBe(true);
    expect(retry.body.status).toBe('REJECTED');
    expect(await debitCount(walletId)).toBe(1);
    await expectWalletLedgerInvariant(ctx, walletId);
  });

  it('§13.3: wallets distintas processadas em paralelo sem interferência', async () => {
    const players = Array.from(
      { length: 6 },
      (_, i) => `0192f28f-5dc0-7d58-bdb2-814ad6a0f4${i.toString(16)}0`,
    );
    const walletIds = await Promise.all(
      players.map((playerId) => openWallet('100.00', playerId)),
    );

    await Promise.all(
      walletIds.flatMap((walletId, w) =>
        Array.from({ length: 4 }, (_, i) =>
          submit(url(w + i), `provider-a:multi-${w}-${i}`, {
            ...betPayload(walletId, `multi-${w}-${i}`, '10.00', `round-${i}`),
            playerId: players[w]!,
          }),
        ),
      ),
    );

    for (const walletId of walletIds) {
      expect((await ctx.wallets.findById(walletId)).balance.amount).toBe(
        '60.00',
      );
      expect(await debitCount(walletId)).toBe(4);
      await expectWalletLedgerInvariant(ctx, walletId);
    }
  });

  it('reversão dupla concorrente: o índice único decide, uma só é aplicada', async () => {
    const walletId = await openWallet('100.00');
    await submit(
      url(0),
      'provider-a:rb-bet',
      betPayload(walletId, 'rb-bet', '30.00'),
    );

    const rollbackPayload = (externalId: string) => ({
      ...betPayload(walletId, externalId, '30.00'),
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'rb-bet',
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        submit(url(i), `provider-a:rb-${i}`, rollbackPayload(`rb-${i}`)),
      ),
    );

    const processed = results.filter((r) => r.body.status === 'PROCESSED');
    const rejected = results.filter((r) => r.body.status === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(r.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    }

    expect((await ctx.wallets.findById(walletId)).balance.amount).toBe(
      '100.00',
    );
    await expectWalletLedgerInvariant(ctx, walletId);
  });
});
