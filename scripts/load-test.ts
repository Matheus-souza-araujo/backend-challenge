import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '@infra/sqs/sqs-client';

const BASE_URLS = (process.env.LOAD_BASE_URL ?? 'http://localhost:3000')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
let rr = 0;
const nextUrl = (): string => BASE_URLS[rr++ % BASE_URLS.length]!;
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const WALLETS = Number(process.env.WALLETS ?? 12);
const REPLAY_RATE = Number(process.env.REPLAY_RATE ?? 0.15);
const RACE_RATE = Number(process.env.RACE_RATE ?? 0.2);
const SQS_RATE = Number(process.env.SQS_RATE ?? 0.15);
const OVERDRAW_RATE = Number(process.env.OVERDRAW_RATE ?? 0.03);

const BURST_RATE = Number(process.env.BURST_RATE ?? 0.06);
const BURST_SIZE = Number(process.env.BURST_SIZE ?? 4);
const INITIAL_BALANCE = '100000.00';

const KEYCLOAK_ISSUER =
  process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/wagering';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'provider-a';
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? 'provider-a-secret';

interface Sample {
  ms: number;
  status: number;
  outcome: string;
  replay: boolean;
}

const samples: Sample[] = [];
let sqsSent = 0;

function uuid(): string {
  return crypto.randomUUID();
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] ?? 0;
}

async function getToken(): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${KEYCLOAK_ISSUER}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { access_token?: string };
    return body.access_token;
  } catch {
    return undefined;
  }
}

function headers(
  token: string | undefined,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function openWallet(
  token: string | undefined,
): Promise<{ id: string; playerId: string }> {
  const playerId = uuid();
  const res = await fetch(`${nextUrl()}/wallets`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
    }),
  });
  if (!res.ok)
    throw new Error(`Falha ao criar wallet: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
}

async function submitHttp(
  payload: WagerPayload,
  key: string,
  token: string | undefined,
): Promise<void> {
  const started = performance.now();
  try {
    const res = await fetch(`${nextUrl()}/wagering/transactions`, {
      method: 'POST',
      headers: headers(token, key),
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as {
      status?: string;
      failureCode?: string;
      idempotentReplay?: boolean;
    };
    samples.push({
      ms: performance.now() - started,
      status: res.status,
      outcome: body.failureCode ?? body.status ?? String(res.status),
      replay: body.idempotentReplay === true,
    });
  } catch (error) {
    samples.push({
      ms: performance.now() - started,
      status: 0,
      outcome: `network:${(error as Error).message.slice(0, 30)}`,
      replay: false,
    });
  }
}

async function main(): Promise<void> {
  const token = await getToken();
  console.log(
    `Alvo:        ${BASE_URLS.join(', ')}${token ? ' (autenticado)' : ' (sem auth)'}`,
  );
  console.log(
    `Duração:     ${DURATION_S}s | concorrência: ${CONCURRENCY} | wallets: ${WALLETS}`,
  );
  console.log(
    `Mix:         replay ${(REPLAY_RATE * 100).toFixed(0)}% | rajada ${(BURST_RATE * 100).toFixed(0)}%x${BURST_SIZE} | via SQS ${(SQS_RATE * 100).toFixed(0)}% | sem saldo ${(OVERDRAW_RATE * 100).toFixed(0)}%`,
  );

  const wallets = await Promise.all(
    Array.from({ length: WALLETS }, () => openWallet(token)),
  );
  console.log(
    `Preparação:  ${wallets.length} wallets criadas com ${INITIAL_BALANCE} cada\n`,
  );

  const sqs = createSqsClient({
    sqs: {
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  } as Parameters<typeof createSqsClient>[0]);
  const queueUrl =
    process.env.WAGER_QUEUE_URL ??
    'http://localhost:4566/000000000000/wager-transactions.fifo';

  const deadline = Date.now() + DURATION_S * 1000;
  let sent = 0;

  const sentRequests: Array<{ key: string; payload: WagerPayload }> = [];

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      if (sentRequests.length > 0 && Math.random() < REPLAY_RATE) {
        const prev =
          sentRequests[Math.floor(Math.random() * sentRequests.length)]!;
        await submitHttp(prev.payload, prev.key, token);
        continue;
      }

      const wallet =
        Math.random() < RACE_RATE
          ? wallets[0]!
          : wallets[Math.floor(Math.random() * wallets.length)]!;

      const n = sent++;
      const ext = `load-${Date.now()}-${n}-${Math.floor(Math.random() * 1e6)}`;
      const key = `provider-a:${ext}`;
      const kind = n % 7 === 0 ? 'WIN' : n % 11 === 0 ? 'LOSS' : 'BET';
      const payload: WagerPayload = {
        providerId: 'provider-a',
        externalTransactionId: ext,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${ext}`,
        gameId: 'fortune-chimp',
        kind,
        money: {
          amount: Math.random() < OVERDRAW_RATE ? '999999.00' : '10.00',
          currency: 'BRL',
        },
      };

      if (Math.random() < BURST_RATE) {
        await Promise.all(
          Array.from({ length: BURST_SIZE }, () =>
            submitHttp(payload, key, token),
          ),
        );
        continue;
      }

      if (Math.random() < SQS_RATE) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({
              messageId: ext,
              type: 'WagerTransactionRequested',
              occurredAt: new Date().toISOString(),
              data: { ...payload, idempotencyKey: key },
            }),
            MessageGroupId: wallet.id,
            MessageDeduplicationId: ext,
          }),
        );
        sqsSent++;
        continue;
      }

      await submitHttp(payload, key, token);
      if (sentRequests.length < 500) sentRequests.push({ key, payload });
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsedS = (performance.now() - startedAt) / 1000;

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byOutcome = new Map<string, number>();
  for (const s of samples)
    byOutcome.set(s.outcome, (byOutcome.get(s.outcome) ?? 0) + 1);
  const errors = samples.filter(
    (s) => s.status === 0 || s.status >= 500,
  ).length;
  const replays = samples.filter((s) => s.replay).length;

  console.log('─'.repeat(58));
  console.log(`Duração real:      ${elapsedS.toFixed(1)}s`);
  console.log(
    `Requisições HTTP:  ${samples.length}  (${(samples.length / elapsedS).toFixed(1)} req/s)`,
  );
  console.log(`Mensagens SQS:     ${sqsSent}`);
  console.log(
    `Taxa de erro:      ${((errors / Math.max(samples.length, 1)) * 100).toFixed(2)}%`,
  );
  console.log(
    `Replays idemp.:    ${replays} (${((replays / Math.max(samples.length, 1)) * 100).toFixed(1)}% — duplicatas absorvidas sem duplicar efeito)`,
  );
  console.log('');
  console.log('Latência HTTP (ms)');
  console.log(`  p50  ${pct(latencies, 50).toFixed(1)}`);
  console.log(`  p95  ${pct(latencies, 95).toFixed(1)}`);
  console.log(`  p99  ${pct(latencies, 99).toFixed(1)}`);
  console.log(`  max  ${(latencies[latencies.length - 1] ?? 0).toFixed(1)}`);
  console.log('');
  console.log('Desfechos');
  for (const [outcome, count] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(28)} ${count}`);
  }
  console.log('─'.repeat(58));
  console.log('Dashboard: http://localhost:3001');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
