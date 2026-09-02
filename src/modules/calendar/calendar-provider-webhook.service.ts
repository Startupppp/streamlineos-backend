import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  calendarEvents,
  calendarProviderSyncQueue,
  organizationMembers,
  userIntegrationConnections,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

export type WebhookAction = "discarded" | "requeued" | "not_found" | "unknown_connection";
export interface WebhookHandleResult {
  action: WebhookAction;
}

export interface ProviderWebhookDelivery {
  connectionId: number;
  externalEventId: string;
  providerUpdatedAtIso: string;
}

interface ScopedWebhookInput {
  orgId: string;
  connectionId: number | null;
  externalEventId: string;
  providerUpdatedAtIso: string;
}

const CALENDAR_TOOLKITS = ["googlecalendar", "outlook"] as const;

@Injectable()
export class CalendarProviderWebhookService {
  private readonly logger = new Logger(CalendarProviderWebhookService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The only tenant selector a provider delivery carries is the connection it was
   * registered against; the org is resolved from that row and never read from the
   * request, so a caller cannot name someone else's tenant.
   */
  async handleDelivery(delivery: ProviderWebhookDelivery): Promise<WebhookHandleResult> {
    const [connection] = await this.db
      .select({ id: userIntegrationConnections.id, orgId: userIntegrationConnections.orgId })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, delivery.connectionId),
          eq(userIntegrationConnections.status, "active"),
          inArray(userIntegrationConnections.toolkit, [...CALENDAR_TOOLKITS]),
        ),
      )
      .limit(1);

    if (!connection) {
      this.logger.warn(
        `Provider webhook for unknown or inactive calendar connection id=${delivery.connectionId} — dropped.`,
      );
      return { action: "unknown_connection" };
    }

    return this.handleScoped({
      orgId: connection.orgId,
      connectionId: connection.id,
      externalEventId: delivery.externalEventId,
      providerUpdatedAtIso: delivery.providerUpdatedAtIso,
    });
  }

  async handleProviderWebhook(
    orgId: string,
    externalEventId: string,
    providerUpdatedAtIso: string,
  ): Promise<WebhookHandleResult> {
    return this.handleScoped({
      orgId,
      connectionId: null,
      externalEventId,
      providerUpdatedAtIso,
    });
  }

  private async handleScoped(input: ScopedWebhookInput): Promise<WebhookHandleResult> {
    const { orgId, connectionId, externalEventId, providerUpdatedAtIso } = input;
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
            connectionId === null
              ? undefined
              : eq(calendarEvents.integrationConnectionId, connectionId),
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

    const eventConnectionId = event.integrationConnectionId;
    if (eventConnectionId === null) {
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
        connectionId: eventConnectionId,
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
