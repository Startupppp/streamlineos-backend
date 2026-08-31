import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invGrns,
  invGrnLines,
  invGrnLineSerials,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { UomConversionService } from "../stock-engine/uom-conversion.service";
import { InvQuantityCaptureService } from "../products/inv-quantity-capture.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import type {
  ListGrnInput,
  CancelGrnInput,
  CreateGrnDraftInput,
  CreateGrnInput,
  ReverseGrnInput,
  UpdateGrnDraftInput,
} from "./dto/inv-purchase-orders.schemas";
import { PoService } from "./po.service";
import { GrnPostingService } from "./grn-post.service";
import { GrnReadService } from "./grn-read.service";
import { QuickCommerceInboundService } from "../channels/quick-commerce/quick-commerce-inbound.service";
import { HandlingUnitService } from "../handling-units/handling-unit.service";
import { assertCatchWeightLine } from "../stock-types/catch-weight";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type GrnStatus = "DRAFT" | "COUNTING" | "QUALITY_REVIEW" | "POSTED" | "CANCELLED";

type GrnDraftLine = CreateGrnDraftInput["lines"][number];

interface ReceivablePo {
  id: number;
  warehouseId: number | null;
  lines: ReadonlyArray<{
    id: number;
    productVariant: {
      id: number;
      productId: number;
      product?: { measureMode?: "PIECES" | "CATCH_WEIGHT" | null } | null;
    };
  }>;
}

@Injectable()
export class GrnService {
  private static readonly TRANSITIONS: Readonly<Record<"COUNTING" | "QUALITY_REVIEW" | "CANCELLED", readonly GrnStatus[]>> = {
    COUNTING: ["DRAFT", "QUALITY_REVIEW"],
    QUALITY_REVIEW: ["DRAFT", "COUNTING"],
    CANCELLED: ["DRAFT", "COUNTING", "QUALITY_REVIEW"],
  };

  private static readonly EDITABLE: readonly GrnStatus[] = ["DRAFT", "COUNTING"];

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly uom: UomConversionService,
    private readonly quantityCapture: InvQuantityCaptureService,
    private readonly audit: InventoryAuditService,
    private readonly poService: PoService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly posting: GrnPostingService,
    private readonly reads: GrnReadService,
    private readonly quickCommerce: QuickCommerceInboundService,
    private readonly handlingUnits: HandlingUnitService,
    private readonly engine: StockEngineService,
  ) {}

  async listGrns(orgId: string, filters: ListGrnInput) {
    const { poId, vendorId, dateFrom, dateTo, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${poId ?? ""}:${vendorId ?? ""}:${dateFrom ?? ""}:${dateTo ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invGrnNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invGrns.orgId, orgId)];
        if (poId) conditions.push(eq(invGrns.poId, poId));
        if (dateFrom) conditions.push(gte(invGrns.receivedDate, dateFrom));
        if (dateTo) conditions.push(lte(invGrns.receivedDate, dateTo));

        if (vendorId) {
          const poIds = await this.db
            .select({ id: invPurchaseOrders.id })
            .from(invPurchaseOrders)
            .where(
              and(
                eq(invPurchaseOrders.orgId, orgId),
                eq(invPurchaseOrders.vendorId, vendorId),
              ),
            );
          if (poIds.length === 0)
            return { items: [], total: 0, page, totalPages: 0 };
          conditions.push(
            inArray(
              invGrns.poId,
              poIds.map((p) => p.id),
            ),
          );
        }

        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invGrns.findMany({
            where,
            orderBy: [desc(invGrns.createdAt)],
            limit,
            offset,
            with: {
              purchaseOrder: {
                columns: { id: true, poNumber: true, vendorId: true },
                with: { vendor: { columns: { id: true, name: true } } },
              },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invGrns)
            .where(where),
        ]);

        return {
          items,
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  async getGrn(orgId: string, grnId: number, userId: string) {
    return this.reads.getGrn(orgId, grnId, userId);
  }

  async createDraft(
    orgId: string,
    userId: string,
    idempotencyKey: string,
    data: CreateGrnDraftInput,
  ) {
    const po = await this.loadReceivablePo(orgId, data.poId);
    const locationId = await this.resolveLocation(orgId, userId, po.warehouseId, data.locationId);

    const grnId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.receiving.draft", ...data, locationId },
        async () => {
          await this.quickCommerce.assertReceivable(tx, orgId, { poId: po.id, asnId: data.asnId ?? null });
          return this.createDraftInTx(
            tx, orgId, userId, po, locationId, data.receivedDate, data.notes, data.lines, data.asnId ?? null,
          );
        },
        this.revivedGrnId,
      ),
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId));
    return this.getGrn(orgId, grnId, userId);
  }

  async updateDraft(
    orgId: string,
    grnId: number,
    userId: string,
    data: UpdateGrnDraftInput,
  ) {
    const grn = await this.loadEditableGrn(orgId, grnId, userId);
    const po = await this.loadReceivablePo(orgId, grn.poId);
    const locationId =
      data.locationId === undefined
        ? grn.locationId
        : await this.resolveLocation(orgId, userId, po.warehouseId, data.locationId);

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(invGrns)
        .set({
          receivedDate: data.receivedDate ?? grn.receivedDate,
          locationId,
          notes: data.notes ?? grn.notes,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invGrns.id, grnId),
            eq(invGrns.orgId, orgId),
            inArray(invGrns.status, [...GrnService.EDITABLE]),
          ),
        )
        .returning({ id: invGrns.id });
      if (updated.length === 0)
        throw new ConflictException("This goods receipt is no longer open for counting");

      if (data.lines) {
        await tx.delete(invGrnLines).where(and(eq(invGrnLines.grnId, grnId), eq(invGrnLines.orgId, orgId)));
        await this.insertLines(tx, orgId, grnId, po, data.lines);
      }

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "receiving.update",
        resourceType: "inv_grn",
        resourceId: String(grnId),
        metadata: { lineCount: data.lines?.length ?? null },
      });
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId));
    return this.getGrn(orgId, grnId, userId);
  }

  startCounting(orgId: string, grnId: number, userId: string) {
    return this.transition(orgId, grnId, userId, "COUNTING", "receiving.count");
  }

  submitForQualityReview(orgId: string, grnId: number, userId: string) {
    return this.transition(orgId, grnId, userId, "QUALITY_REVIEW", "receiving.quality-review");
  }

  cancelGrn(orgId: string, grnId: number, userId: string, data: CancelGrnInput) {
    return this.transition(orgId, grnId, userId, "CANCELLED", "receiving.cancel", data.reason);
  }

  postGrn(orgId: string, grnId: number, userId: string, idempotencyKey: string) {
    return this.posting
      .postGrn(orgId, grnId, userId, idempotencyKey)
      .then((posted) => this.getGrn(orgId, posted, userId));
  }

  reverseGrn(
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
    data: ReverseGrnInput,
  ) {
    return this.posting.reverseGrn(orgId, grnId, userId, idempotencyKey, data);
  }

  async receiveGoods(
    orgId: string,
    poId: number,
    userId: string,
    idempotencyKey: string,
    data: CreateGrnInput,
  ) {
    const po = await this.loadReceivablePo(orgId, poId);
    const locationId = await this.resolveLocation(orgId, userId, po.warehouseId, data.locationId);

    const grnId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { poId, locationId, receivedDate: data.receivedDate, notes: data.notes, lines: data.lines },
        async () => {
          await this.quickCommerce.assertReceivable(tx, orgId, { poId: po.id, asnId: data.asnId ?? null });
          const created = await this.createDraftInTx(
            tx, orgId, userId, po, locationId, data.receivedDate, data.notes, data.lines, data.asnId ?? null,
          );
          return this.posting.postInTx(tx, orgId, created, userId, idempotencyKey);
        },
        this.revivedGrnId,
      ),
    );

    await this.posting.invalidateAfterPost(orgId, poId);
    return this.getGrn(orgId, grnId, userId);
  }

  private async transition(
    orgId: string,
    grnId: number,
    userId: string,
    to: "COUNTING" | "QUALITY_REVIEW" | "CANCELLED",
    action: string,
    reason?: string,
  ) {
    const from = GrnService.TRANSITIONS[to];
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      columns: { id: true, status: true, locationId: true },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);

    await this.db.transaction(async (tx) => {
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

      await this.audit.insert(tx, {
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

    await this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId));
    return this.getGrn(orgId, grnId, userId);
  }

  private async createDraftInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    po: ReceivablePo,
    locationId: number,
    receivedDate: string,
    notes: string | undefined,
    lines: readonly GrnDraftLine[],
    asnId: number | null,
  ): Promise<number> {
    const grnNumber = await this.numSeq.next(orgId, "GRN", tx);

    const [grn] = await tx
      .insert(invGrns)
      .values({
        orgId,
        poId: po.id,
        grnNumber,
        locationId,
        notes,
        status: "DRAFT",
        asnId,
        createdBy: userId,
        receivedDate,
      })
      .returning({ id: invGrns.id });
    if (!grn) throw new ConflictException("Could not open the goods receipt");

    await this.insertLines(tx, orgId, grn.id, po, lines);

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "receiving.draft",
      resourceType: "inv_grn",
      resourceId: String(grn.id),
      after: { status: "DRAFT" },
      metadata: { poId: po.id, grnNumber, lineCount: lines.length },
    });

    return grn.id;
  }

  private async insertLines(
    tx: Tx,
    orgId: string,
    grnId: number,
    po: ReceivablePo,
    lines: readonly GrnDraftLine[],
  ): Promise<void> {
    const seen = new Set<number>();
    for (const line of lines) {
      if (seen.has(line.poLineId))
        throw new BadRequestException(`PO line ${line.poLineId} appears twice on this receipt`);
      seen.add(line.poLineId);

      const poLine = po.lines.find((l) => l.id === line.poLineId);
      if (!poLine) throw new BadRequestException(`PO line ${line.poLineId} not found`);
      if (line.qualityStatus === "REJECTED" && !line.rejectionReason)
        throw new BadRequestException(`Line ${line.poLineId}: a rejected line needs a reason`);

      await this.quantityCapture.assertEnteredQuantity(
        orgId,
        poLine.productVariant.id,
        line.quantityReceived,
      );

      if (line.handlingUnitId !== undefined) {
        await this.handlingUnits.assertCanHoldStockInTx(tx, orgId, line.handlingUnitId);
      }

      assertCatchWeightLine(poLine.productVariant.product?.measureMode ?? "PIECES", {
        quantity: line.quantityReceived,
        quantityPieces: line.quantityPieces ?? null,
      });

      const converted = await this.uom.convert(
        orgId,
        poLine.productVariant.productId,
        line.uomId ?? null,
        line.quantityReceived,
      );

      const [inserted] = await tx
        .insert(invGrnLines)
        .values({
          orgId,
          grnId,
          poLineId: line.poLineId,
          quantityReceived: converted.quantity,
          quantityEntered: converted.quantityEntered,
          uomId: converted.uomId,
          uomFactor: converted.uomFactor,
          qualityStatus: line.qualityStatus,
          rejectionReason: line.rejectionReason,
          discrepancyReason: line.discrepancyReason,
          handlingUnitId: line.handlingUnitId ?? null,
          crossDockSoId: line.crossDockSoId ?? null,
          quantityPieces: line.quantityPieces ?? null,
          ownership: line.ownership ?? "OWNED",
          lotNumber: line.lotNumber,
          expiryDate: line.expiryDate,
          manufactureDate: line.manufactureDate,
          mrpPaise: line.mrpPaise ?? null,
          purchaseRatePaise: line.purchaseRatePaise ?? null,
        })
        .returning({ id: invGrnLines.id });
      if (!inserted) throw new ConflictException("Could not write the receipt line");

      const serials = line.serialNumbers ?? [];
      if (serials.length === 0) continue;
      const unique = [...new Set(serials)];
      if (unique.length !== serials.length)
        throw new BadRequestException(`Line ${line.poLineId}: the same serial was scanned twice`);
      await tx.insert(invGrnLineSerials).values(
        unique.map((serialNumber) => ({ orgId, grnLineId: inserted.id, serialNumber })),
      );
    }
  }

  private async loadReceivablePo(orgId: string, poId: number) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
      with: {
        lines: {
          with: {
            productVariant: {
              columns: { id: true, productId: true },
              with: { product: { columns: { id: true, trackingMethod: true, measureMode: true } } },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "SENT" && po.status !== "PARTIAL") {
      throw new BadRequestException(
        "Purchase order must be SENT or PARTIAL to receive goods",
      );
    }
    return po;
  }

  private async loadEditableGrn(orgId: string, grnId: number, userId: string) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      columns: {
        id: true, poId: true, status: true, locationId: true,
        receivedDate: true, notes: true,
      },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);
    if (!GrnService.EDITABLE.includes(grn.status))
      throw new BadRequestException(`A ${grn.status} goods receipt can no longer be edited`);
    return grn;
  }

  private async resolveLocation(
    orgId: string,
    userId: string,
    warehouseId: number | null,
    requested: number | undefined,
  ): Promise<number> {
    if (requested === undefined)
      return this.poService.resolveLocationId(orgId, warehouseId);

    const loc = await this.db.query.invLocations.findFirst({
      where: and(
        eq(invLocations.id, requested),
        eq(invLocations.orgId, orgId),
        eq(invLocations.isActive, true),
      ),
      columns: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found or inactive");
    await this.warehouseScope.assertLocationVisible(orgId, userId, loc.id);
    return loc.id;
  }

  private readonly revivedGrnId = (stored: unknown): number => {
    const id = revivedId(stored);
    if (!Number.isInteger(id))
      throw new ConflictException("The stored result for this key is unreadable");
    return id;
  };
}
