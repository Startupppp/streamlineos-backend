import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { calendarEvents, calendarProviderSyncQueue, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

export type WebhookAction = "discarded" | "requeued" | "not_found";
export interface WebhookHandleResult {
  action: WebhookAction;
}

@Injectable()
export class CalendarProviderWebhookService {
  private readonly logger = new Logger(CalendarProviderWebhookService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async handleProviderWebhook(
    orgId: string,
    externalEventId: string,
    providerUpdatedAtIso: string,
  ): Promise<WebhookHandleResult> {
    const providerUpdatedAt = new Date(providerUpdatedAtIso);

    const eventRows = await runInNewTenantTransaction(this.db, orgId, async (tx) =>
      tx
        .select({
          id: calendarEvents.id,
          updatedAt: calendarEvents.updatedAt,
          localVersion: calendarEvents.localVersion,
          integrationConnectionId: calendarEvents.integrationConnectionId,
          externalEventId: calendarEvents.externalEventId,
          createdByMembershipId: calendarEvents.createdByMembershipId,
        })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.externalEventId, externalEventId),
          ),
        )
        .limit(1),
    );

    const event = eventRows[0];
    if (!event) return { action: "not_found" };

    if (event.updatedAt >= providerUpdatedAt) return { action: "discarded" };

    const pendingSyncRows = await runInNewTenantTransaction(this.db, orgId, async (tx) =>
      tx
        .select({ id: calendarProviderSyncQueue.id })
        .from(calendarProviderSyncQueue)
        .where(
          and(
            eq(calendarProviderSyncQueue.orgId, orgId),
            eq(calendarProviderSyncQueue.eventId, event.id),
            inArray(calendarProviderSyncQueue.state, ["PENDING", "IN_FLIGHT"]),
          ),
        )
        .limit(1),
    );

    if (pendingSyncRows.length > 0) return { action: "discarded" };

    if (!event.integrationConnectionId) {
      this.logger.warn(
        `Provider drift detected for externalEventId=${externalEventId} (org=${orgId}) but no connection id — cannot re-queue.`,
      );
      return { action: "discarded" };
    }

    const memberRow = await runInNewTenantTransaction(this.db, orgId, async (tx) =>
      tx.query.organizationMembers.findFirst({
        columns: { userId: true },
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.id, event.createdByMembershipId),
        ),
      }),
    );

    if (!memberRow) {
      this.logger.warn(
        `Provider drift detected for externalEventId=${externalEventId} (org=${orgId}) but creator membership not found — cannot re-queue.`,
      );
      return { action: "discarded" };
    }

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx.insert(calendarProviderSyncQueue).values({
        orgId,
        eventId: event.id,
        connectionId: event.integrationConnectionId!,
        operation: "update",
        externalEventId: event.externalEventId,
        eventLocalVersion: event.localVersion,
        payload: { userId: memberRow.userId },
      });
    });

    this.logger.warn(
      `Provider drift: externalEventId=${externalEventId} (org=${orgId}) provider updated at ${providerUpdatedAtIso}, ` +
        `local at ${event.updatedAt.toISOString()}. Re-queued local UPDATE to restore authoritative state.`,
    );

    return { action: "requeued" };
  }
}
