import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PendingReferencesService } from '@app/wagering/pending-references.service';
import { APP_CONFIG, type AppConfig } from '@config/app-config';

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 20;

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly pendingReferences: PendingReferencesService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workers.pendingReferenceResolver) return;
    this.running = true;
    this.loop = this.resolveLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async resolveLoop(): Promise<void> {
    while (this.running) {
      try {
        const summary = await this.pendingReferences.resolveDue(BATCH_SIZE);
        if (summary.claimed > 0) {
          this.logger.log(summary, 'Referências pendentes reprocessadas');
        }
        if (summary.claimed === 0) await Bun.sleep(POLL_INTERVAL_MS);
      } catch (error) {
        if (!this.running) break;
        this.logger.error(
          { err: error },
          'Falha no worker de referências pendentes',
        );
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
  }
}
