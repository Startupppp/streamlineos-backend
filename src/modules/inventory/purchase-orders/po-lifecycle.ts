import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPurchaseOrders, invGrns } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";

export interface PoLifecycleDeps {
  db: Db;
  cache: CacheService;
  settingsService: InventorySettingsService;
}

export async function approvePo(deps: PoLifecycleDeps, orgId: string, poId: number, userId: string) {
  const settings = await deps.settingsService.get(orgId);
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be approved");

  if (!settings.requirePoApproval) {
    throw new BadRequestException(
      "Purchase order approval is not required for this organisation; send the PO directly",
    );
  }

  const [updated] = await deps.db.update(invPurchaseOrders)
    .set({
      status: "SENT",
      approvedBy: userId,
      approvedAt: new Date(),
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
    .returning();

  await deps.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
  return updated;
}

export async function sendPo(deps: PoLifecycleDeps, orgId: string, poId: number) {
  const settings = await deps.settingsService.get(orgId);
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be sent");

  if (settings.requirePoApproval && !po.approvedBy) {
    throw new BadRequestException("This purchase order requires approval before sending");
  }

  const [sent] = await deps.db.update(invPurchaseOrders)
    .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
    .returning();

  await deps.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
  return sent;
}

export async function closePo(deps: PoLifecycleDeps, orgId: string, poId: number) {
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  if (po.status !== "RECEIVED" && po.status !== "PARTIAL") {
    throw new BadRequestException("Only RECEIVED or PARTIAL purchase orders can be closed");
  }

  const [closed] = await deps.db.update(invPurchaseOrders)
    .set({ status: "CLOSED", updatedAt: new Date() })
    .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
    .returning();

  await deps.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
  return closed;
}

export async function cancelPo(deps: PoLifecycleDeps, orgId: string, poId: number) {
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  if (po.status !== "DRAFT" && po.status !== "SENT") {
    throw new BadRequestException("Only DRAFT or SENT purchase orders can be cancelled");
  }

  const grnCount = await deps.db.select({ cnt: sql<number>`count(*)::int` })
    .from(invGrns)
    .where(and(eq(invGrns.poId, poId), eq(invGrns.orgId, orgId)));

  if ((grnCount[0]?.cnt ?? 0) > 0) {
    throw new BadRequestException("Cannot cancel a purchase order that has already received goods");
  }

  const [cancelled] = await deps.db.update(invPurchaseOrders)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
    .returning();

  await deps.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
  return cancelled;
}
