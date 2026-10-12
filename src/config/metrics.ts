export type Channel = 'http' | 'sqs' | 'worker';
export type ConsumerOutcome =
  'processed' | 'business_error' | 'transient_error' | 'malformed';
export type PendingReferenceOutcome = 'processed' | 'rescheduled' | 'rejected';

export interface Metrics {
  transactionOutcome(status: string, kind: string, channel: Channel): void;
  idempotentReplay(channel: Channel): void;

  raceRetry(constraint: string): void;
  processingDuration(seconds: number): void;
  consumerOutcome(outcome: ConsumerOutcome): void;
  outboxPublished(count: number): void;
  outboxRetry(): void;
  pendingReference(outcome: PendingReferenceOutcome): void;
  reconciliationDivergence(): void;
}

export class NoopMetrics implements Metrics {
  transactionOutcome(): void {}
  idempotentReplay(): void {}
  raceRetry(): void {}
  processingDuration(): void {}
  consumerOutcome(): void {}
  outboxPublished(): void {}
  outboxRetry(): void {}
  pendingReference(): void {}
  reconciliationDivergence(): void {}
}

export const METRICS = Symbol('METRICS');
