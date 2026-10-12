import { Inject, Injectable } from '@nestjs/common';
import { WagerTransactionRejected } from '@domain/events/wager-events';
import { FailureCode } from '@domain/failure-code';
import { IntegrationEventsService } from '@app/events/integration-events.service';
import { METRICS, type Metrics } from '@config/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '@app/repositories/unit-of-work';
import { CLOCK, type Clock } from '@app/system';
import { WagerSettlement } from './wager-settlement';
import type { ResolvePendingSummary } from './wagering.types';

const MAX_REFERENCE_RETRIES = 8;
const BASE_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 300;

function retryDelaySeconds(retryCount: number): number {
  return Math.min(BASE_DELAY_SECONDS * 2 ** retryCount, MAX_DELAY_SECONDS);
}

@Injectable()
export class PendingReferencesService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly settlement: WagerSettlement,
    private readonly events: IntegrationEventsService,
  ) {}

  async resolveDue(batchSize: number): Promise<ResolvePendingSummary> {
    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const claims = await repos.transactions.claimPendingReferenceDue(
        batchSize,
        now,
      );
      const summary: ResolvePendingSummary = {
        claimed: claims.length,
        processed: 0,
        rescheduled: 0,
        rejected: 0,
      };
      const record = (
        outcome: 'processed' | 'rescheduled' | 'rejected',
      ): void => {
        summary[outcome] += 1;
        this.metrics.pendingReference(outcome);
      };

      for (const { transaction, retryCount } of claims) {
        const referenceId = transaction.referenceExternalTransactionId;
        const reference =
          referenceId !== undefined
            ? await repos.transactions.findByProviderExternalId(
                transaction.providerId,
                referenceId,
              )
            : undefined;

        const correlationId = transaction.id;

        if (!reference || !reference.isTerminal()) {
          if (retryCount + 1 >= MAX_REFERENCE_RETRIES) {
            transaction.reject(FailureCode.ReferenceNotFound);
            await repos.transactions.save(transaction);
            await this.events.record(
              repos.outbox,
              WagerTransactionRejected.from(
                transaction,
                this.events.context(correlationId, now),
              ),
            );
            record('rejected');
          } else {
            const nextAt = new Date(
              now.getTime() + retryDelaySeconds(retryCount) * 1000,
            );
            await repos.transactions.scheduleReferenceRetry(
              transaction.id,
              retryCount + 1,
              nextAt,
            );
            record('rescheduled');
          }
          continue;
        }

        const wallet = transaction.affectsBalance()
          ? await repos.wallets.findByIdForUpdate(transaction.walletId)
          : await repos.wallets.findById(transaction.walletId);
        if (!wallet) {
          transaction.fail(FailureCode.InternalError);
          await repos.transactions.save(transaction);
          continue;
        }

        const rejection = await this.settlement.validateReference(
          repos,
          transaction,
          reference,
        );
        if (rejection !== undefined) {
          await this.settlement.reject(
            repos,
            transaction,
            rejection,
            correlationId,
            now,
            wallet,
          );
          record('rejected');
          continue;
        }

        await this.settlement.apply(
          repos,
          transaction,
          wallet,
          reference,
          correlationId,
          now,
        );
        record('processed');
      }

      return summary;
    });
  }
}
