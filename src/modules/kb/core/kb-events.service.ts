import { Inject, Injectable } from "@nestjs/common";
import { kbEvents, type KbEventType } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export interface RecordKbEventOptions {
  actorMembershipId?: number | null;
  articleId?: number | null;
  query?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class KbEventsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * `kb_events` is RLS-enabled, so a bare insert dies 42501 the moment there is
   * no tenant GUC — which is exactly the state the KB AI routes are in, because
   * they carry `@NoTenantTransaction()` to avoid pinning a pooled connection
   * across a provider round trip. `runInTenantTransaction` reuses an ambient
   * request transaction when one exists, so every caller that still has one is
   * unaffected, and the callers that deliberately released theirs get a short
   * transaction of their own instead of a swallowed write.
   *
   * It also refuses an orgId that disagrees with an ambient context, turning
   * what would have been a cross-tenant write into a throw.
   */
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
        });
      },
      { orgId },
    );
  }
}
