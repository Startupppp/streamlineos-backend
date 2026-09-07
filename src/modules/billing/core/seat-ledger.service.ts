import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { billingSeatEvents } from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { readCount } from "./quota-counts";
import { SEAT_EVENT_DELTAS, SEAT_EVENT_TYPES, lockMembersQuota, seatCount, type SeatEventType } from "./seat-definition";
import { assertOneOf } from "./lib/enum-guard";

export interface SeatEventInput {
  orgId: string;
  eventType: SeatEventType;
  subjectId: string;
  actorId?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
  effectiveAt?: Date;
  metadata?: Record<string, unknown> | null;
}

export interface SeatEventRecord {
  id: number;
  eventType: SeatEventType;
  subjectId: string;
  quantityDelta: number;
  billedQuantityAfter: number;
  effectiveAt: Date;
  replayed: boolean;
}

export interface SeatEventTypeBreakdown {
  eventType: string;
  events: number;
  quantityDelta: number;
}

export interface SeatReconciliation {
  orgId: string;
  liveQuantity: number;
  ledgerQuantity: number;
  latestBilledQuantityAfter: number | null;
  drift: number;
  eventCount: number;
  lastEventAt: Date | null;
  byEventType: SeatEventTypeBreakdown[];
}

@Injectable()
export class SeatLedgerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Lock, count and insert are one transaction, so `billedQuantityAfter` is what the quota gate saw at that instant. */
  async recordSeatEvent(input: SeatEventInput, executor?: DbOrTx): Promise<SeatEventRecord> {
    if (executor) return this.write(executor, input);
    return runInTenantTransaction(this.db, (tx) => this.write(tx, input), { orgId: input.orgId });
  }

  private async write(tx: DbOrTx, input: SeatEventInput): Promise<SeatEventRecord> {
    const { orgId, eventType, subjectId } = input;
    const idempotencyKey = input.idempotencyKey ?? null;

    await tx.execute(lockMembersQuota(orgId));

    if (idempotencyKey !== null) {
      const replay = await this.findByIdempotencyKey(tx, orgId, idempotencyKey);
      if (replay) return replay;
    }

    const countRows = await tx.execute(sql`SELECT ${seatCount(orgId)} AS count`);
    const billedQuantityAfter = readCount(countRows, "count");
    const effectiveAt = input.effectiveAt ?? new Date();

    const [inserted] = await tx
      .insert(billingSeatEvents)
      .values({
        orgId,
        eventType,
        subjectId,
        actorId: input.actorId ?? null,
        reason: input.reason ?? null,
        idempotencyKey,
        effectiveAt,
        quantityDelta: SEAT_EVENT_DELTAS[eventType],
        billedQuantityAfter,
        metadata: input.metadata ?? null,
      })
      .onConflictDoNothing({
        target: [billingSeatEvents.orgId, billingSeatEvents.idempotencyKey],
        where: sql`idempotency_key IS NOT NULL`,
      })
      .returning({ id: billingSeatEvents.id });

    if (!inserted) {
      const replay = idempotencyKey === null ? null : await this.findByIdempotencyKey(tx, orgId, idempotencyKey);
      if (!replay) throw new Error(`Seat event for org ${orgId} was neither inserted nor replayable`);
      return replay;
    }

    return {
      id: inserted.id,
      eventType,
      subjectId,
      quantityDelta: SEAT_EVENT_DELTAS[eventType],
      billedQuantityAfter,
      effectiveAt,
      replayed: false,
    };
  }

  private async findByIdempotencyKey(
    tx: DbOrTx,
    orgId: string,
    idempotencyKey: string,
  ): Promise<SeatEventRecord | null> {
    const [existing] = await tx
      .select({
        id: billingSeatEvents.id,
        eventType: billingSeatEvents.eventType,
        subjectId: billingSeatEvents.subjectId,
        quantityDelta: billingSeatEvents.quantityDelta,
        billedQuantityAfter: billingSeatEvents.billedQuantityAfter,
        effectiveAt: billingSeatEvents.effectiveAt,
      })
      .from(billingSeatEvents)
      .where(
        and(
          eq(billingSeatEvents.orgId, orgId),
          eq(billingSeatEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) return null;
    return {
      ...existing,
      eventType: assertOneOf(SEAT_EVENT_TYPES, existing.eventType, "billing_seat_events.event_type"),
      replayed: true,
    };
  }

  async reconcileBilledQuantity(orgId: string): Promise<SeatReconciliation> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const countRows = await tx.execute(sql`SELECT ${seatCount(orgId)} AS count`);
        const liveQuantity = readCount(countRows, "count");

        const [totals] = await tx
          .select({
            ledgerQuantity: sql<number>`COALESCE(SUM(${billingSeatEvents.quantityDelta}), 0)::int`,
            eventCount: sql<number>`COUNT(*)::int`,
            lastEventAt: sql<Date | null>`MAX(${billingSeatEvents.effectiveAt})`,
          })
          .from(billingSeatEvents)
          .where(eq(billingSeatEvents.orgId, orgId));

        const [latest] = await tx
          .select({ billedQuantityAfter: billingSeatEvents.billedQuantityAfter })
          .from(billingSeatEvents)
          .where(eq(billingSeatEvents.orgId, orgId))
          .orderBy(desc(billingSeatEvents.effectiveAt), desc(billingSeatEvents.id))
          .limit(1);

        const byEventType = await tx
          .select({
            eventType: billingSeatEvents.eventType,
            events: sql<number>`COUNT(*)::int`,
            quantityDelta: sql<number>`COALESCE(SUM(${billingSeatEvents.quantityDelta}), 0)::int`,
          })
          .from(billingSeatEvents)
          .where(eq(billingSeatEvents.orgId, orgId))
          .groupBy(billingSeatEvents.eventType)
          .orderBy(billingSeatEvents.eventType);

        const ledgerQuantity = Number(totals?.ledgerQuantity ?? 0);

        return {
          orgId,
          liveQuantity,
          ledgerQuantity,
          latestBilledQuantityAfter: latest ? Number(latest.billedQuantityAfter) : null,
          drift: liveQuantity - ledgerQuantity,
          eventCount: Number(totals?.eventCount ?? 0),
          lastEventAt: totals?.lastEventAt ?? null,
          byEventType: byEventType.map((row) => ({
            eventType: row.eventType,
            events: Number(row.events),
            quantityDelta: Number(row.quantityDelta),
          })),
        };
      },
      { orgId },
    );
  }

  async listSeatEvents(orgId: string, limit = 100): Promise<SeatEventRecord[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx
          .select({
            id: billingSeatEvents.id,
            eventType: billingSeatEvents.eventType,
            subjectId: billingSeatEvents.subjectId,
            quantityDelta: billingSeatEvents.quantityDelta,
            billedQuantityAfter: billingSeatEvents.billedQuantityAfter,
            effectiveAt: billingSeatEvents.effectiveAt,
          })
          .from(billingSeatEvents)
          .where(eq(billingSeatEvents.orgId, orgId))
          .orderBy(desc(billingSeatEvents.effectiveAt), desc(billingSeatEvents.id))
          .limit(capped);

        return rows.map((row) => ({
          ...row,
          eventType: assertOneOf(SEAT_EVENT_TYPES, row.eventType, "billing_seat_events.event_type"),
          replayed: false,
        }));
      },
      { orgId },
    );
  }
}
