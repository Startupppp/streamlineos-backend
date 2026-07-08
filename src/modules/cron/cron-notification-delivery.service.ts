import { Injectable } from "@nestjs/common";
import { NotificationDeliveryWorker } from "../notifications/notification-delivery-worker.service";

@Injectable()
export class CronNotificationDeliveryService {
  constructor(private readonly worker: NotificationDeliveryWorker) {}

  flush(): Promise<{ processed: number; sent: number; failed: number; dead: number }> {
    return this.worker.processQueue();
  }
}
