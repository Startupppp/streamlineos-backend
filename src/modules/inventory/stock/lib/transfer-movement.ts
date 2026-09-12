import type { Db } from "../../../../db/drizzle.module";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { StockEngineService } from "../../stock-engine/stock-engine.service";
import type { ReservationService } from "../../stock-engine/reservation.service";
import type { TransitLocationService } from "../../stock-engine/transit-location.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { StockMovementBridgeService } from "../../../accounting/adapters/stock-movement-bridge.service";

/**
 * The dependency bag the two transfer movement commands take — `transfer-dispatch.ts`
 * and `transfer-complete.ts`, which import it from here so neither depends on the
 * other.
 *
 * A bag passed to functions rather than a second `@Injectable`, which is the
 * shape `so-ship.ts` established in this module and for its stated reason: the DI
 * graph and every caller stay unchanged, and the transaction stays owned by the
 * service that opens it. A service with its own `db` handle would be an
 * invitation to forget that these may only run inside one.
 */
export interface TransferDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly engine: StockEngineService;
  readonly reservationService: ReservationService;
  readonly transitLocations: TransitLocationService;
  readonly warehouseScope: WarehouseScopeService;
  /** ACC-21. Completion posts the transfer's net value change to the general ledger. */
  readonly glBridge: StockMovementBridgeService;
}

  // B1-06: engine.executeInTx + reservation consumption + status update in one transaction.
  // invalidateCaches (stock levels + reservations list) called after the outer tx commits.
  //
  // A2. Two movements per line, not one. TRANSFER_OUT empties the source bin and
  // TRANSFER_IN fills the source warehouse's transit location in the same engine
  // command, so org-wide on-hand -- and the valuation that follows it -- is
  // unchanged by a dispatch. Before this the goods were on no stock level at all
  // between dispatch and completion: total on-hand silently dropped for the
  // duration of the journey and nothing told a planner where the units were.
