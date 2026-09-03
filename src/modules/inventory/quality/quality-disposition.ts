import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  invQualityInspections,
  invStockLevels,
  invVendorReturns,
  invVendorReturnLines,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import type { DisposeInspectionInput } from "./dto/quality.schemas";

export interface InspectionDispositionDeps {
  db: Db;
  cache: CacheService;
  engine: StockEngineService;
  numSeq: NumberSequenceService;
  audit: InventoryAuditService;
}

export interface StockLevelLineKey {
  productVariantId: number;
  lotId: number | null | undefined;
  serialId: number | null | undefined;
}

export interface InspectionDispositionLine extends StockLevelLineKey {
  id: number;
  quantity: string;
}

export function stockLevelKey(
  productVariantId: number,
  lotId: number | null | undefined,
  serialId: number | null | undefined,
): string {
  return `${productVariantId}:${lotId ?? "null"}:${serialId ?? "null"}`;
}

export async function batchFetchStockLevels(
  db: Db,
  orgId: string,
  lines: StockLevelLineKey[],
): Promise<Map<string, typeof invStockLevels.$inferSelect>> {
  if (lines.length === 0) return new Map();

  const productVariantIds = [...new Set(lines.map(l => l.productVariantId))];

  const rows = await db
    .select()
    .from(invStockLevels)
    .where(and(
      eq(invStockLevels.orgId, orgId),
      inArray(invStockLevels.productVariantId, productVariantIds),
    ));

  const map = new Map<string, typeof invStockLevels.$inferSelect>();
  for (const row of rows) {
    const key = stockLevelKey(row.productVariantId, row.lotId, row.serialId);
    map.set(key, row);
  }
  return map;
}

export async function disposeInspection(
  deps: InspectionDispositionDeps,
  orgId: string,
  userId: string,
  id: number,
  inspectionLines: InspectionDispositionLine[],
  input: DisposeInspectionInput,
  idempotencyKey: string,
): Promise<void> {
  const quarantineMoves: StockMovement[] = [];
  const scrapMoves: StockMovement[] = [];
  const releaseMoves: StockMovement[] = [];
  type RtvEntry = { vendorId: number; lineId: number; productVariantId: number; lotId: number | null; serialId: number | null; quantity: string };
  const rtvEntries: RtvEntry[] = [];

  const stockLevelMap = await batchFetchStockLevels(deps.db, orgId, inspectionLines);

  for (const dl of input.lines) {
    const line = inspectionLines.find(l => l.id === dl.lineId);
    if (!line) throw new BadRequestException(`Line ${dl.lineId} not found`);
    const levelKey = stockLevelKey(line.productVariantId, line.lotId, line.serialId);
    const cachedLevel = stockLevelMap.get(levelKey);
    const locId = dl.locationId ?? cachedLevel?.locationId;
    if (!locId && dl.disposition !== "RETURN_TO_VENDOR") throw new BadRequestException(`No location found for line ${dl.lineId}`);
    const base = { productVariantId: line.productVariantId, locationId: locId ?? 0, lotId: line.lotId ?? undefined, serialId: line.serialId ?? undefined };
    if (dl.disposition === "QUARANTINE") {
      quarantineMoves.push({ transactionType: "QUARANTINE_IN", ...base, quantityDelta: line.quantity, qualityBucket: "BLOCKED" });
    } else if (dl.disposition === "SCRAP") {
      scrapMoves.push({ transactionType: "SCRAP", ...base, quantityDelta: "-" + line.quantity });
    } else if (dl.disposition === "RELEASE_TO_AVAILABLE") {
      if (cachedLevel && parseFloat(cachedLevel.qualityHoldQty ?? "0") > 0) {
        releaseMoves.push(
          { transactionType: "QUARANTINE_OUT", ...base, quantityDelta: "-" + line.quantity, qualityBucket: "QUALITY_HOLD" },
          { transactionType: "ADJUSTMENT_IN", ...base, quantityDelta: line.quantity, qualityBucket: "ON_HAND" },
        );
      }
    } else if (dl.disposition === "RETURN_TO_VENDOR") {
      const vendorId = dl.vendorId;
      if (vendorId === undefined) throw new BadRequestException("vendorId required for RETURN_TO_VENDOR");
      rtvEntries.push({ vendorId, lineId: dl.lineId, productVariantId: line.productVariantId, lotId: line.lotId ?? null, serialId: line.serialId ?? null, quantity: line.quantity });
    }
  }

  if (quarantineMoves.length > 0) {
    await deps.engine.execute(orgId, userId, { idempotencyKey: `${idempotencyKey}:Q`, sourceType: "INSPECTION_DISPOSE", sourceId: String(id), movements: quarantineMoves });
  }
  if (scrapMoves.length > 0) {
    await deps.engine.execute(orgId, userId, { idempotencyKey: `${idempotencyKey}:S`, sourceType: "INSPECTION_DISPOSE", sourceId: String(id), movements: scrapMoves });
  }
  if (releaseMoves.length > 0) {
    await deps.engine.execute(orgId, userId, { idempotencyKey: `${idempotencyKey}:R`, sourceType: "INSPECTION_DISPOSE", sourceId: String(id), movements: releaseMoves });
  }

  if (rtvEntries.length > 0) {
    const byVendor = new Map<number, RtvEntry[]>();
    for (const e of rtvEntries) {
      const arr = byVendor.get(e.vendorId) ?? [];
      arr.push(e);
      byVendor.set(e.vendorId, arr);
    }
    for (const [vendorId, entries] of byVendor) {
      await deps.db.transaction(async (tx) => {
        const returnNumber = await deps.numSeq.next(orgId, "VENDOR_RETURN", tx);
        const [ret] = await tx.insert(invVendorReturns).values({
          orgId, returnNumber, vendorId, status: "DRAFT", createdBy: userId,
        }).returning();
        if (!ret) throw new Error("Insert vendor return failed");
        await tx.insert(invVendorReturnLines).values(
          entries.map(e => ({
            returnId: ret.id,
            productVariantId: e.productVariantId,
            lotId: e.lotId,
            serialId: e.serialId,
            quantity: e.quantity,
            reason: "QUALITY_REJECTED" as const,
          })),
        );
      });
    }
  }

  await deps.db.update(invQualityInspections)
    .set({ status: "COMPLETED", completedAt: new Date() })
    .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
  await deps.audit.insert(deps.db, {
    orgId, actorUserId: userId, action: "quality_inspection.disposed",
    resourceType: "inspection", resourceId: String(id),
  });
  await deps.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
}
