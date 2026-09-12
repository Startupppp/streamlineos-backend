import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  calendarEventExceptions,
  calendarEvents,
  calendarProviderSyncQueue,
  userIntegrationConnections,
} from "../../db/schema";
import { forEachOrg } from "../../common/tenant";
import type { ForEachOrgResult } from "../../common/tenant/for-each-org";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  ExternalCalendarSyncService,
  type PushConnection,
  type PushEventInput,
  type PushOccurrenceTarget,
} from "./external-calendar-sync.service";
import { ProviderCapabilityError } from "./external-event-normalizers";
import { connectionOwnerPredicate } from "../integrations/core/connection-owner.predicate";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import { providerSyncPayloadSchema } from "./dto/provider-sync.schemas";

/**
 * Per ORGANISATION, not per tick. A single global budget consumed inside `forEachOrg` —
 * which enumerates tenants in `order by organizations.id` — let one busy tenant take the
 * whole allowance every tick and starve every tenant after it, permanently, because the
 * busy one refills between ticks. Pinned by `calendar-provider-sync-drain-reachability`.
 */
export const PER_ORG_CLAIM_LIMIT = 20;

/**
 * The ceiling on one whole tick. Each claimed row costs a provider round trip and the cron
 * lease is 120s, so a tick has to end; a large multiple of the per-org allowance bounds it
 * without reintroducing the starvation above.
 */
export const GLOBAL_CLAIM_LIMIT = 200;

const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS: readonly number[] = [0, 30_000, 120_000, 600_000, 1_800_000];

export interface CalendarProviderSyncSweepResult {
  organizations: ForEachOrgResult;
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
}

@Injectable()
export class CalendarProviderSyncSweepService {
  private readonly logger = new Logger(CalendarProviderSyncSweepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sync: ExternalCalendarSyncService,
  ) {}

  async run(now = new Date()): Promise<CalendarProviderSyncSweepResult> {
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed: Array<typeof calendarProviderSyncQueue.$inferSelect> = [];

    const organizations = await forEachOrg(this.db, "calendar-provider-sync-sweep", async (tx, orgId) => {
      const remaining = Math.min(PER_ORG_CLAIM_LIMIT, GLOBAL_CLAIM_LIMIT - claimed.length);
      if (remaining <= 0) return;
      const rows = await tx
        .update(calendarProviderSyncQueue)
        .set({ state: "IN_FLIGHT", leaseExpiresAt: leaseUntil })
        .where(
          sql`${calendarProviderSyncQueue.id} in (
            select id from ${calendarProviderSyncQueue}
            where org_id = ${orgId}
              and (
                (state = 'PENDING' and (lease_expires_at is null or lease_expires_at < ${now.toISOString()}::timestamptz))
                or (state = 'IN_FLIGHT' and lease_expires_at < ${now.toISOString()}::timestamptz)
              )
            order by id
            limit ${remaining}
            for update skip locked
          )`,
        )
        .returning();
      claimed.push(...rows);
    });

    let processed = 0;
    let retried = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        await this.processRow(row);
        await this.mark(row, { state: "PROCESSED", processedAt: now });
        processed += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = row.attemptCount + 1;
        const isAuthRevocation = err instanceof ComposioToolError && err.isAuthError;
        // A capability refusal cannot succeed on a later attempt, so it is dead on the
        // first one. A provider auth revocation (token expired, OAuth revoked) is also
        // permanent until the user reconnects — retrying it burns the backoff ladder for
        // no benefit, and the user never sees a prompt to reconnect. Both are dead immediately.
        const dead = err instanceof ProviderCapabilityError || isAuthRevocation || attempts >= MAX_ATTEMPTS;
        const backoffMs = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)] ?? 1_800_000;
        const nextAttemptAt = dead ? null : new Date(now.getTime() + backoffMs);
        this.logger.error(
          `calendar-provider-sync row ${row.id} (op=${row.operation}, org=${row.orgId}) failed attempt ${attempts}: ${message}`,
        );
        if (isAuthRevocation) {
          await this.markConnectionNeedsReauth(row.orgId, row.connectionId).catch((e: unknown) => {
            this.logger.error(
              `calendar-provider-sync row ${row.id}: failed to mark connection ${row.connectionId} needs_reauth: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        }
        await this.mark(row, {
          state: dead ? "FAILED" : "PENDING",
          attemptCount: attempts,
          lastError: message,
          leaseExpiresAt: nextAttemptAt,
        });
        if (dead) failed += 1;
        else retried += 1;
      }
    }

    return { organizations, claimed: claimed.length, processed, retried, failed };
  }

  private async processRow(row: typeof calendarProviderSyncQueue.$inferSelect): Promise<void> {
    const parsed = providerSyncPayloadSchema.safeParse(row.payload);
    if (!parsed.success)
      throw new Error(`sync-queue row ${row.id} malformed payload: ${parsed.error.message}`);
    const payload = parsed.data;
    const { userId } = payload;

    const conn = await this.resolveConnection(row.orgId, row.connectionId, userId);

    // Present only on an occurrence-scoped row, written by CalendarRecurrenceService.
    // It turns the push below into an instance write instead of a series write.
    const occurrenceStart = payload.occurrenceStart ? new Date(payload.occurrenceStart) : null;

    if (row.operation === "delete") {
      if (!row.externalEventId) return;
      const occurrenceTarget = occurrenceStart
        ? await this.resolveOccurrenceTarget(row.orgId, row.eventId, occurrenceStart)
        : undefined;
      // A cancelled occurrence whose exception row is gone again — the cancel was undone
      // locally — has nothing left to remove at the provider.
      if (occurrenceStart && !occurrenceTarget) return;
      const result = await this.sync.pushDelete(userId, conn, row.externalEventId, occurrenceTarget);
      // Never a warn-and-return: that fell through to the PROCESSED mark and reported
      // `synced` over a provider copy this delete never touched.
      if (!result.success) throw new ProviderCapabilityError(result.reason);
      return;
    }

    const eventId = row.eventId;
    if (!eventId) return;
    const eventRow = await runInNewTenantTransaction(this.db, row.orgId, (tx) =>
      tx.query.calendarEvents.findFirst({
        where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, row.orgId)),
        columns: {
          id: true, title: true, description: true, startDate: true, endDate: true,
          allDay: true, externalEventId: true, localVersion: true, rrule: true,
        },
      }),
    );
    if (!eventRow) return;

    const pushInput: PushEventInput = {
      title: payload.title ?? eventRow.title,
      description: payload.description ?? eventRow.description ?? null,
      startIso: payload.startIso ?? eventRow.startDate.toISOString(),
      endIso: payload.endIso ?? eventRow.endDate.toISOString(),
      allDay: payload.allDay ?? eventRow.allDay,
      attendeeEmails: payload.attendeeEmails ?? [],
      addConference: payload.addConference ?? false,
      rrule: payload.rrule ?? eventRow.rrule ?? null,
    };

    if (row.operation === "create") {
      if (eventRow.externalEventId) {
        this.logger.warn(
          `calendar-provider-sync create row ${row.id} re-claimed after the event was already ` +
            `created externally (${eventRow.externalEventId}); skipping the push to avoid a duplicate.`,
        );
        return;
      }
      const pushed = await this.sync.pushCreate(userId, conn, pushInput);
      const writtenBack = await runInNewTenantTransaction(this.db, row.orgId, (tx) =>
        tx
          .update(calendarEvents)
          .set({
            integrationConnectionId: conn.id,
            externalEventId: pushed.externalEventId,
            meetingUrl: pushed.meetingUrl ?? null,
          })
          .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, row.orgId)))
          .returning({ id: calendarEvents.id }),
      );

      // The push and the write-back cannot be one transaction, so the gap between them is
      // a whole provider round trip wide. A delete inside that gap leaves the provider
      // copy orphaned for ever: this update matches nothing and `deleteEvent` enqueued no
      // delete of its own, because the row it removed did not yet carry an external id.
      // The id the push returned is the only surviving handle on that copy. See
      // `calendar-provider-sync-tenant-context.spec.ts`.
      if (writtenBack.length === 0) {
        await runInNewTenantTransaction(this.db, row.orgId, async (tx) => {
          await tx.insert(calendarProviderSyncQueue).values({
            orgId: row.orgId,
            eventId: null,
            connectionId: conn.id,
            operation: "delete",
            externalEventId: pushed.externalEventId,
            payload: { userId },
          });
        });
        this.logger.warn(
          `calendar-provider-sync row ${row.id}: event ${eventId} (org=${row.orgId}) was gone by the ` +
            `time ${pushed.externalEventId} came back from ${conn.toolkit}; queued a compensating delete.`,
        );
      }
      return;
    }

    if (row.operation === "update") {
      if (
        row.eventId !== null &&
        row.eventLocalVersion !== null &&
        eventRow.localVersion > row.eventLocalVersion &&
        await this.hasNewerPendingUpdateFor(row.orgId, row.eventId, row.id, payload.occurrenceStart ?? null)
      ) return;
      const extId = row.externalEventId ?? eventRow.externalEventId;
      if (!extId) return;

      if (occurrenceStart) {
        const exception = await this.loadException(row.orgId, eventId, occurrenceStart);
        // The exception was removed after the row was enqueued: the occurrence is back on
        // the series' own schedule, so there is nothing occurrence-shaped left to push.
        if (!exception) return;
        if (exception.isCancelled) return;
        const duration = eventRow.endDate.getTime() - eventRow.startDate.getTime();
        const effectiveStart = exception.modifiedStart ?? occurrenceStart;
        const effectiveEnd =
          exception.modifiedEnd ?? new Date(effectiveStart.getTime() + duration);
        const target: PushOccurrenceTarget = { nominalStart: occurrenceStart, allDay: eventRow.allDay };
        const instanceResult = await this.sync.pushUpdate(
          userId,
          conn,
          extId,
          {
            title: exception.modifiedTitle ?? eventRow.title,
            description: eventRow.description ?? null,
            startIso: effectiveStart.toISOString(),
            endIso: effectiveEnd.toISOString(),
            rrule: null,
          },
          target,
        );
        if (!instanceResult.success) throw new ProviderCapabilityError(instanceResult.reason);
        return;
      }

      const result = await this.sync.pushUpdate(userId, conn, extId, {
        title: eventRow.title,
        description: eventRow.description ?? null,
        startIso: eventRow.startDate.toISOString(),
        endIso: eventRow.endDate.toISOString(),
        rrule: pushInput.rrule,
      });
      // Same reason as the delete arm: a refusal that only logs is reported as `synced`.
      if (!result.success) throw new ProviderCapabilityError(result.reason);
    }
  }

  /**
   * Reads the exception row an occurrence-scoped job describes, in its own tenant
   * transaction (see `resolveConnection` for why the ambient GUC is absent here).
   */
  private async loadException(orgId: string, eventId: number, occurrenceStart: Date) {
    const rows = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          isCancelled: calendarEventExceptions.isCancelled,
          modifiedTitle: calendarEventExceptions.modifiedTitle,
          modifiedStart: calendarEventExceptions.modifiedStart,
          modifiedEnd: calendarEventExceptions.modifiedEnd,
        })
        .from(calendarEventExceptions)
        .where(
          and(
            eq(calendarEventExceptions.orgId, orgId),
            eq(calendarEventExceptions.eventId, eventId),
            eq(calendarEventExceptions.occurrenceStart, occurrenceStart),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Confirms the occurrence a cancel job names still has a cancelled exception row, and
   * carries the `allDay` flag the provider's instance id is built from.
   */
  private async resolveOccurrenceTarget(
    orgId: string,
    eventId: number | null,
    occurrenceStart: Date,
  ): Promise<PushOccurrenceTarget | undefined> {
    if (eventId === null) return undefined;
    const rows = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({ allDay: calendarEvents.allDay })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId)))
        .limit(1),
    );
    const parent = rows[0];
    if (!parent) return undefined;
    return { nominalStart: occurrenceStart, allDay: parent.allDay };
  }

  /**
   * Resolves the connection a queue row names, inside the row's own tenant transaction.
   *
   * `forEachOrg` sets `app.organization_id` only for the duration of its own callback,
   * and that callback is used above purely to CLAIM rows. Everything from here on runs
   * in a `@Public()` cron request with no ambient tenant context, so a read issued on
   * `this.db` goes to the pool with no GUC — and `user_integration_connections` is behind
   * `org_id = app.current_org_id()`, which RAISES 42501 rather than returning nothing.
   * Measured on scratch_head_1010 as `streamline_app`; this was the first statement in
   * the processing loop, so every claimed row failed here and retried into FAILED.
   *
   * The predicate also carries the connection's OWNER, not just its org: the account —
   * never the `userId` argument beside it — selects the calendar the event lands in.
   * `createEvent` refuses a connection the caller does not own, so this is defence in
   * depth for rows written before that check existed. A queue row is only ever enqueued by
   * the event's creator, so the payload's userId and the connection's owner must agree.
   */
  private async resolveConnection(
    orgId: string,
    connectionId: number,
    actorUserId: string,
  ): Promise<PushConnection> {
    const rows = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          id: userIntegrationConnections.id,
          toolkit: userIntegrationConnections.toolkit,
          composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
        })
        .from(userIntegrationConnections)
        .where(
          and(
            eq(userIntegrationConnections.id, connectionId),
            eq(userIntegrationConnections.orgId, orgId),
            // The queue row carries the actor's user id, not a membership id, so this is
            // the predicate's user_id arm. It is the same shared rule createEvent uses.
            connectionOwnerPredicate(actorUserId, null),
            eq(userIntegrationConnections.status, "active"),
            inArray(userIntegrationConnections.toolkit, ["googlecalendar", "outlook"]),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row || (row.toolkit !== "googlecalendar" && row.toolkit !== "outlook"))
      throw new Error(`Calendar connection ${connectionId} not found, inactive, or not the actor's`);
    return { id: row.id, toolkit: row.toolkit, composioConnectedAccountId: row.composioConnectedAccountId };
  }

  /**
   * A later update supersedes this one only when it writes THE SAME provider object.
   *
   * Scoping this to the event alone was wrong once occurrence-scoped rows existed: a
   * series edit queued after an occurrence edit writes a different object at the provider,
   * so treating it as a supersession dropped the occurrence write and left that one
   * occurrence permanently stale. A series row is superseded only by a series row, and an
   * occurrence row only by a row naming the same occurrence.
   */
  private async hasNewerPendingUpdateFor(
    orgId: string,
    eventId: number,
    currentRowId: number,
    occurrenceStart: string | null,
  ): Promise<boolean> {
    // Same reason as resolveConnection: calendar_provider_sync_queue is RLS-protected and
    // this runs outside forEachOrg's callback, so it needs its own tenant transaction.
    const sameTarget = occurrenceStart
      ? sql`${calendarProviderSyncQueue.payload} ->> 'occurrenceStart' = ${occurrenceStart}`
      : sql`${calendarProviderSyncQueue.payload} ->> 'occurrenceStart' is null`;
    const rows = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({ id: calendarProviderSyncQueue.id })
        .from(calendarProviderSyncQueue)
        .where(
          and(
            eq(calendarProviderSyncQueue.orgId, orgId),
            eq(calendarProviderSyncQueue.eventId, eventId),
            eq(calendarProviderSyncQueue.operation, "update"),
            inArray(calendarProviderSyncQueue.state, ["PENDING", "IN_FLIGHT"]),
            gt(calendarProviderSyncQueue.id, currentRowId),
            sameTarget,
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  private async markConnectionNeedsReauth(orgId: string, connectionId: number): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .update(userIntegrationConnections)
        .set({ status: "needs_reauth" })
        .where(
          and(
            eq(userIntegrationConnections.id, connectionId),
            eq(userIntegrationConnections.orgId, orgId),
          ),
        );
    });
  }

  private mark(
    row: typeof calendarProviderSyncQueue.$inferSelect,
    patch: Partial<typeof calendarProviderSyncQueue.$inferInsert>,
  ): Promise<void> {
    return runInNewTenantTransaction(this.db, row.orgId, async (tx) => {
      await tx
        .update(calendarProviderSyncQueue)
        .set(patch)
        .where(
          and(
            eq(calendarProviderSyncQueue.id, row.id),
            eq(calendarProviderSyncQueue.orgId, row.orgId),
          ),
        );
    });
  }
}
