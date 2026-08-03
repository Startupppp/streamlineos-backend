import { Inject, Injectable } from "@nestjs/common";
import { forEachOrg } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationDeliveryWorker } from "../notifications/notification-delivery-worker.service";

@Injectable()
export class CronNotificationDeliveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly worker: NotificationDeliveryWorker,
  ) {}

  // processQueue scans notification_deliveries cross-org; the wrapper is what scopes it
  async flush(): Promise<{ processed: number; sent: number; failed: number; dead: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let dead = 0;

    await forEachOrg(this.db, "notification-delivery-flush", async () => {
      const result = await this.worker.processQueue();
      processed += result.processed;
      sent += result.sent;
      failed += result.failed;
      dead += result.dead;
    });

    return { processed, sent, failed, dead };
  }
}
