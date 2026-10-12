export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
  };
  auth: {
    enabled: boolean;
    issuer: string;
    audience: string;

    jwksUri: string;
  };
  workers: {
    sqsConsumer: boolean;
    outboxPublisher: boolean;
    pendingReferenceResolver: boolean;
  };
  runMigrationsOnBoot: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
  return value;
}

function optional(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = optional(env, 'NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV inválido: ${nodeEnv}`);
  }

  const port = Number(optional(env, 'PORT', '3000'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT inválida: ${env.PORT}`);
  }

  const authEnabled = optional(env, 'AUTH_ENABLED', 'true') === 'true';

  return {
    port,
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    databaseUrl: required(env, 'DATABASE_URL'),
    sqs: {
      endpoint: required(env, 'SQS_ENDPOINT'),
      region: optional(env, 'AWS_REGION', 'us-east-1'),
      accessKeyId: optional(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: optional(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueUrl: required(env, 'WAGER_QUEUE_URL'),
      wagerDlqUrl: required(env, 'WAGER_DLQ_URL'),
      eventsQueueUrl: required(env, 'WAGER_EVENTS_QUEUE_URL'),
    },
    auth: {
      enabled: authEnabled,
      issuer: authEnabled
        ? required(env, 'KEYCLOAK_ISSUER')
        : optional(env, 'KEYCLOAK_ISSUER', ''),
      audience: authEnabled
        ? required(env, 'KEYCLOAK_AUDIENCE')
        : optional(env, 'KEYCLOAK_AUDIENCE', ''),
      jwksUri: optional(
        env,
        'KEYCLOAK_JWKS_URI',
        `${optional(env, 'KEYCLOAK_ISSUER', '')}/protocol/openid-connect/certs`,
      ),
    },
    workers: {
      sqsConsumer: optional(env, 'SQS_CONSUMER_ENABLED', 'true') === 'true',
      outboxPublisher:
        optional(env, 'OUTBOX_PUBLISHER_ENABLED', 'true') === 'true',
      pendingReferenceResolver:
        optional(env, 'PENDING_REFERENCE_WORKER_ENABLED', 'true') === 'true',
    },
    runMigrationsOnBoot: optional(env, 'RUN_MIGRATIONS', 'false') === 'true',
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
