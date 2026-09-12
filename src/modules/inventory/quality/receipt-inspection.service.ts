import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invQualityInspections,
  invQualityInspectionLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { addDec, isPositive } from "../stock-engine/decimal";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import { resolveInspectionPlans } from "./inspection-plan-resolver";
import { resolveSampleQuantity } from "./inspection-plan-sampling";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One (variant, location, lot, serial) grain the receipt actually landed. */
interface ReceivedGrain {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
}

/** An alias rather than an interface: `tx.execute<T>` constrains `T` to
 *  `Record<string, unknown>`, which only an alias satisfies implicitly. */
type ReceivedGrainRow = {
  product_variant_id: number;
  location_id: number;
  lot_id: number | null;
  serial_id: number | null;
  quantity: string;
};

export interface RaiseReceiptInspectionInput {
  grnId: number;
  grnNumber: string;
  /** The receipt's own claim; every derived key hangs off it. */
  idempotencyKey: string;
}

export interface RaisedReceiptInspection {
  inspectionId: number;
  lineCount: number;
  heldQuantity: string;
}

/**
 * D3 — an arrival that has to be inspected is not available to promise.
 *
 * B1 gave the receipt a lifecycle and stopped exactly here: `inspectionOnReceipt`
 * raised a line-less PENDING inspection at post and the goods went straight into
 * available stock, so "this delivery has not been checked yet" was a note in a
 * table nobody's allocator read. Sales could and did promise units nobody had
 * opened.
 *
 * **How the quantity becomes unavailable.** Through the one mechanism the
 * architecture already has, and no second one: a `QUARANTINE_IN` movement into
 * the `QUALITY_HOLD` bucket at the grain the receipt landed. `availableQty` and
 * `availableQtySql` subtract `quality_hold_qty` from `on_hand`, so the received
 * units are on the shelf — a stock count still finds them, valuation still owns
 * them — and are not for sale. Nothing is invented, nothing is double-counted:
 * the bucket is a *subset* of on-hand, and `assertBucketsCoherent` refuses a hold
 * that exceeds it.
 *
 * **Why it reads the ledger rather than the receipt lines.** The grain a receipt
 * lands at is decided during posting: a lot number becomes a lot id, a list of
 * scanned serials becomes one movement per serial, and a refused line lands
 * nothing at all. Re-deriving that from `inv_grn_lines` would be a second
 * implementation of the posting rules, and the first one to drift would be this
 * one. The stock transactions the post has just written, inside the same
 * transaction, *are* the answer.
 *
 * **Why no `inv_quality_holds` row.** The inspection is the hold document here.
 * Two documents over one quantity have to be released in lockstep, and releasing
 * one leaves the other ACTIVE against stock that is no longer held — the exact
 * defect A3 found on `HoldsService.create`. `held_quantity` on the inspection
 * line is what the release posts against, so the figure released is the figure
 * raised rather than a re-reading of the level.
 *
 * **Idempotency.** This runs inside the receipt's own `runIdempotent` claim, so
 * a retried post replays the stored GRN id and never re-enters. The engine call
 * takes a derived key because claiming the same key twice in one transaction is
 * a duplicate, not a nesting.
 */
@Injectable()
export class ReceiptInspectionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly settingsService: InventorySettingsService,
  ) {}

  /**
   * Raises the inspection a posted receipt owes, and quarantines what it covers.
   *
   * Returns `null` when nothing on the delivery needs inspecting, which is the
   * common case and must stay free: no document, no movement, no event.
   *
   * Called with the transaction the post is running in — the hold and the
   * receipt commit together or not at all. A hold posted after the receipt's
   * commit is a window in which the goods are for sale.
   */
  async raiseForReceiptInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    input: RaiseReceiptInspectionInput,
  ): Promise<RaisedReceiptInspection | null> {
    const grains = await this.receivedGrains(tx, orgId, input.grnId);
    if (grains.length === 0) return null;

    const settings = await this.settingsService.get(orgId);
    const plans = await resolveInspectionPlans(
      tx,
      orgId,
      grains.map((grain) => grain.productVariantId),
      "RECEIPT",
    );

    // The organisation-wide switch is the fallback, not a competitor: a plan
    // covering the SKU decides the sample size, and `inspectionOnReceipt` means
    // "everything else gets looked at too, in full".
    const covered = grains.filter(
      (grain) => plans.has(grain.productVariantId) || settings.inspectionOnReceipt,
    );
    if (covered.length === 0) return null;

    const inspectionNumber = await this.numSeq.next(orgId, "INSPECTION", tx);
    const [inspection] = await tx
      .insert(invQualityInspections)
      .values({
        orgId,
        inspectionNumber,
        sourceType: "inv_grn",
        sourceId: String(input.grnId),
        status: "PENDING",
        notes: `Raised on receipt ${input.grnNumber}`,
        createdBy: userId,
      })
      .returning({ id: invQualityInspections.id });
    if (!inspection) throw new ConflictException("Could not raise the receipt inspection");

    const movements: StockMovement[] = [];
    let heldTotal = "0.0000";
    const lines = covered.map((grain) => {
      const plan = plans.get(grain.productVariantId);
      const sampleQuantity = plan
        ? resolveSampleQuantity(plan.samplingMethod, plan.sampleValue, grain.quantity)
        : grain.quantity;
      heldTotal = addDec(heldTotal, grain.quantity);
      movements.push({
        transactionType: "QUARANTINE_IN",
        productVariantId: grain.productVariantId,
        locationId: grain.locationId,
        lotId: grain.lotId ?? undefined,
        serialId: grain.serialId ?? undefined,
        quantityDelta: grain.quantity,
        qualityBucket: "QUALITY_HOLD",
      });
      return {
        orgId,
        inspectionId: inspection.id,
        productVariantId: grain.productVariantId,
        locationId: grain.locationId,
        lotId: grain.lotId,
        serialId: grain.serialId,
        quantity: grain.quantity,
        // The whole delivered quantity is held whatever the sample says: a
        // sample that fails condemns the batch it was drawn from, not only the
        // units that were opened.
        heldQuantity: grain.quantity,
        sampleQuantity,
        planVersionId: plan?.planVersionId ?? null,
      };
    });

    await tx.insert(invQualityInspectionLines).values(lines);

    await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${input.idempotencyKey}:qhold`,
      sourceType: "INSPECTION_RECEIPT_HOLD",
      sourceId: String(inspection.id),
      reason: `Awaiting inspection: ${inspectionNumber}`,
      movements,
    });

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "quality_inspection.raised_on_receipt",
      resourceType: "inspection",
      resourceId: String(inspection.id),
      after: {
        grnId: input.grnId,
        inspectionNumber,
        lineCount: lines.length,
        heldQuantity: heldTotal,
        planned: [...new Set([...plans.values()].map((plan) => plan.planCode))],
      },
    });

    return { inspectionId: inspection.id, lineCount: lines.length, heldQuantity: heldTotal };
  }

  /**
   * The caches a raised inspection invalidates. Separate from the work because
   * the caller owns the commit, and invalidating before it lets a reader repopulate
   * the cache from the pre-commit state (the same reason `invalidateAfterPost`
   * is public on the posting service).
   */
  /**
   * The number of an inspection still holding this receipt's goods, or null.
   *
   * Asked by the receipt-reversal path. The hold is a subset of `on_hand` at
   * the grain, so reversing the receipt under an open inspection drives on-hand
   * below it and the engine refuses — correctly, but with a message about
   * buckets that tells an operator nothing. Quality owns the question, so
   * Quality answers it.
   */
  async openInspectionFor(orgId: string, grnId: number): Promise<string | null> {
    const [row] = await this.db
      .select({ inspectionNumber: invQualityInspections.inspectionNumber })
      .from(invQualityInspections)
      .where(
        and(
          eq(invQualityInspections.orgId, orgId),
          eq(invQualityInspections.sourceType, "inv_grn"),
          eq(invQualityInspections.sourceId, String(grnId)),
          inArray(invQualityInspections.status, ["PENDING", "IN_PROGRESS"]),
        ),
      )
      .limit(1);
    return row?.inspectionNumber ?? null;
  }

  async invalidateAfterRaise(orgId: string): Promise<void> {
    await Promise.all([
      this.engine.invalidateCaches(orgId),
      this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId)),
    ]);
  }

  /**
   * What the receipt actually put on the shelf, at the engine's own grain.
   *
   * Only positive `ON_HAND` rows: a bucket movement is not an arrival, and a
   * negative one is a reversal. Summed per grain because a serial-tracked line
   * writes one row per unit and a lot line may appear more than once.
   */
  private async receivedGrains(tx: Tx, orgId: string, grnId: number): Promise<ReceivedGrain[]> {
    const rows = await tx.execute<ReceivedGrainRow>(sql`
      SELECT product_variant_id,
             location_id,
             lot_id,
             serial_id,
             SUM(quantity_change)::text AS quantity
        FROM inv_stock_transactions
       WHERE org_id = ${orgId}
         AND reference_type = 'inv_grn'
         AND reference_id = ${String(grnId)}
         AND quantity_bucket = 'ON_HAND'
         AND quantity_change > 0
         AND location_id IS NOT NULL
       GROUP BY product_variant_id, location_id, lot_id, serial_id
    `);
    return rows
      .map((row) => ({
        productVariantId: Number(row.product_variant_id),
        locationId: Number(row.location_id),
        lotId: row.lot_id === null ? null : Number(row.lot_id),
        serialId: row.serial_id === null ? null : Number(row.serial_id),
        quantity: String(row.quantity),
      }))
      .filter((grain) => isPositive(grain.quantity));
  }
}
