import { Injectable } from "@nestjs/common";
import { EmailOutboxService } from "../email/email-outbox.service";

@Injectable()
export class CronEmailOutboxService {
  constructor(private readonly outbox: EmailOutboxService) {}

  flushOutbox(): Promise<{ processed: number; sent: number; dead: number }> {
    return this.outbox.processRetries();
  }
}
