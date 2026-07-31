import { Inject, Injectable } from "@nestjs/common";
import { forEachOrg } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailOutboxService } from "../email/email-outbox.service";

@Injectable()
export class CronEmailOutboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly outbox: EmailOutboxService,
  ) {}

  // processRetries scans email_outbox cross-org; the wrapper is what scopes it
  async flushOutbox(): Promise<{ processed: number; sent: number; dead: number }> {
    let processed = 0;
    let sent = 0;
    let dead = 0;

    await forEachOrg(this.db, "email-outbox-flush", async () => {
      const result = await this.outbox.processRetries();
      processed += result.processed;
      sent += result.sent;
      dead += result.dead;
    });

    return { processed, sent, dead };
  }
}
