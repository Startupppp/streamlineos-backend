import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invPurchaseOrders, invGrns, invGrnLines, invGrnLineSerials, invLocations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
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
  ListGrnInput,
  ReverseGrnInput,
  UpdateGrnDraftInput,
} from "./dto/inv-purchase-orders.schemas";
import { PoService } from "./po.service";
import { GrnPostingService } from "./grn-post.service";
import { GrnReadService } from "./grn-read.service";
import { QuickCommerceInboundService } from "../channels/quick-commerce/quick-commerce-inbound.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type GrnStatus = "DRAFT" | "COUNTING" | "QUALITY_REVIEW" | "POSTED" | "CANCELLED";

type GrnDraftLine = CreateGrnDraftInput["lines"][number];

/** A purchase order loaded with everything a receipt line needs to validate. */
interface ReceivablePo {
  id: number;
  warehouseId: number | null;
  lines: ReadonlyArray<{ id: number; productVariant: { id: number; productId: number } }>;
}

/**
 * B1 — where a delivery lives before it is stock.
 *
 * `inv_grns` had no status, so `receiveGoods` was the only thing a receipt could
 * do: type it and it posted. There was no way to count a pallet over an
 * afternoon, note that two cartons were crushed, have quality look at them and
 * post the rest in the morning — which is how receiving actually works. This
 * service owns the document: opening it, counting into it, moving it through
 * DRAFT → COUNTING → QUALITY_REVIEW, abandoning it, reading it back. None of
 * that touches `inv_stock_transactions`; everything that does lives in
 * `GrnPostingService`, so the boundary is visible in the import list.
 */
@Injectable()
export class GrnService {
  /**
   * The transition table, as data. Written once rather than as an `if` per
   * endpoint: a lifecycle scattered across four handlers is one nobody can read,
   * and the fifth handler is always the one that forgets POSTED is terminal.
   * POSTED and CANCELLED appear in no `from` list, which is what makes them so.
   */
  private static readonly TRANSITIONS: Readonly<Record<"COUNTING" | "QUALITY_REVIEW" | "CANCELLED", readonly GrnStatus[]>> = {
    COUNTING: ["DRAFT", "QUALITY_REVIEW"],
    QUALITY_REVIEW: ["DRAFT", "COUNTING"],
    CANCELLED: ["DRAFT", "COUNTING", "QUALITY_REVIEW"],
  };

  /** The states in which a receipt is still being written down. */
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
  ) {}

  /**
   * Opens a receipt without posting it. Claimed even though nothing moves: a
   * retried create otherwise raises a second GRN document with its own number
   * against the same delivery, and both are then postable — the defect A3 found
   * on the adjustment path.
   */
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
          // NEO-2. The `asn_required_for_grn` rule has one home, in the
          // quick-commerce service; receiving asks it rather than carrying a
          // copy. Inside the claim, so a refused first attempt rolls the claim
          // back with it.
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

  /**
   * Counting a delivery, saved. Not idempotency-claimed: an update names the
   * receipt it edits and replaces the lines wholesale, so applying it twice
   * leaves the same document. The status predicate on the write is what matters,
   * checked by affected-row count rather than by a read beforehand.
   */
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
        // A recount is "these are the lines", so the old set goes. Physical
        // deletion is the §3 exception for an unsent draft, and the serials go
        // with them through the composite cascade.
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

  /** DRAFT → COUNTING, and back from quality when the count is disputed. */
  startCounting(orgId: string, grnId: number, userId: string) {
    return this.transition(orgId, grnId, userId, "COUNTING", "receiving.count");
  }

  /** Hands the counted delivery to whoever inspects it. */
  submitForQualityReview(orgId: string, grnId: number, userId: string) {
    return this.transition(orgId, grnId, userId, "QUALITY_REVIEW", "receiving.quality-review");
  }

  /**
   * Abandons a receipt that will never post. The row stays and the status
   * becomes terminal rather than the document being deleted: a delivery somebody
   * walked away from is a fact, and its GRN number must not be reissued.
   */
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

  /**
   * Record and post a delivery in one command — the endpoint every existing
   * caller uses. Kept, and kept atomic: counting and posting at the dock in one
   * action is a real workflow, not a legacy shortcut, and splitting it into two
   * HTTP calls would leave a half-finished document on every scanner that loses
   * signal mid-shift. The draft and the post share one claim, so the whole
   * delivery — document, PO arithmetic, movements, events, journal — is claimed
   * once and a retry replays the same GRN id.
   */
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

  listGrns(orgId: string, userId: string, filters: ListGrnInput) {
    return this.reads.listGrns(orgId, userId, filters);
  }

  getGrn(orgId: string, grnId: number, userId: string) {
    return this.reads.getGrn(orgId, grnId, userId);
  }

  /**
   * One conditional UPDATE, and the affected-row count is the answer. Reading
   * the status and then writing is a race: two clerks who both read COUNTING
   * both pass. The `inArray` predicate is the check.
   */
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

  /** The document and its lines, on a transaction the caller owns. */
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

  /**
   * The lines, with the unit conversion resolved and snapshotted.
   * `inv_grn_lines` has carried `uom_id`, `quantity_entered` and `uom_factor`
   * since INV-106 and receiving wrote none of them, so a delivery counted in
   * cases reached the ledger as that many single units. The factor is resolved
   * server-side and stored: looked up at read time instead, a later correction
   * to a case size would rewrite what every historical receipt meant.
   */
  private async insertLines(
    tx: Tx,
    orgId: string,
    grnId: number,
    po: ReceivablePo,
    lines: readonly GrnDraftLine[],
  ): Promise<void> {
    // One receipt line per order line. Two lines against the same order line
    // each measure "remaining" against the same pre-post total, so a 100-unit
    // order accepts two 60-unit lines and posts 120 through a tolerance gate
    // that refused 101.
    const seen = new Set<number>();
    for (const line of lines) {
      if (seen.has(line.poLineId))
        throw new BadRequestException(`PO line ${line.poLineId} appears twice on this receipt`);
      seen.add(line.poLineId);

      const poLine = po.lines.find((l) => l.id === line.poLineId);
      if (!poLine) throw new BadRequestException(`PO line ${line.poLineId} not found`);
      if (line.qualityStatus === "REJECTED" && !line.rejectionReason)
        throw new BadRequestException(`Line ${line.poLineId}: a rejected line needs a reason`);

      // E4. Checked before the conversion, deliberately: converting first turns
      // a rejected 2.9955 kg into an accepted 2995.5 g and hides the refusal
      // behind a unit change. The conversion below is unchanged — it is what
      // already stops a delivery counted in cases reaching the ledger as that
      // many singles — and this only decides whether the figure was one this
      // SKU may be counted in at all.
      //
      // Called unconditionally. The service reads the kirana pack itself and
      // returns before it loads the product when it is off, so a flag check here
      // would only be a second copy of the same condition — and the copy is what
      // drifts. With the pack off this is a cached settings read and a return.
      await this.quantityCapture.assertEnteredQuantity(
        orgId,
        poLine.productVariant.id,
        line.quantityReceived,
      );

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
          lotNumber: line.lotNumber,
          expiryDate: line.expiryDate,
          manufactureDate: line.manufactureDate,
          // E3. Snapshotted on the line as given. Whether they were *required*
          // is the pharmacy pack's question and is asked at post, where the
          // whole receipt is refused as one rather than line by line.
          mrpPaise: line.mrpPaise ?? null,
          purchaseRatePaise: line.purchaseRatePaise ?? null,
        })
        .returning({ id: invGrnLines.id });
      if (!inserted) throw new ConflictException("Could not write the receipt line");

      const serials = line.serialNumbers ?? [];
      if (serials.length === 0) continue;
      // Deduplicated here as well as by `uniq_inv_grn_line_serials_line_number`,
      // because a scanner that double-triggers should get a clean 400 rather
      // than a unique-violation 500 on an otherwise valid count.
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
              with: { product: { columns: { id: true, trackingMethod: true } } },
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

  /**
   * The bin the goods land in, and the caller's right to put them there — a
   * receipt into a warehouse the clerk is not assigned to is the exact hole
   * warehouse scope exists to close.
   */
  private async resolveLocation(
    orgId: string,
    userId: string,
    warehouseId: number | null,
    requested: number | undefined,
  ): Promise<number> {
    if (requested === undefined)
      return this.poService.resolveLocationId(orgId, warehouseId);

    // Existence and activity as well as scope: `assertLocationVisible` returns
    // early for a scope-all holder, so on its own it would let that caller
    // receive into a retired bin in another organisation's id range.
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

  /** Parsed, not cast: the stored id has been through jsonb and may be a string. */
  private readonly revivedGrnId = (stored: unknown): number => {
    const id = revivedId(stored);
    if (!Number.isInteger(id))
      throw new ConflictException("The stored result for this key is unreadable");
    return id;
  };
}
