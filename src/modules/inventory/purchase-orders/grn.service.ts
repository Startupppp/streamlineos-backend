import { Inject, Injectable, ConflictException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invGrns, invGrnLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { UomConversionService } from "../stock-engine/uom-conversion.service";
import { InvQuantityCaptureService } from "../products/inv-quantity-capture.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import type {
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
import {
  createDraftInTx,
  insertGrnLines,
  loadReceivablePo,
  resolveLocation,
  type GrnDraftDeps,
} from "./lib/grn-draft";
import {
  EDITABLE,
  loadEditableGrn,
  transitionGrn,
  type GrnTransitionDeps,
} from "./lib/grn-transitions";

@Injectable()
export class GrnService {
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

  /**
   * Opening and editing a draft receipt. @see lib/grn-draft.ts
   *
   * `resolveDefaultLocationId` is bound rather than the whole `PoService` being
   * handed over: the draft path needs exactly one thing from the purchase-order
   * side and nothing else.
   */
  private get draftDeps(): GrnDraftDeps {
    return {
      db: this.db,
      numSeq: this.numSeq,
      uom: this.uom,
      quantityCapture: this.quantityCapture,
      audit: this.audit,
      warehouseScope: this.warehouseScope,
      handlingUnits: this.handlingUnits,
      resolveDefaultLocationId: (orgId, warehouseId) =>
        this.poService.resolveLocationId(orgId, warehouseId),
    };
  }

  /** The status machine. @see lib/grn-transitions.ts */
  private get transitionDeps(): GrnTransitionDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      warehouseScope: this.warehouseScope,
      reads: this.reads,
    };
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
    const po = await loadReceivablePo(this.draftDeps, orgId, data.poId);
    const locationId = await resolveLocation(
      this.draftDeps, orgId, userId, po.warehouseId, data.locationId,
    );

    const grnId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.receiving.draft", ...data, locationId },
        async () => {
          await this.quickCommerce.assertReceivable(tx, orgId, { poId: po.id, asnId: data.asnId ?? null });
          return createDraftInTx(
            this.draftDeps,
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
    const grn = await loadEditableGrn(this.transitionDeps, orgId, grnId, userId);
    const po = await loadReceivablePo(this.draftDeps, orgId, grn.poId);
    const locationId =
      data.locationId === undefined
        ? grn.locationId
        : await resolveLocation(this.draftDeps, orgId, userId, po.warehouseId, data.locationId);

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
            inArray(invGrns.status, [...EDITABLE]),
          ),
        )
        .returning({ id: invGrns.id });
      if (updated.length === 0)
        throw new ConflictException("This goods receipt is no longer open for counting");

      if (data.lines) {
        await tx.delete(invGrnLines).where(and(eq(invGrnLines.grnId, grnId), eq(invGrnLines.orgId, orgId)));
        await insertGrnLines(this.draftDeps, tx, orgId, grnId, po, data.lines);
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
    return transitionGrn(this.transitionDeps, orgId, grnId, userId, "COUNTING", "receiving.count");
  }

  submitForQualityReview(orgId: string, grnId: number, userId: string) {
    return transitionGrn(
      this.transitionDeps, orgId, grnId, userId, "QUALITY_REVIEW", "receiving.quality-review",
    );
  }

  cancelGrn(orgId: string, grnId: number, userId: string, data: CancelGrnInput) {
    return transitionGrn(
      this.transitionDeps, orgId, grnId, userId, "CANCELLED", "receiving.cancel", data.reason,
    );
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
    const po = await loadReceivablePo(this.draftDeps, orgId, poId);
    const locationId = await resolveLocation(
      this.draftDeps, orgId, userId, po.warehouseId, data.locationId,
    );

    const grnId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { poId, locationId, receivedDate: data.receivedDate, notes: data.notes, lines: data.lines },
        async () => {
          await this.quickCommerce.assertReceivable(tx, orgId, { poId: po.id, asnId: data.asnId ?? null });
          const created = await createDraftInTx(
            this.draftDeps,
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

  private readonly revivedGrnId = (stored: unknown): number => {
    const id = revivedId(stored);
    if (!Number.isInteger(id))
      throw new ConflictException("The stored result for this key is unreadable");
    return id;
  };
}
