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

  /**
   * The same event, taken OFF the request path — for the read routes only.
   *
   * `recordView` (every article GET) and `search` (every search) each awaited an insert
   * into `kb_events` on the request's own tenant transaction. That is a write on the two
   * hottest read paths in the module, and it costs three separate things: the reader waits
   * on it, a WAL record is produced for a page view, and — the one that cannot be tuned
   * away — neither route can ever be served from a read replica, because a replica cannot
   * take the insert at all. `runInReplicaTenantRead` exists precisely for reads like these.
   *
   * `registerAfterCommit` is the right one of the three mechanisms here. The event is
   * analytics: it must not be recorded if the read itself rolled back, and losing one to a
   * crash costs a row in a usage chart, not correctness — so the durability of the outbox
   * would be paying for something nobody needs, and staying inside the transaction is what
   * we are removing. `TenantContextInterceptor` drains each hook in its own
   * `runInNewTenantTransaction`, does not await it before answering, and logs and reports
   * a failure rather than swallowing it.
   *
   * The fallback is not decoration. `registerAfterCommit` returns false when there is no
   * ambient context — the state every `@NoTenantTransaction()` KB route is in — and
   * dropping the event there would be a silent hole that only shows up as a suspiciously
   * quiet analytics table. It runs inline instead, which is exactly what these callers did
   * before.
   */
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
      logger.error("[kb] could not record a KB event on the inline fallback path", {
        orgId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
