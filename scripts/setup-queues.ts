import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const MAX_RECEIVE_COUNT = 5;

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

async function createQueue(
  name: string,
  extraAttributes: Record<string, string> = {},
): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',

        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        ...extraAttributes,
      },
    }),
  );
  if (!QueueUrl) throw new Error(`CreateQueue não retornou URL para ${name}`);
  return QueueUrl;
}

async function queueArn(queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`Fila sem ARN: ${queueUrl}`);
  return arn;
}

async function main(): Promise<void> {
  const dlqUrl = await createQueue('wager-transactions-dlq.fifo');
  const dlqArn = await queueArn(dlqUrl);

  const mainUrl = await createQueue('wager-transactions.fifo', {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  });

  const eventsUrl = await createQueue('wager-events.fifo');

  console.log(`DLQ pronta:     ${dlqUrl}`);
  console.log(
    `Fila pronta:    ${mainUrl} (maxReceiveCount=${MAX_RECEIVE_COUNT})`,
  );
  console.log(`Eventos pronta: ${eventsUrl}`);
}

main().catch((error) => {
  console.error('Falha ao criar filas', error);
  process.exit(1);
});
