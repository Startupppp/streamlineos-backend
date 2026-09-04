import { Inject, Injectable } from "@nestjs/common";
import { and, eq, like, sql } from "drizzle-orm";
import {
  calendarEvents,
  calendarEventExceptions,
  calendarProviderSyncQueue,
  notificationOutbox,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import type { UpsertOccurrenceExceptionInput } from "./dto/occurrence-exception.schemas";

interface SeriesSyncTarget {
  integrationConnectionId: number | null;
  externalEventId: string | null;
  localVersion: number;
}

@Injectable()
export class CalendarRecurrenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async getRecurringEventForOwner(orgId: string, userId: string, eventId: number) {
    const memberRow = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    if (!memberRow) return null;
    const rows = await this.db
      .select({ createdByMembershipId: calendarEvents.createdByMembershipId, rrule: calendarEvents.rrule })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId)))
      .limit(1);
    const ev = rows[0];
    if (!ev || ev.createdByMembershipId !== memberRow.id || !ev.rrule) return null;
    return ev;
  }

  /**
   * Maps whatever instant the caller named onto the exception's real key.
   *
   * `calendar_event_exceptions` is keyed on the NOMINAL instant — the one the RRULE
   * generates — because that is the only handle `expandRecurring` can look an exception
   * up by (`exceptionMap.get(utcStart.getTime())`). But the only instant a client can
   * name for an occurrence that has already been moved is the one it currently sits at:
   * the projection carries `start`, and the frontend sends exactly that back.
   *
   * So a second edit of a moved occurrence used to arrive keyed on the MODIFIED start,
   * miss the existing row's conflict target, insert a second exception keyed on an
   * instant the RRULE never generates, and vanish — invisible to `expandRecurring` (not
   * an RRULE instant) and skipped by `collectRescheduledOccurrences` (its key is inside
   * the window). "Occurrence updated", and nothing moved.
   *
   * Precedence is exact-key first: if a row is already keyed on the instant supplied,
   * that instant IS nominal and the caller means that occurrence — even when some other
   * occurrence happens to have been moved onto the same time.
   */
  private async resolveOccurrenceKey(
    tx: TenantTx,
    orgId: string,
    eventId: number,
    supplied: Date,
  ): Promise<Date> {
    const exact = await tx
      .select({ occurrenceStart: calendarEventExceptions.occurrenceStart })
      .from(calendarEventExceptions)
      .where(
        and(
          eq(calendarEventExceptions.orgId, orgId),
          eq(calendarEventExceptions.eventId, eventId),
          eq(calendarEventExceptions.occurrenceStart, supplied),
        ),
      )
      .limit(1);
    if (exact.length > 0) return supplied;

    const moved = await tx
      .select({ occurrenceStart: calendarEventExceptions.occurrenceStart })
      .from(calendarEventExceptions)
      .where(
        and(
          eq(calendarEventExceptions.orgId, orgId),
          eq(calendarEventExceptions.eventId, eventId),
          eq(calendarEventExceptions.modifiedStart, supplied),
        ),
      )
      .limit(1);
    return moved[0]?.occurrenceStart ?? supplied;
  }

  /**
   * Records the series itself as locally changed.
   *
   * `CalendarProviderWebhookService.handleScoped` discards a provider notification whose
   * timestamp is not newer than `calendar_events.updated_at`, which is how "local wins"
   * is decided. An occurrence edit that left the parent untouched was invisible to that
   * comparison, so a provider notification issued between the parent's last edit and the
   * occurrence edit read as provider-newer. `updateEvent` bumps both columns together on
   * every local change; an occurrence edit is a local change to the same series.
   */
  private async bumpSeries(
    tx: TenantTx,
    orgId: string,
    eventId: number,
  ): Promise<SeriesSyncTarget | null> {
    const rows = await tx
      .update(calendarEvents)
      .set({
        localVersion: sql`${calendarEvents.localVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, eventId)))
      .returning({
        integrationConnectionId: calendarEvents.integrationConnectionId,
        externalEventId: calendarEvents.externalEventId,
        localVersion: calendarEvents.localVersion,
      });
    return rows[0] ?? null;
  }

  /**
   * Writes the provider-sync intent for ONE occurrence, in the same transaction as the
   * exception row it describes.
   *
   * `calendar-recurrence.service.ts` was absent from every `insert(calendarProviderSyncQueue)`
   * site, so a per-occurrence move or cancel changed the local calendar and enqueued nothing:
   * the provider copy kept the original occurrence for ever, and `getSyncStatus` reported the
   * SERIES' last row, so nothing anywhere said the two had diverged.
   *
   * `occurrenceStart` in the payload is the nominal instant, which is what makes this an
   * instance write at the provider instead of a whole-series overwrite. The row is stamped
   * with the version `bumpSeries` just produced so it takes its place in the same monotonic
   * chain as the create/update/delete rows.
   */
  private async enqueueOccurrenceSync(
    tx: TenantTx,
    orgId: string,
    eventId: number,
    userId: string,
    occurrenceStart: Date,
    operation: "update" | "delete",
    series: SeriesSyncTarget | null,
  ): Promise<void> {
    if (!series?.integrationConnectionId || !series.externalEventId) return;
    await tx.insert(calendarProviderSyncQueue).values({
      orgId,
      eventId,
      connectionId: series.integrationConnectionId,
      operation,
      externalEventId: series.externalEventId,
      eventLocalVersion: series.localVersion,
      payload: { userId, occurrenceStart: occurrenceStart.toISOString() },
    });
  }

  async upsertOccurrenceException(
    orgId: string,
    userId: string,
    eventId: number,
    occurrenceStartIso: string,
    input: UpsertOccurrenceExceptionInput,
  ) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const supplied = new Date(occurrenceStartIso);
    const [row] = await this.db.transaction(async (tx) => {
      const occurrenceStart = await this.resolveOccurrenceKey(tx, orgId, eventId, supplied);
      const rows = await tx
        .insert(calendarEventExceptions)
        .values({
          orgId,
          eventId,
          occurrenceStart,
          isCancelled: false,
          modifiedTitle: input.modifiedTitle ?? null,
          modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
          modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
        })
        .onConflictDoUpdate({
          target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
          set: {
            isCancelled: false,
            modifiedTitle: input.modifiedTitle ?? null,
            modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
            modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
            updatedAt: new Date(),
          },
        })
        .returning();
      const series = await this.bumpSeries(tx, orgId, eventId);
      await this.enqueueOccurrenceSync(tx, orgId, eventId, userId, occurrenceStart, "update", series);
      if (input.modifiedStart)
        // The reminders being dead-lettered are the ones scheduled against the key that
        // was actually written, not the instant the caller happened to name.
        await tx
          .update(notificationOutbox)
          .set({ state: "DEAD" })
          .where(
            and(
              eq(notificationOutbox.orgId, orgId),
              eq(notificationOutbox.state, "PENDING"),
              like(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:${occurrenceStart.toISOString()}%`),
            ),
          );
      return rows;
    });
    return row;
  }

  async cancelOccurrence(orgId: string, userId: string, eventId: number, occurrenceStartIso: string) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const supplied = new Date(occurrenceStartIso);
    const [row] = await this.db.transaction(async (tx) => {
      const occurrenceStart = await this.resolveOccurrenceKey(tx, orgId, eventId, supplied);
      const rows = await tx
        .insert(calendarEventExceptions)
        .values({ orgId, eventId, occurrenceStart, isCancelled: true })
        .onConflictDoUpdate({
          target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
          set: { isCancelled: true, updatedAt: new Date() },
        })
        .returning();
      const series = await this.bumpSeries(tx, orgId, eventId);
      await this.enqueueOccurrenceSync(tx, orgId, eventId, userId, occurrenceStart, "delete", series);
      await tx
        .update(notificationOutbox)
        .set({ state: "DEAD" })
        .where(
          and(
            eq(notificationOutbox.orgId, orgId),
            eq(notificationOutbox.state, "PENDING"),
            like(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:${occurrenceStart.toISOString()}%`),
          ),
        );
      return rows;
    });
    return row;
  }
}
