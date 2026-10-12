import type { Subprocess } from 'bun';
import { LOCALSTACK_ENDPOINT, TEST_DATABASE_URL, waitFor } from './context';

export interface AppInstances {
  urls: string[];
  stop(): Promise<void>;
}

export async function spawnAppInstances(
  count: number,
  envOverrides: Record<string, string> = {},
): Promise<AppInstances> {
  const basePort = 3150 + Math.floor(Math.random() * 500);
  const procs: Subprocess[] = [];
  const urls: string[] = [];

  for (let i = 0; i < count; i++) {
    const port = basePort + i;
    urls.push(`http://localhost:${port}`);
    procs.push(
      Bun.spawn(['bun', 'src/main.ts'], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          PORT: String(port),
          DATABASE_URL: TEST_DATABASE_URL,
          SQS_ENDPOINT: LOCALSTACK_ENDPOINT,
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          WAGER_QUEUE_URL: `${LOCALSTACK_ENDPOINT}/000000000000/wager-transactions.fifo`,
          WAGER_DLQ_URL: `${LOCALSTACK_ENDPOINT}/000000000000/wager-transactions-dlq.fifo`,
          WAGER_EVENTS_QUEUE_URL: `${LOCALSTACK_ENDPOINT}/000000000000/wager-events.fifo`,
          AUTH_ENABLED: 'false',
          SQS_CONSUMER_ENABLED: envOverrides.SQS_CONSUMER_ENABLED ?? 'false',
          OUTBOX_PUBLISHER_ENABLED:
            envOverrides.OUTBOX_PUBLISHER_ENABLED ?? 'false',
          PENDING_REFERENCE_WORKER_ENABLED:
            envOverrides.PENDING_REFERENCE_WORKER_ENABLED ?? 'false',
          RUN_MIGRATIONS: 'false',
          ...envOverrides,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    );
  }

  try {
    await Promise.all(
      urls.map((url) =>
        waitFor(
          async () => {
            try {
              const res = await fetch(`${url}/health/ready`);
              return res.ok;
            } catch {
              return false;
            }
          },
          { timeoutMs: 30_000, label: `instância ${url} pronta` },
        ),
      ),
    );
  } catch (error) {
    for (const proc of procs) proc.kill();
    throw error;
  }

  return {
    urls,
    async stop() {
      for (const proc of procs) proc.kill();
      await Promise.all(procs.map((proc) => proc.exited));
    },
  };
}
