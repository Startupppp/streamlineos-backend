import { createHash } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invStockTransactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { mulDec, isPositive } from "./decimal";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { claimIdempotencyKey, extractEngineResult } from "./idempotency";
import { lockLevels, type LevelGrain } from "./stock-level-locks";
import { BooksService } from "../../accounting/kernel/books.service";
import { PeriodsService } from "../../accounting/kernel/periods.service";
import { assertStockPeriodOpen } from "./accounting-bridge";
import { loadCostingContext } from "./costing-context";
import { MovementApplyService, resolvePostingDate } from "./movement-apply.service";
import {
  INV_ERRORS,
  type StockEngineCommand,
  type StockEngineResult,
  type ReverseCommand,
} from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { addDec, mulDec, divDec } from "./decimal";

function grainsOf(cmd: StockEngineCommand): LevelGrain[] {
  return cmd.movements.map((m) => ({
    productVariantId: m.productVariantId,
    locationId: m.locationId,
    lotId: m.lotId ?? null,
    serialId: m.serialId ?? null,
    handlingUnitId: m.handlingUnitId ?? null,
    ownership: m.ownership ?? "OWNED",
  }));
}

@Injectable()
export class StockEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly cache: CacheService,
    private readonly valuation: ValuationService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly periods: PeriodsService,
    private readonly books: BooksService,
    private readonly movementApply: MovementApplyService,
  ) {}

  async executeInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    cmd: StockEngineCommand,
  ): Promise<StockEngineResult> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify(cmd))
      .digest("hex");
    const claim = await claimIdempotencyKey(
      tx,
      orgId,
      cmd.idempotencyKey,
      requestHash,
    );
    if (claim.kind === "replay") {
      return extractEngineResult(claim.stored);
    }
    // One gate covers receipts, issues, transfers, adjustments and counts —
    // every stock mutation resolves to a location.
    await this.warehouseScope.assertLocationsInScope(
      tx, orgId, userId, cmd.movements.map((m) => m.locationId),
    );

    const settings = await this.settingsService.get(orgId);
    const postingDate = resolvePostingDate(cmd);
    await this.assertPeriodOpen(orgId, postingDate);
    const costing = await loadCostingContext(
      tx,
      orgId,
      cmd.movements.map((m) => m.productVariantId),
      postingDate,
    );

    // Every grain this command touches is locked in one ordered statement before
    // any of it is read, so two concurrent commands cannot take the same rows in
    // opposite order.
    const levels = await lockLevels(tx, orgId, grainsOf(cmd));

    return this.movementApply.apply(tx, orgId, userId, cmd, {
      settings,
      costing,
      levels,
      postingDate,
    });
  }

  async execute(
    orgId: string,
    userId: string,
    cmd: StockEngineCommand,
  ): Promise<StockEngineResult> {
    const result = await this.db.transaction((tx) =>
      this.executeInTx(tx, orgId, userId, cmd),
    );
    void this.invalidateCaches(orgId);
    return result;
  }

  async reverseInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    cmd: ReverseCommand,
  ): Promise<StockEngineResult> {
    const original = await tx.query.invStockTransactions.findFirst({
      where: and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.id, cmd.stockTransactionId),
      ),
    });
    if (!original)
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
      });

    // A2. A posted movement may be corrected once. Reversing it twice unwinds it
    // twice, and the second unwind is stock that never existed — the idempotency
    // key stops a retry of the *same* request, not a second request to reverse
    // the same movement. This check is for a legible error; the partial unique
    // index on (org_id, correction_of_transaction_id) is what makes it true when
    // two reversals race, where a check on its own always loses.
    const existing = await tx
      .select({ id: invStockTransactions.id })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.correctionOfTransactionId, original.id),
        ),
      )
      .limit(1);
    if (existing.length > 0)
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
        message: `Movement ${original.id} has already been reversed by movement ${existing[0]!.id}`,
      });

    // Unwind the layer this receipt created before posting the counter-movement.
    // Left to the ordinary issue path, the reversal would consume unrelated
    // older layers and leave the erroneous layer sitting in stock.
    //
    // A2. Unwinding it is only half the job, and the missing half was a live
    // defect: the compensating movement then went down the ordinary issue path
    // and tried to consume layers *again*. Where the reversed receipt was the
    // only coverage that raised "cost layers do not cover this issue" and the
    // reversal was impossible; where older layers existed it succeeded and took
    // the same value out of inventory twice. `settledCost` says the cost side is
    // already accounted for.
    let settledCost: { unitCost: string | null; totalCost: string | null } | undefined;
    if (isPositive(original.quantityChange)) {
      const unwound = await this.valuation.reverseReceiptLayer(tx, orgId, original.id);
      if (unwound) {
        settledCost = {
          unitCost: original.unitCost,
          totalCost:
            original.totalCost ??
            (original.unitCost
              ? mulDec(original.unitCost, original.quantityChange)
              : null),
        };
      }
    }

    const reversalKey = `reversal:${cmd.idempotencyKey}`;
    return this.executeInTx(tx, orgId, userId, {
      idempotencyKey: reversalKey,
      sourceType: "reversal",
      sourceId: String(cmd.stockTransactionId),
      reason: cmd.reason,
      postingDate: original.postingDate ?? undefined,
      movements: [
        {
          transactionType: original.transactionType,
          productVariantId: original.productVariantId,
          locationId: original.locationId!,
          lotId: original.lotId ?? undefined,
          serialId: original.serialId ?? undefined,
          quantityDelta: mulDec(original.quantityChange, "-1"),
          unitCost: original.unitCost ?? undefined,
          qualityBucket: original.quantityBucket,
          correctionOfTransactionId: original.id,
          ...(settledCost ? { settledCost } : {}),
        },
      ],
    });
  }

  async reverse(
    orgId: string,
    userId: string,
    cmd: ReverseCommand,
  ): Promise<StockEngineResult> {
    const r = await this.db.transaction((tx) =>
      this.reverseInTx(tx, orgId, userId, cmd),
    );
    void this.invalidateCaches(orgId);
    return r;
  }

  async invalidateCaches(orgId: string): Promise<void> {
    await Promise.allSettled([
      this.cache.invalidateNamespace(`inv:stock:levels:${orgId}`),
      this.cache.invalidateNamespace(`inv:traceability:${orgId}`),
      this.cache.invalidate(CACHE_KEYS.invDashboard(orgId)),
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
      this.cache.invalidate(CACHE_KEYS.invLowStock(orgId)),
      this.cache.invalidate(CACHE_KEYS.invReorderReport(orgId)),
    ]);
  }

  /**
   * A movement may not be posted into a locked accounting period — backdated
   * stock would otherwise silently restate a reported month.
   *
   * Accounting is opt-in, so an org with no book (or a date no open fiscal year
   * covers) is simply unguarded, exactly as before: the old guard also only
   * refused when a period existed *and* was closed.
   */
  private async assertPeriodOpen(orgId: string, postingDate: string): Promise<void> {
    // The same guard the batch path reaches through InventoryAccountingBridge,
    // so a single command and a batch cannot disagree about a locked month.
    await assertStockPeriodOpen(this.books, this.periods, orgId, postingDate);
  }
}
