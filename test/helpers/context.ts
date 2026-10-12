import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import baseConfig from '../../mikro-orm.config';
import { NoopMetrics } from '@config/metrics';
import { IntegrationEventsService } from '@app/events/integration-events.service';
import type { Clock } from '@app/system';
import { PendingReferencesService } from '@app/wagering/pending-references.service';
import { WagerSettlement } from '@app/wagering/wager-settlement';
import { WageringService } from '@app/wagering/wagering.service';
import { WalletsService } from '@app/wallets/wallets.service';
import { MikroOrmUnitOfWork } from '@infra/persistence/unit-of-work';
import { SystemClock, UuidV7Generator } from '@infra/system';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://wagering:wagering@localhost:5442/wagering_test';

export const LOCALSTACK_ENDPOINT =
  process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export interface TestContext {
  orm: MikroORM;
  em: EntityManager;
  uow: MikroOrmUnitOfWork;
  wagering: WageringService;
  pendingReferences: PendingReferencesService;
  settlement: WagerSettlement;
  wallets: WalletsService;
  events: IntegrationEventsService;
  metrics: NoopMetrics;
  ids: UuidV7Generator;
  clock: SystemClock;
  close(): Promise<void>;
}

let databaseEnsured = false;

async function ensureTestDatabase(): Promise<void> {
  if (databaseEnsured) return;
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/wagering';

  const admin = await MikroORM.init({
    ...baseConfig,
    clientUrl: adminUrl.toString(),
    migrations: { ...baseConfig.migrations, disableForeignKeys: false },
    allowGlobalContext: true,
  });
  try {
    const exists = await admin.em
      .getConnection()
      .execute(`SELECT 1 FROM pg_database WHERE datname = ?`, [dbName]);
    if (exists.length === 0) {
      await admin.em.getConnection().execute(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.close(true);
  }
  databaseEnsured = true;
}

export async function createTestContext(
  clock: Clock = new SystemClock(),
): Promise<TestContext> {
  await ensureTestDatabase();
  const orm = await MikroORM.init({
    ...baseConfig,
    clientUrl: TEST_DATABASE_URL,
    allowGlobalContext: true,
  });
  await orm.getMigrator().up();

  const em = orm.em as EntityManager;
  const uow = new MikroOrmUnitOfWork(em);
  const ids = new UuidV7Generator();
  const systemClock = clock;
  const metrics = new NoopMetrics();

  const events = new IntegrationEventsService(ids);
  const settlement = new WagerSettlement(ids, events);
  const wagering = new WageringService(uow, clock, ids, metrics, settlement);
  const pendingReferences = new PendingReferencesService(
    uow,
    clock,
    metrics,
    settlement,
    events,
  );
  const wallets = new WalletsService(uow, clock, ids, metrics, events);

  return {
    orm,
    em,
    uow,
    wagering,
    pendingReferences,
    settlement,
    wallets,
    events,
    metrics,
    ids,
    clock: systemClock,
    close: () => orm.close(true),
  };
}

export async function resetDatabase(ctx: TestContext): Promise<void> {
  await ctx.em
    .getConnection()
    .execute(
      'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages CASCADE',
    );
}

export async function expectWalletLedgerInvariant(
  ctx: TestContext,
  walletId: string,
): Promise<void> {
  const result = await ctx.wallets.reconcile(walletId);
  expect(result.consistent).toBe(true);
  expect(result.difference.amount).toBe('0.00');
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `waitFor expirou: ${options.label ?? 'condição não satisfeita'}`,
  );
}

export class FakeClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
