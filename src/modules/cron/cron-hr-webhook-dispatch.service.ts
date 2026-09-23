import { Injectable, Logger } from "@nestjs/common";
import { HrWebhookDispatchService } from "../hr/recruitment/webhooks/hr-webhook-dispatch.service";

/**
 * Runs periodically to sweep and dispatch pending HR webhooks.
 */
@Injectable()
export class CronHrWebhookDispatchService {
  private readonly logger = new Logger(CronHrWebhookDispatchService.name);

  constructor(private readonly dispatchService: HrWebhookDispatchService) {}

  async sweep(): Promise<void> {
    try {
      await this.dispatchService.sweep();
    } catch (error) {
      this.logger.error("[cron] hr webhook dispatch sweep failed", { error });
    }
  }
}
