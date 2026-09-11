import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { calendarProviderSyncQueue } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { assertReadable, resolveCallerMembershipId } from "./calendar-sync-visibility";
import type {
  SyncCancelResponse,
  SyncRetryResponse,
  SyncStatusResponse,
} from "./dto/sync-status.schemas";

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

  /**
   * The newest job for this event, among `states`, that a later success has NOT made
   * irrelevant.
   *
   * One `event_id` names SEVERAL provider targets: the series itself, and one per edited
   * occurrence (`CalendarRecurrenceService.enqueueOccurrenceSync` stamps the parent's id
   * on an occurrence row). Reading only the newest row therefore buried a refused — or
   * merely still-queued — occurrence write under any later series write that succeeded:
   * the endpoint answered `synced`, `retryable` was false, and the provider kept the
   * un-moved occurrence for ever with nothing anywhere reporting the two copies had
   * parted. That is the divergence PRD-C129 forbids, reached through the read side.
   *
   * A job is resolved only by a later PROCESSED row that wrote THE SAME provider object —
   * the same `occurrenceStart`, or none on both sides for a series write — or by a later
   * PROCESSED whole-series delete, after which there is no provider copy left to diverge
   * from. A later success on a DIFFERENT target says nothing about this one.
   */
  private async findUnresolved(
    orgId: string,
    eventId: number,
    states: readonly ["PENDING" | "IN_FLIGHT" | "FAILED", ...("PENDING" | "IN_FLIGHT" | "FAILED")[]],
  ): Promise<{
    state: "PENDING" | "IN_FLIGHT" | "PROCESSED" | "FAILED";
    attemptCount: number;
    lastError: string | null;
    operation: "create" | "update" | "delete";
    createdAt: Date;
    processedAt: Date | null;
  } | null> {
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
          inArray(calendarProviderSyncQueue.state, [...states]),
          sql`not exists (
            select 1
            from ${calendarProviderSyncQueue} later_sync
            where later_sync.org_id = ${orgId}
              and later_sync.event_id = ${eventId}
              and later_sync.id > ${calendarProviderSyncQueue.id}
              and later_sync.state = 'PROCESSED'
              and (
                coalesce(later_sync.payload ->> 'occurrenceStart', '')
                  = coalesce(${calendarProviderSyncQueue.payload} ->> 'occurrenceStart', '')
                or (
                  later_sync.operation = 'delete'
                  and later_sync.payload ->> 'occurrenceStart' is null
                )
              )
          )`,
        ),
      )
      .orderBy(desc(calendarProviderSyncQueue.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getSyncStatus(
    orgId: string,
    userId: string,
    eventId: number,
  ): Promise<SyncStatusResponse> {
    const callerMembershipId = await resolveCallerMembershipId(this.db, orgId, userId);
    await assertReadable(this.db, orgId, eventId, userId, callerMembershipId);

    // A live failure outranks a live queued job, which outranks the newest row: the
    // headline has to describe the WORST outstanding target, never the luckiest one.
    const outstanding =
      (await this.findUnresolved(orgId, eventId, ["FAILED"])) ??
      (await this.findUnresolved(orgId, eventId, ["PENDING", "IN_FLIGHT"]));
    if (outstanding) {
      const status = mapState(outstanding.state);
      return {
        status,
        attemptCount: outstanding.attemptCount,
        lastError: outstanding.lastError,
        operation: outstanding.operation,
        queuedAt: outstanding.createdAt.toISOString(),
        processedAt: outstanding.processedAt ? outstanding.processedAt.toISOString() : null,
        retryable: status === "failed",
      };
    }

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
    const callerMembershipId = await resolveCallerMembershipId(this.db, orgId, userId);
    const access = await assertReadable(this.db, orgId, eventId, userId, callerMembershipId);
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

  /**
   * Withdraws provider-sync jobs for this event that have NOT been dispatched.
   *
   * The queue had a retry path and no cancellation path at all, so an intent committed
   * beside the event could only ever be pushed or exhausted — a person who queued a sync
   * to the wrong connection, or changed their mind before the next tick, had no way to
   * stop it and no way to say so.
   *
   * `state = 'PENDING'` is the whole of what may be withdrawn, and the exclusions are the
   * point: an IN_FLIGHT row is being pushed right now, so removing it would destroy the
   * only record of a write that may already have reached the provider; a PROCESSED row
   * has been pushed; a FAILED row is terminal and carries the reason `getSyncStatus`
   * reports — deleting it would erase a divergence the user is entitled to see, and
   * `retrySync` is the deliberate way out of that state.
   *
   * A withdrawn row is DELETED rather than flagged. It is an undispatched work item —
   * backend CLAUDE.md §3's "unsent draft" exception to soft delete — and leaving a
   * tombstone behind would make `getSyncStatus`, which reads the newest row for the
   * event, answer about a job nobody is going to run.
   *
   * The race with the sweep is resolved by Postgres, in both directions: the claim query
   * takes `for update skip locked`, so a row this delete has locked is skipped rather
   * than claimed, and a delete arriving after a claim commits re-evaluates its predicate
   * under READ COMMITTED and no longer matches `state = 'PENDING'`.
   */
  async cancelSync(
    orgId: string,
    userId: string,
    eventId: number,
  ): Promise<SyncCancelResponse> {
    const callerMembershipId = await resolveCallerMembershipId(this.db, orgId, userId);
    const access = await assertReadable(this.db, orgId, eventId, userId, callerMembershipId);
    // Same bar as retrySync: seeing an event is not standing to change what it pushes.
    if (
      access.createdByMembershipId !== null &&
      access.createdByMembershipId !== callerMembershipId
    )
      throw new NotFoundException("Event not found");

    const removed = await this.db
      .delete(calendarProviderSyncQueue)
      .where(
        and(
          eq(calendarProviderSyncQueue.orgId, orgId),
          eq(calendarProviderSyncQueue.eventId, eventId),
          eq(calendarProviderSyncQueue.state, "PENDING"),
        ),
      )
      .returning({ id: calendarProviderSyncQueue.id });

    return { cancelled: removed.length };
  }
}
