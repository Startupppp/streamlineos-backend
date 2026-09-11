import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "./inventory-settings.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { claimIdempotencyKey, extractEngineResult } from "./idempotency";
import { loadCostingContext } from "./costing-context";
import { InventoryAccountingBridge } from "./accounting-bridge";
import { lockLevels, lockCapacityLocations, type LevelGrain } from "./stock-level-locks";
import { MovementApplyService, resolvePostingDate } from "./movement-apply.service";
import {
  type StockEngineCommand,
  type StockEngineResult,
} from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
export class StockEngineBatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly periods: InventoryAccountingBridge,
    private readonly movementApply: MovementApplyService,
  ) {}

  async executeMany(
    orgId: string,
    userId: string,
    commands: StockEngineCommand[],
  ): Promise<StockEngineResult[]> {
    if (commands.length === 0) return [];

    const batchResults = await this.db.transaction((tx) =>
      this.executeManyInTx(tx, orgId, userId, commands),
    );

    void this.invalidateCaches(orgId);
    return batchResults;
  }

  async executeManyInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    commands: StockEngineCommand[],
  ): Promise<StockEngineResult[]> {
    if (commands.length === 0) return [];

    const requestHashes = commands.map((cmd) =>
      createHash("sha256").update(JSON.stringify(cmd)).digest("hex"),
    );

    const claims: Array<
      { kind: "proceed" } | { kind: "replay"; stored: unknown }
    > = [];
    for (let i = 0; i < commands.length; i++) {
      claims.push(
        await claimIdempotencyKey(
          tx,
          orgId,
          commands[i].idempotencyKey,
          requestHashes[i],
        ),
      );
    }

    const results: Array<StockEngineResult | undefined> = new Array(commands.length);
    const active: Array<{ index: number; cmd: StockEngineCommand; postingDate: string }> = [];
    for (let i = 0; i < commands.length; i++) {
      const claim = claims[i];
      const cmd = commands[i];
      if (claim.kind === "replay") {
        results[i] = extractEngineResult(claim.stored);
      } else {
        active.push({ index: i, cmd, postingDate: resolvePostingDate(cmd) });
      }
    }

    if (active.length === 0) {
      return results.map((result) => {
        if (!result) throw new Error("Missing batch stock engine result");
        return result;
      });
    }

    await this.warehouseScope.assertLocationsInScope(
      tx, orgId, userId,
      active.flatMap(({ cmd }) => cmd.movements.map((m) => m.locationId)),
    );

    const settings = await this.settingsService.get(orgId);
    const costingByDate = new Map<string, Awaited<ReturnType<typeof loadCostingContext>>>();
    for (const postingDate of new Set(active.map((entry) => entry.postingDate))) {
      await this.periods.assertOpen(orgId, postingDate);
      costingByDate.set(
        postingDate,
        await loadCostingContext(
          tx,
          orgId,
          active
            .filter((entry) => entry.postingDate === postingDate)
            .flatMap(({ cmd }) => cmd.movements.map((m) => m.productVariantId)),
          postingDate,
        ),
      );
    }

    const levels = await lockLevels(
      tx,
      orgId,
      active.flatMap(({ cmd }) => grainsOf(cmd)),
    );

    // INV-10. `apply` locks the capped bins its own command raises, which is
    // enough for a single command but not for a batch: command 1 would take bin
    // X and command 2 bin Y, while a concurrent batch took them in the other
    // order, and the pair deadlocks instead of queueing. Taking every capped bin
    // the whole batch raises in one id-ordered statement — the same discipline
    // `lockLevels` applies to grains — makes each command's own lock a re-take
    // of something already held.
    await lockCapacityLocations(
      tx,
      orgId,
      active.flatMap(({ cmd }) =>
        MovementApplyService.raisedLocations(cmd.movements),
      ),
    );

    for (const { index, cmd, postingDate } of active) {
      const costing = costingByDate.get(postingDate);
      if (!costing) throw new Error(`Missing costing context for posting date ${postingDate}`);
      results[index] = await this.movementApply.apply(tx, orgId, userId, cmd, {
        settings,
        costing,
        levels,
        postingDate,
      });
    }

    return results.map((result) => {
      if (!result) throw new Error("Missing batch stock engine result");
      return result;
    });
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
}
