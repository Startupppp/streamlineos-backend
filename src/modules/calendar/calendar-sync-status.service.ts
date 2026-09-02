import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { aliasedTable, and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  calendarEvents,
  calendarProviderSyncQueue,
  eventAttendees,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { SyncStatusResponse, SyncRetryResponse } from "./dto/sync-status.schemas";

const attendeeVisibility = aliasedTable(eventAttendees, "att_sync_visibility");

function mapState(
  state: "PENDING" | "IN_FLIGHT" | "PROCESSED" | "FAILED",
): SyncStatusResponse["status"] {
  if (state === "PROCESSED") return "synced";
  if (state === "PENDING") return "pending";
  if (state === "IN_FLIGHT") return "in_flight";
  return "failed";
}

@Injectable()
export class CalendarSyncStatusService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveCallerMembershipId(
    orgId: string,
    userId: string,
  ): Promise<number> {
    const row = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    return row?.id ?? 0;
  }

  private async findVisibleEvent(
    orgId: string,
    eventId: number,
    callerMembershipId: number,
  ): Promise<{ id: number; createdByMembershipId: number } | null> {
    const rows = await this.db
      .select({
        id: calendarEvents.id,
        createdByMembershipId: calendarEvents.createdByMembershipId,
      })
      .from(calendarEvents)
      .leftJoin(
        attendeeVisibility,
        and(
          eq(attendeeVisibility.orgId, calendarEvents.orgId),
          eq(attendeeVisibility.eventId, calendarEvents.id),
          eq(attendeeVisibility.membershipId, callerMembershipId),
        ),
      )
      .where(
        and(
          eq(calendarEvents.id, eventId),
          eq(calendarEvents.orgId, orgId),
          or(
            eq(calendarEvents.visibility, "org"),
            eq(calendarEvents.createdByMembershipId, callerMembershipId),
            isNotNull(attendeeVisibility.id),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A delete leaves a tombstone: the local row is gone but the queue row that must
   * remove the provider copy survives. Visibility can no longer be resolved from the
   * event, so it is resolved from the tombstone's own author — the person `deleteEvent`
   * already verified as the creator. Without this, a delete that exhausts its attempts
   * is invisible and unretryable, and the provider copy lives forever.
   */
  private async findDeleteTombstone(
    orgId: string,
    eventId: number,
    userId: string,
  ): Promise<{ id: number } | null> {
    const rows = await this.db
      .select({ id: calendarProviderSyncQueue.id })
      .from(calendarProviderSyncQueue)
      .where(
        and(
          eq(calendarProviderSyncQueue.orgId, orgId),
          eq(calendarProviderSyncQueue.eventId, eventId),
          eq(calendarProviderSyncQueue.operation, "delete"),
          sql`${calendarProviderSyncQueue.payload} ->> 'userId' = ${userId}`,
        ),
      )
      .orderBy(desc(calendarProviderSyncQueue.id))
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertReadable(
    orgId: string,
    eventId: number,
    userId: string,
    callerMembershipId: number,
  ): Promise<{ createdByMembershipId: number | null }> {
    const visible = await this.findVisibleEvent(orgId, eventId, callerMembershipId);
    if (visible) return { createdByMembershipId: visible.createdByMembershipId };

    const tombstone = await this.findDeleteTombstone(orgId, eventId, userId);
    if (!tombstone) throw new NotFoundException("Event not found");
    return { createdByMembershipId: null };
  }

  async getSyncStatus(
    orgId: string,
    userId: string,
    eventId: number,
  ): Promise<SyncStatusResponse> {
    const callerMembershipId = await this.resolveCallerMembershipId(orgId, userId);
    await this.assertReadable(orgId, eventId, userId, callerMembershipId);

    const rows = await this.db
      .select({
        state: calendarProviderSyncQueue.state,
        attemptCount: calendarProviderSyncQueue.attemptCount,
        lastError: calendarProviderSyncQueue.lastError,
        operation: calendarProviderSyncQueue.operation,
        createdAt: calendarProviderSyncQueue.createdAt,
        processedAt: calendarProviderSyncQueue.processedAt,
      })
      .from(calendarProviderSyncQueue)
      .where(
        and(
          eq(calendarProviderSyncQueue.orgId, orgId),
          eq(calendarProviderSyncQueue.eventId, eventId),
        ),
      )
      .orderBy(desc(calendarProviderSyncQueue.id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return {
        status: "not_synced",
        attemptCount: 0,
        lastError: null,
        operation: null,
        queuedAt: null,
        processedAt: null,
        retryable: false,
      };
    }

    const status = mapState(row.state);
    return {
      status,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
      operation: row.operation,
      queuedAt: row.createdAt.toISOString(),
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      retryable: status === "failed",
    };
  }

  async retrySync(
    orgId: string,
    userId: string,
    eventId: number,
  ): Promise<SyncRetryResponse> {
    const callerMembershipId = await this.resolveCallerMembershipId(orgId, userId);
    const access = await this.assertReadable(orgId, eventId, userId, callerMembershipId);
    if (
      access.createdByMembershipId !== null &&
      access.createdByMembershipId !== callerMembershipId
    )
      throw new NotFoundException("Event not found");

    const updated = await this.db
      .update(calendarProviderSyncQueue)
      .set({
        state: "PENDING",
        attemptCount: 0,
        lastError: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(calendarProviderSyncQueue.orgId, orgId),
          eq(calendarProviderSyncQueue.eventId, eventId),
          eq(calendarProviderSyncQueue.state, "FAILED"),
        ),
      )
      .returning({ id: calendarProviderSyncQueue.id });

    return { requeued: updated.length };
  }
}
