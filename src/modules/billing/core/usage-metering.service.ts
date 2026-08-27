import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import {
  billingUsageEvents,
  billingUsageReservations,
  billingUsageRollups,
} from "../../../db/schema";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { runInTenantTransaction, runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { readCount } from "./quota-counts";

export const RESERVATION_STATUSES = ["ACTIVE", "SETTLED", "RELEASED", "EXPIRED"] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const ROLLUP_GRANULARITIES = ["HOUR", "DAY"] as const;

export type RollupGranularity = (typeof ROLLUP_GRANULARITIES)[number];

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface UsageEventInput {
  orgId: string;
  meterKey: string;
  sourceKey: string;
  quantity: number;
  occurredAt?: Date;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ReservationInput {
  orgId: string;
  meterKey: string;
  idempotencyKey: string;
  quantity: number;
  limit: number | null;
  periodStart: Date;
  periodEnd: Date;
  subjectId?: string | null;
  ttlMs?: number;
}

export interface Reservation {
  id: number;
  meterKey: string;
  reservedQuantity: number;
  status: ReservationStatus;
  expiresAt: Date;
  replayed: boolean;
}

export interface MeterUsage {
  settledQuantity: number;
  reservedQuantity: number;
  committedQuantity: number;
  limit: number | null;
  remaining: number | null;
}

/** Serializes every reservation for one meter in one organisation, transaction-scoped. */
function lockMeter(orgId: string, meterKey: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${orgId}:${meterKey}`}, 0))`;
}

@Injectable()
export class UsageMeteringService {
  private readonly logger = new Logger(UsageMeteringService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** A repeated `sourceKey` is a no-op, not a second charge; a correction arrives as a new fact under a new key. */
  async ingestEvent(input: UsageEventInput, executor?: TenantTx): Promise<{ id: number | null; duplicate: boolean }> {
    if (!Number.isInteger(input.quantity))
      throw new BadRequestException("Usage quantity must be an integer");

    const write = async (tx: TenantTx) => {
      const [inserted] = await tx
        .insert(billingUsageEvents)
        .values({
          orgId: input.orgId,
          meterKey: input.meterKey,
          sourceKey: input.sourceKey,
          subjectId: input.subjectId ?? null,
          quantity: input.quantity,
          occurredAt: input.occurredAt ?? new Date(),
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({
          target: [billingUsageEvents.orgId, billingUsageEvents.meterKey, billingUsageEvents.sourceKey],
        })
        .returning({ id: billingUsageEvents.id });

      return inserted ? { id: inserted.id, duplicate: false } : { id: null, duplicate: true };
    };

    if (executor) return write(executor);
    return runInTenantTransaction(this.db, write, { orgId: input.orgId });
  }

  /** Lock, usage read and insert are one transaction, so two callers cannot both see room for the last unit. */
  async acquireReservation(input: ReservationInput): Promise<Reservation> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0)
      throw new BadRequestException("Reserved quantity must be a positive integer");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.execute(lockMeter(input.orgId, input.meterKey));

        const replay = await this.findReservation(tx, input.orgId, input.meterKey, input.idempotencyKey);
        if (replay) return { ...replay, replayed: true };

        const usage = await this.readUsage(tx, input);
        if (input.limit !== null && usage.committedQuantity + input.quantity > input.limit)
          throw new PaymentRequiredException({
            code: "QUOTA_EXCEEDED",
            message: `The ${input.meterKey} meter allows ${input.limit} and ${usage.committedQuantity} are already committed. Upgrade to add more.`,
            details: {
              limitKey: input.meterKey,
              used: usage.committedQuantity,
              limit: input.limit,
              upgradePath: "/settings/billing",
            },
          });

        const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS));
        const [inserted] = await tx
          .insert(billingUsageReservations)
          .values({
            orgId: input.orgId,
            meterKey: input.meterKey,
            subjectId: input.subjectId ?? null,
            reservedQuantity: input.quantity,
            idempotencyKey: input.idempotencyKey,
            status: "ACTIVE",
            expiresAt,
          })
          .returning({ id: billingUsageReservations.id });

        if (!inserted) throw new Error(`Usage reservation for org ${input.orgId} was not written`);

        return {
          id: inserted.id,
          meterKey: input.meterKey,
          reservedQuantity: input.quantity,
          status: "ACTIVE" as ReservationStatus,
          expiresAt,
          replayed: false,
        };
      },
      { orgId: input.orgId },
    );
  }

  /** The event carries the reservation's own source key, which makes a second settle a no-op. */
  async settleReservation(
    orgId: string,
    meterKey: string,
    idempotencyKey: string,
    settledQuantity?: number,
  ): Promise<{ settledQuantity: number; alreadySettled: boolean }> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.execute(lockMeter(orgId, meterKey));

        const reservation = await this.findReservation(tx, orgId, meterKey, idempotencyKey);
        if (!reservation) throw new NotFoundException("Usage reservation not found");
        if (reservation.status === "SETTLED")
          return { settledQuantity: reservation.reservedQuantity, alreadySettled: true };
        if (reservation.status !== "ACTIVE")
          throw new ConflictException(`Cannot settle a reservation in status ${reservation.status}`);

        const actual = settledQuantity ?? reservation.reservedQuantity;
        if (!Number.isInteger(actual) || actual < 0)
          throw new BadRequestException("Settled quantity must be a non-negative integer");
        if (actual > reservation.reservedQuantity)
          throw new ConflictException(
            `Cannot settle ${actual} against a reservation of ${reservation.reservedQuantity}; reserve again for the excess`,
          );

        await tx
          .update(billingUsageReservations)
          .set({ status: "SETTLED", settledAt: new Date(), settledQuantity: actual })
          .where(eq(billingUsageReservations.id, reservation.id));

        if (actual > 0)
          await this.ingestEvent(
            {
              orgId,
              meterKey,
              sourceKey: `reservation:${reservation.id}`,
              quantity: actual,
              metadata: { idempotencyKey },
            },
            tx,
          );

        return { settledQuantity: actual, alreadySettled: false };
      },
      { orgId },
    );
  }

  /** Gives the reserved quota back without recording usage — the action did not happen. */
  async releaseReservation(orgId: string, meterKey: string, idempotencyKey: string, reason: string): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.execute(lockMeter(orgId, meterKey));

        const reservation = await this.findReservation(tx, orgId, meterKey, idempotencyKey);
        if (!reservation) throw new NotFoundException("Usage reservation not found");
        if (reservation.status === "RELEASED" || reservation.status === "EXPIRED") return;
        if (reservation.status === "SETTLED")
          throw new ConflictException("Cannot release a settled reservation; issue a credit note instead");

        await tx
          .update(billingUsageReservations)
          .set({ status: "RELEASED", settledAt: new Date(), settledQuantity: 0 })
          .where(eq(billingUsageReservations.id, reservation.id));
        this.logger.log(`Released usage reservation ${reservation.id} (${meterKey}): ${reason}`);
      },
      { orgId },
    );
  }

  /** What the meter has committed against its limit right now, reservations included. */
  async readMeterUsage(input: Omit<ReservationInput, "idempotencyKey" | "quantity">): Promise<MeterUsage> {
    return runInTenantTransaction(this.db, (tx) => this.readUsage(tx, input), { orgId: input.orgId });
  }

  private async readUsage(
    tx: TenantTx,
    input: Pick<ReservationInput, "orgId" | "meterKey" | "limit" | "periodStart" | "periodEnd">,
  ): Promise<MeterUsage> {
    const rows = await tx.execute(sql`
      SELECT
        (SELECT COALESCE(SUM(quantity), 0)::bigint FROM billing_usage_events
          WHERE org_id = ${input.orgId} AND meter_key = ${input.meterKey}
            AND occurred_at >= ${input.periodStart} AND occurred_at < ${input.periodEnd})           AS settled,
        (SELECT COALESCE(SUM(reserved_quantity), 0)::bigint FROM billing_usage_reservations
          WHERE org_id = ${input.orgId} AND meter_key = ${input.meterKey}
            AND status = 'ACTIVE' AND expires_at > NOW())                                           AS reserved
    `);

    const settledQuantity = readCount(rows, "settled");
    const reservedQuantity = readCount(rows, "reserved");
    const committedQuantity = settledQuantity + reservedQuantity;

    return {
      settledQuantity,
      reservedQuantity,
      committedQuantity,
      limit: input.limit,
      remaining: input.limit === null ? null : input.limit - committedQuantity,
    };
  }

  private async findReservation(
    tx: TenantTx,
    orgId: string,
    meterKey: string,
    idempotencyKey: string,
  ): Promise<Omit<Reservation, "replayed"> | null> {
    const [existing] = await tx
      .select({
        id: billingUsageReservations.id,
        meterKey: billingUsageReservations.meterKey,
        reservedQuantity: billingUsageReservations.reservedQuantity,
        status: billingUsageReservations.status,
        expiresAt: billingUsageReservations.expiresAt,
      })
      .from(billingUsageReservations)
      .where(
        and(
          eq(billingUsageReservations.orgId, orgId),
          eq(billingUsageReservations.meterKey, meterKey),
          eq(billingUsageReservations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) return null;
    return { ...existing, status: existing.status as ReservationStatus };
  }

  /** A projection: rebuilding is idempotent and never touches the events, so raw detail can be pruned later. */
  async rebuildRollup(
    orgId: string,
    meterKey: string,
    granularity: RollupGranularity,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ totalQuantity: number; eventCount: number }> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx.execute(sql`
          SELECT COALESCE(SUM(quantity), 0)::bigint AS total, COUNT(*)::int AS events
          FROM billing_usage_events
          WHERE org_id = ${orgId} AND meter_key = ${meterKey}
            AND occurred_at >= ${periodStart} AND occurred_at < ${periodEnd}
        `);
        const totalQuantity = readCount(rows, "total");
        const eventCount = readCount(rows, "events");

        await tx
          .insert(billingUsageRollups)
          .values({ orgId, meterKey, granularity, periodStart, periodEnd, totalQuantity, eventCount })
          .onConflictDoUpdate({
            target: [
              billingUsageRollups.orgId,
              billingUsageRollups.meterKey,
              billingUsageRollups.granularity,
              billingUsageRollups.periodStart,
            ],
            set: { totalQuantity, eventCount, periodEnd, rebuiltAt: new Date() },
          });

        return { totalQuantity, eventCount };
      },
      { orgId },
    );
  }

  /** Expires abandoned reservations so their quota stops being held. Has no ambient tenant context. */
  async sweepExpiredReservations(limit = 500): Promise<number> {
    const expired = await this.db
      .select({
        id: billingUsageReservations.id,
        orgId: billingUsageReservations.orgId,
        meterKey: billingUsageReservations.meterKey,
      })
      .from(billingUsageReservations)
      .where(
        and(
          eq(billingUsageReservations.status, "ACTIVE"),
          lte(billingUsageReservations.expiresAt, new Date()),
        ),
      )
      .limit(limit);

    let swept = 0;
    for (const row of expired) {
      try {
        await runInNewTenantTransaction(this.db, row.orgId, async (tx) => {
          await tx.execute(lockMeter(row.orgId, row.meterKey));
          await tx
            .update(billingUsageReservations)
            .set({ status: "EXPIRED", settledAt: new Date(), settledQuantity: 0 })
            .where(
              and(
                eq(billingUsageReservations.id, row.id),
                eq(billingUsageReservations.status, "ACTIVE"),
              ),
            );
        });
        swept++;
      } catch (err: unknown) {
        this.logger.error(`Failed to expire usage reservation ${row.id}`, {
          orgId: row.orgId,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return swept;
  }
}
