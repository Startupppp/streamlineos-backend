import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invGrns } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { GrnReadService } from "../grn-read.service";

export type GrnStatus = "DRAFT" | "COUNTING" | "QUALITY_REVIEW" | "POSTED" | "CANCELLED";

/**
 * Which statuses each move may be made FROM.
 *
 * The whole status machine, written down once. Absence is a refusal: a POSTED
 * receipt appears in none of these lists, so nothing here can un-post one —
 * that is `reverseGrn`'s job and it writes a compensating movement rather than
 * moving a status.
 */
const TRANSITIONS: Readonly<
  Record<"COUNTING" | "QUALITY_REVIEW" | "CANCELLED", readonly GrnStatus[]>
> = {
  COUNTING: ["DRAFT", "QUALITY_REVIEW"],
  QUALITY_REVIEW: ["DRAFT", "COUNTING"],
  CANCELLED: ["DRAFT", "COUNTING", "QUALITY_REVIEW"],
};

/** The statuses whose lines may still be changed. */
export const EDITABLE: readonly GrnStatus[] = ["DRAFT", "COUNTING"];

/** What a status move reads and writes through. */
export interface GrnTransitionDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: InventoryAuditService;
  readonly warehouseScope: WarehouseScopeService;
  readonly reads: GrnReadService;
}

/**
 * The receipt as it stands, and whether this caller may touch it at all.
 *
 * Out of scope reads as absent: a 403 on a receipt the caller cannot see would
 * confirm it exists. Refuses a receipt already past counting, because its lines
 * are what a later edit would change and those have become a record of what
 * arrived.
 */
export async function loadEditableGrn(
  deps: GrnTransitionDeps,
  orgId: string,
  grnId: number,
  userId: string,
) {
  const grn = await deps.db.query.invGrns.findFirst({
    where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
    columns: {
      id: true, poId: true, status: true, locationId: true,
      receivedDate: true, notes: true,
    },
  });
  if (!grn) throw new NotFoundException("GRN not found");
  await deps.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);
  if (!EDITABLE.includes(grn.status))
    throw new BadRequestException(`A ${grn.status} goods receipt can no longer be edited`);
  return grn;
}

/**
 * Move one goods receipt from wherever it is to `to`, or refuse.
 *
 * The legal sources are read from `TRANSITIONS` and go into the UPDATE's own
 * WHERE clause rather than being checked against the row read above it. That is
 * the difference between this and a read-then-write: two clients moving the
 * same receipt at once both see the same starting status and both pass a
 * check, but only one UPDATE matches a row. The other gets zero rows back and
 * is told so — which is why the refusal below reports the status as it was
 * READ, and is a 409 rather than a 400. The caller was not wrong; they were
 * second.
 */
export async function transitionGrn(
  deps: GrnTransitionDeps,
  orgId: string,
  grnId: number,
  userId: string,
  to: "COUNTING" | "QUALITY_REVIEW" | "CANCELLED",
  action: string,
  reason?: string,
) {
  const from = TRANSITIONS[to];
  const grn = await deps.db.query.invGrns.findFirst({
    where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
    columns: { id: true, status: true, locationId: true },
  });
  if (!grn) throw new NotFoundException("GRN not found");
  await deps.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);

  await deps.db.transaction(async (tx) => {
    const moved = await tx
      .update(invGrns)
      .set({ status: to, updatedAt: new Date() })
      .where(
        and(
          eq(invGrns.id, grnId),
          eq(invGrns.orgId, orgId),
          inArray(invGrns.status, [...from]),
        ),
      )
      .returning({ id: invGrns.id });
    if (moved.length === 0) {
      throw new ConflictException(
        `A ${grn.status} goods receipt cannot move to ${to}`,
      );
    }

    await deps.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action,
      resourceType: "inv_grn",
      resourceId: String(grnId),
      before: { status: grn.status },
      after: { status: to },
      metadata: reason ? { reason } : undefined,
    });
  });

  await deps.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId));
  return deps.reads.getGrn(orgId, grnId, userId);
}
