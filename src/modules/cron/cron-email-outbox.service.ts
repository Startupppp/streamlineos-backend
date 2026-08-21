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

  /**
   * `processRetries` selects without an org predicate; RLS is what scopes it, so the
   * context each call runs in decides which rows it can see.
   *
   * SCH-014 made that split real. Platform mail (verification, password reset) carries
   * no organization and is now visible ONLY outside a tenant context — so the per-org
   * sweep alone would never flush a failed verification email again. The platform pass
   * runs first, deliberately outside `forEachOrg`, which is the only context that can
   * see those rows.
   */
  async flushOutbox(): Promise<{ processed: number; sent: number; dead: number }> {
    let processed = 0;
    let sent = 0;
    let dead = 0;

    const platform = await this.outbox.processRetries();
    processed += platform.processed;
    sent += platform.sent;
    dead += platform.dead;

    await forEachOrg(this.db, "email-outbox-flush", async () => {
      const result = await this.outbox.processRetries();
      processed += result.processed;
      sent += result.sent;
      dead += result.dead;
    });

    return { processed, sent, dead };
  }
}
