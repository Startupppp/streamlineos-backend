import { Inject, Injectable } from "@nestjs/common";
import { kbEvents, type KbEventType } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { logger } from "../../../common/logger/logger.service";

export interface RecordKbEventOptions {
  actorMembershipId?: number | null;
  articleId?: number | null;
  query?: string | null;
  metadata?: Record<string, unknown> | null;
  correlationId?: string | null;
}

@Injectable()
export class KbEventsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(
    orgId: string,
    eventType: KbEventType,
    options: RecordKbEventOptions = {},
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.insert(kbEvents).values({
          orgId,
          eventType,
          actorMembershipId: options.actorMembershipId ?? null,
          articleId: options.articleId ?? null,
          query: options.query ?? null,
          metadata: options.metadata ?? null,
          correlationId: options.correlationId ?? null,
        });
      },
      { orgId },
    );
  }

  recordDetached(
    orgId: string,
    eventType: KbEventType,
    options: RecordKbEventOptions = {},
  ): Promise<void> {
    const deferred = registerAfterCommit(async () => {
      await this.record(orgId, eventType, options);
    });
    if (deferred) return Promise.resolve();

    return this.record(orgId, eventType, options).catch((error: unknown) => {
      logger.error(
        "[kb] could not record a KB event on the inline fallback path",
        {
          orgId,
          eventType,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
  }
}
