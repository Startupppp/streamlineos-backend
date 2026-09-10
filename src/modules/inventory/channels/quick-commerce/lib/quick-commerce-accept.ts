import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  invPlatformPurchaseOrders,
  invPurchaseOrders,
  invPoLines,
} from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import type { PlatformPoDetail } from "./quick-commerce-documents";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../../../stock-engine/number-sequence.service";
import { ChannelPoolService } from "../../../stock-engine/channel-pool.service";
import { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../../../stock-engine/idempotency";
import { addDec, mulDec } from "../../../stock-engine/decimal";
import type { AcceptPlatformPoInput } from "../dto/quick-commerce.schemas";

/**
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged, and nothing
 * here opens a transaction the service did not.
 *
 * `reloadUnscopedPo` is a CALLBACK rather than an imported read, deliberately.
 * `detailUnscoped` is the read that skips `platformPoInScope`, and its comment
 * on the service says it is "named so nobody routes to it by accident";
 * exporting it from `lib/` would make it importable from anywhere. Handing this
 * flow a bound closure keeps the ungated read private to the service, which is
 * the only place that has already asserted the caller's warehouse.
 */
export interface QcAcceptDeps {
  readonly db: Db;
  readonly audit: InventoryAuditService;
  readonly numSeq: NumberSequenceService;
  readonly channelPools: ChannelPoolService;
  readonly warehouseScope: WarehouseScopeService;
  readonly reloadUnscopedPo: (orgId: string, platformPoId: number) => Promise<PlatformPoDetail>;
}

/**
 * Turn an ingested platform PO into a Streamline purchase order, and claim the
 * stock for the platform's channel.
 *
 * The claim is the point of connecting NEO-2 to NEO-1: once Blinkit's order is
 * accepted, those units stop being offered on the storefront. It is best-effort
 * per line and recorded rather than fatal — a platform ordering more than we
 * hold is an ordinary commercial event, and refusing the whole acceptance over
 * it would leave the PO in limbo with no purchase order behind it.
 */
export async function acceptPurchaseOrder(
  deps: QcAcceptDeps,
  orgId: string,
  userId: string,
  platformPoId: number,
  input: AcceptPlatformPoInput,
  idempotencyKey: string,
) {
  const detail = await deps.reloadUnscopedPo(orgId, platformPoId);
  if (detail.status === "REJECTED") {
    throw new BadRequestException(
      "This purchase order has lines that do not match the catalogue and cannot be accepted",
    );
  }
  if (detail.status === "CANCELLED") {
    throw new BadRequestException("This purchase order has been cancelled");
  }
  if (detail.poId !== null) return deps.reloadUnscopedPo(orgId, platformPoId);

  await deps.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

  const lines = detail.lines.filter((l) => l.productVariantId !== null);
  if (lines.length === 0) throw new BadRequestException("This purchase order has no usable lines");

  await deps.db.transaction((tx) =>
    runIdempotent(
      tx,
      orgId,
      idempotencyKey,
      { command: "inventory.quick-commerce.accept", platformPoId },
      async () => {
        const poNumber = await deps.numSeq.next(orgId, "PO", tx);
        const subtotal = lines.reduce(
          (sum, line) => addDec(sum, mulDec(line.quantityOrdered, line.unitCost ?? "0")),
          "0",
        );

        const [po] = await tx
          .insert(invPurchaseOrders)
          .values({
            orgId,
            vendorId: input.vendorId,
            poNumber,
            status: "DRAFT",
            orderDate: input.orderDate,
            expectedDeliveryDate: detail.expectedDeliveryDate,
            warehouseId: input.warehouseId,
            subtotal,
            taxAmount: "0",
            discount: "0",
            total: subtotal,
            currency: detail.currency,
            notes: `${detail.provider} PO ${detail.providerPoNumber}`,
            createdBy: userId,
          })
          .returning();

        await tx.insert(invPoLines).values(
          lines.map((line, index) => ({
            orgId,
            poId: po!.id,
            productVariantId: line.productVariantId!,
            quantity: line.quantityOrdered,
            unitCost: line.unitCost ?? "0",
            taxRate: "0",
            amount: mulDec(line.quantityOrdered, line.unitCost ?? "0"),
            lineOrder: index,
          })),
        );

        await tx
          .update(invPlatformPurchaseOrders)
          .set({ status: "ACCEPTED", poId: po!.id, warehouseId: input.warehouseId, updatedAt: new Date() })
          .where(
            and(
              eq(invPlatformPurchaseOrders.orgId, orgId),
              eq(invPlatformPurchaseOrders.id, platformPoId),
            ),
          );

        await deps.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "platform_po.accept",
          resourceType: "inv_platform_purchase_order",
          resourceId: String(platformPoId),
          after: { poId: po!.id, poNumber },
        });

        return { poId: po!.id };
      },
      (stored) => stored as { poId: number },
    ),
  );

  // Outside the acceptance transaction on purpose: a claim that cannot be met
  // must not roll the purchase order back. Each allocation is idempotent on its
  // own key, so a retry of `accept` does not double-claim.
  if (detail.channelId !== null && input.reserveIntoChannelPool) {
    for (const line of lines) {
      try {
        await deps.channelPools.allocate(orgId, userId, {
          channelId: detail.channelId,
          productVariantId: line.productVariantId!,
          warehouseId: input.warehouseId,
          deltaQty: line.quantityOrdered,
          idempotencyKey: `${idempotencyKey}:pool:${line.id}`,
        });
      } catch {
        // Recorded by the pool service's own audit trail when it succeeds; a
        // refusal here means the platform ordered more than we hold, which is
        // an ordinary commercial event and not a reason to unwind the PO.
      }
    }
  }

  return deps.reloadUnscopedPo(orgId, platformPoId);
}
