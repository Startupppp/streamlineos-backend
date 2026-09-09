import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  isExclusionViolation,
  isUniqueViolation,
} from "../../../common/db/postgres-error";
import { invDockAppointments, invDockDoors } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type {
  BookAppointmentInput,
  CreateDockDoorInput,
  ListAppointmentsQuery,
} from "./dto/dock.schemas";

/** Postgres' exclusion-violation SQLSTATE. */

/**
 * NEO-12 - dock appointments.
 *
 * The smallest thing that makes a dock schedulable: a door, a window, and a
 * refusal when two vehicles are booked into the same one. **Not a yard.** There
 * is no trailer, no parking bay, no gate move and no digital twin of the site;
 * half of one of those would be worse than none, because a yard screen that
 * cannot tell you where a trailer is is a screen people stop looking at.
 *
 * The collision rule is a database exclusion constraint rather than a check in
 * this service, and that is the point: two clerks booking the same door at the
 * same moment both pass a read, and only Postgres can settle it. This service
 * turns the constraint's error into a sentence somebody can act on.
 */
@Injectable()
export class DockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listDoors(orgId: string, userId: string, warehouseId?: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) return [];

    return this.db
      .select()
      .from(invDockDoors)
      .where(
        and(
          eq(invDockDoors.orgId, orgId),
          warehouseId ? eq(invDockDoors.warehouseId, warehouseId) : sql`TRUE`,
          scope.warehouse(sql`${invDockDoors.warehouseId}`),
        ),
      )
      .orderBy(asc(invDockDoors.warehouseId), asc(invDockDoors.code));
  }

  async createDoor(orgId: string, userId: string, input: CreateDockDoorInput) {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);
    try {
      const [door] = await this.db
        .insert(invDockDoors)
        .values({
          orgId,
          warehouseId: input.warehouseId,
          code: input.code,
          name: input.name ?? null,
          direction: input.direction ?? null,
          createdBy: userId,
        })
        .returning();

      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "dock_door.create",
        resourceType: "inv_dock_door",
        resourceId: String(door!.id),
        after: { code: input.code, warehouseId: input.warehouseId },
      });
      return door;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`This warehouse already has a door called ${input.code}`);
      }
      throw error;
    }
  }

  /**
   * Book a slot.
   *
   * A collision is a 409 naming the door and the window, because the caller's
   * next act is to pick a different one and they need to know which one they
   * cannot have. The refusal comes from the exclusion constraint rather than a
   * read-then-write here, which is what makes it true under two clerks at once.
   */
  async book(orgId: string, userId: string, input: BookAppointmentInput) {
    const [door] = await this.db
      .select({ id: invDockDoors.id, warehouseId: invDockDoors.warehouseId, code: invDockDoors.code, isActive: invDockDoors.isActive })
      .from(invDockDoors)
      .where(and(eq(invDockDoors.orgId, orgId), eq(invDockDoors.id, input.doorId)));
    if (!door) throw new NotFoundException("Not found");
    if (!door.isActive) throw new ConflictException(`Door ${door.code} is out of service`);

    await this.warehouseScope.assertWarehouseVisible(orgId, userId, door.warehouseId);

    try {
      const [appointment] = await this.db
        .insert(invDockAppointments)
        .values({
          orgId,
          warehouseId: door.warehouseId,
          doorId: input.doorId,
          direction: input.direction,
          status: "BOOKED",
          windowStart: new Date(input.windowStart),
          windowEnd: new Date(input.windowEnd),
          carrierName: input.carrierName ?? null,
          vehicleRef: input.vehicleRef ?? null,
          reference: input.reference ?? null,
          asnId: input.asnId ?? null,
          loadId: input.loadId ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        })
        .returning();

      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "dock_appointment.book",
        resourceType: "inv_dock_appointment",
        resourceId: String(appointment!.id),
        after: {
          doorId: input.doorId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          asnId: input.asnId ?? null,
        },
      });
      return appointment;
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new ConflictException(
          `Door ${door.code} is already booked between ${input.windowStart} and ${input.windowEnd}`,
        );
      }
      throw error;
    }
  }

  async list(orgId: string, userId: string, query: ListAppointmentsQuery) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) return [];

    return this.db
      .select({
        id: invDockAppointments.id,
        warehouseId: invDockAppointments.warehouseId,
        doorId: invDockAppointments.doorId,
        doorCode: invDockDoors.code,
        direction: invDockAppointments.direction,
        status: invDockAppointments.status,
        windowStart: invDockAppointments.windowStart,
        windowEnd: invDockAppointments.windowEnd,
        carrierName: invDockAppointments.carrierName,
        vehicleRef: invDockAppointments.vehicleRef,
        reference: invDockAppointments.reference,
        asnId: invDockAppointments.asnId,
        loadId: invDockAppointments.loadId,
      })
      .from(invDockAppointments)
      .innerJoin(
        invDockDoors,
        and(eq(invDockDoors.orgId, invDockAppointments.orgId), eq(invDockDoors.id, invDockAppointments.doorId)),
      )
      .where(
        and(
          eq(invDockAppointments.orgId, orgId),
          query.warehouseId ? eq(invDockAppointments.warehouseId, query.warehouseId) : sql`TRUE`,
          // `from`/`to` are already ISO strings (`z.string().datetime()`), so the
          // Date round-trip only produced the shape `keyset.spec.ts` forbids:
          // a bare Date interpolated into a sql template binds an object the
          // driver cannot serialise, and throws against a real database.
          sql`${invDockAppointments.windowStart} >= ${query.from}::timestamptz`,
          sql`${invDockAppointments.windowStart} < ${query.to}::timestamptz`,
          scope.warehouse(sql`${invDockAppointments.warehouseId}`),
        ),
      )
      .orderBy(asc(invDockAppointments.windowStart), asc(invDockAppointments.doorId))
      .limit(500);
  }

  async setStatus(
    orgId: string,
    userId: string,
    appointmentId: number,
    status: "ARRIVED" | "COMPLETED" | "CANCELLED" | "NO_SHOW",
  ) {
    const now = new Date();
    const [updated] = await this.db
      .update(invDockAppointments)
      .set({
        status,
        arrivedAt: status === "ARRIVED" ? now : undefined,
        completedAt: status === "COMPLETED" ? now : undefined,
        updatedAt: now,
      })
      .where(and(eq(invDockAppointments.orgId, orgId), eq(invDockAppointments.id, appointmentId)))
      .returning();
    if (!updated) throw new NotFoundException("Not found");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: `dock_appointment.${status.toLowerCase()}`,
      resourceType: "inv_dock_appointment",
      resourceId: String(appointmentId),
      after: { status },
    });
    return updated;
  }

  /**
   * NEO-12 - does this advance shipping notice have a slot?
   *
   * Asked by the receiving path when `asn_required_for_grn` is on, so "was this
   * expected" has one answer. A cancelled or no-show appointment does not count:
   * a slot somebody gave up is not a booking.
   */
  async hasAppointmentForAsn(orgId: string, asnId: number): Promise<boolean> {
    const [row] = await this.db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM inv_dock_appointments
        WHERE org_id = ${orgId} AND asn_id = ${asnId}
          AND status IN ('BOOKED', 'ARRIVED', 'COMPLETED')
      ) AS present
    `);
    return row?.present === true;
  }
}


